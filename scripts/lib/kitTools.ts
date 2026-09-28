// ─────────────────────────────────────────────────────────────────────────────
// Recovery tools built FROM THE STORED RECOVERY KIT, for the monthly manual drill (drill-object.ts).
//
// The kit (recovery-kit.ts) is only worth what the last recovery that actually used it proves. So
// the manual drill does not use whatever age and pg_restore happen to be installed on the laptop:
// it downloads a kit from the bucket, checks every byte against the kit's SHA256SUMS, runs the kit's
// own build-tools.sh, and puts the result first on PATH. A drill that passes has then proved the
// escrowed identity AND the stored kit's tools against a real object.
//
// Building PostgreSQL takes minutes, so the tools are cached per kit id; a kit id names exact bytes,
// so a cache hit can never be a different kit. Cache: $GITFATHER_KIT_CACHE, else
// ~/.cache/the-gitfather/kit-tools/<kit-id>/.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./proc.js";
import {
  KIT_PREFIX,
  SUMS_FILE,
  describeDiff,
  diffIsClean,
  diffSums,
  kitIdsIn,
  parseSums,
  sha256,
  staleAgainst,
  type Manifest,
  type SumsDiff,
} from "./recoveryKit.js";
import type { Store } from "./store.js";

export interface KitTools {
  kitId: string;
  binDir: string;
}

/** The tools every drill needs, all of which build-tools.sh installs. */
export const KIT_BINARIES = ["age", "pg_restore", "psql"] as const;

const BUILT_MARKER = ".built";

export function kitCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.GITFATHER_KIT_CACHE || join(homedir(), ".cache", "the-gitfather", "kit-tools");
}

/**
 * The kit to drill with: the one asked for, else the newest COMPLETE one (ids start with their build
 * date, so they sort by age). A kit with no SHA256SUMS is an upload that never finished.
 */
export async function chooseKit(store: Store, wanted?: string): Promise<string> {
  const ids = kitIdsIn(await store.list(KIT_PREFIX));
  if (wanted) {
    if (!ids.includes(wanted)) throw new Error(`no kit ${wanted} under ${KIT_PREFIX}/ (stored: ${ids.join(", ") || "none"})`);
    return wanted;
  }
  for (const id of [...ids].reverse()) if (await store.exists(`${KIT_PREFIX}/${id}/${SUMS_FILE}`)) return id;
  throw new Error(
    `no complete recovery kit is stored under ${KIT_PREFIX}/ — the drill runs on the kit's tools, so store one first: ` +
      "npm run recovery-kit -- build, then upload (docs/key-escrow.md#the-recovery-kit)",
  );
}

/**
 * Download a stored kit into `dir` and hash every byte. `sums` is null when the kit has no
 * SHA256SUMS (an upload that never finished); otherwise `diff` says what, if anything, is wrong.
 */
export async function fetchKit(store: Store, id: string, dir: string): Promise<{ sums: Map<string, string> | null; diff: SumsDiff }> {
  const base = `${KIT_PREFIX}/${id}`;
  const sumsText = await store.cat(`${base}/${SUMS_FILE}`);
  if (sumsText === null) return { sums: null, diff: { missing: [SUMS_FILE], extra: [], mismatched: [] } };
  const sums = parseSums(sumsText);
  const actual = new Map<string, string>();
  for (const key of await store.list(base)) {
    const p = key.slice(base.length + 1);
    if (p === SUMS_FILE) continue;
    const local = join(dir, ...p.split("/"));
    await store.fetchToFile(key, local);
    actual.set(p, sha256(readFileSync(local)));
  }
  return { sums, diff: diffSums(sums, actual) };
}

/** Tools for `id`, from the cache or freshly built from the stored kit. */
export async function prepareKitTools(store: Store, manifest: Manifest, wanted?: string): Promise<KitTools> {
  const kitId = await chooseKit(store, wanted);
  const root = join(kitCacheRoot(), kitId);
  const tools = join(root, "tools");
  const binDir = join(tools, "bin");
  if (existsSync(join(root, BUILT_MARKER)) && KIT_BINARIES.every((b) => existsSync(join(binDir, b)))) {
    console.log(`Recovery kit ${kitId}: using its tools, built earlier in ${binDir}`);
    return { kitId, binDir };
  }

  rmSync(root, { recursive: true, force: true });
  const kitDir = join(root, "kit");
  mkdirSync(kitDir, { recursive: true });
  console.log(`Recovery kit ${kitId}: downloading and checking it…`);
  const { sums, diff } = await fetchKit(store, kitId, kitDir);
  if (!sums || !diffIsClean(diff)) throw new Error(`the stored kit ${kitId} is DAMAGED:\n${describeDiff(diff)}`);
  const stale = staleAgainst(manifest, sums);
  if (stale.length) {
    console.log(`  note: this kit predates the manifest (${stale.join(", ")}) — build and upload a current one`);
  }
  console.log("  building its tools (a few minutes, once per kit)…");
  const code = await run("bash", [join(kitDir, "build-tools.sh"), tools]);
  if (code !== 0) throw new Error(`the kit's build-tools.sh failed (exit ${code}) — the stored kit cannot build its own tools`);
  const missing = KIT_BINARIES.filter((b) => !existsSync(join(binDir, b)));
  if (missing.length) throw new Error(`build-tools.sh finished but ${missing.join(", ")} is missing from ${binDir}`);
  // The kit and the build tree are ~1 GB between them; only bin/, lib/ and share/ are needed again.
  rmSync(kitDir, { recursive: true, force: true });
  rmSync(join(tools, "src"), { recursive: true, force: true });
  writeFileSync(join(root, BUILT_MARKER), `${new Date().toISOString()}\n`);
  return { kitId, binDir };
}
