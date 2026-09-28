// ─────────────────────────────────────────────────────────────────────────────
// The RECOVERY KIT — everything a stranger needs to open the backups years from now, stored beside
// them. See docs/key-escrow.md#the-recovery-kit.
//
// Escrowing the keys (key-shares.ts) is only half of recovery: the cards are useless without the code
// that reads them, age, zstd and pg_restore, and in ten years none of those can be assumed to be one
// `pip install` or `brew install` away. So recovery-kit/manifest.yaml pins each artifact by version and
// SHA-256, and this assembles them, with a "start here" README, into a kit that needs no network.
//
//   build    fetch every artifact, refuse any whose bytes differ from the manifest, and write the kit
//            directory (plus a .tar of it, for a USB copy):
//              npm run recovery-kit -- build [--out <dir>]
//   upload   check a built kit against its own SHA256SUMS and the manifest, then store it under
//            recovery-kit/<date>-<digest>/ in the backup bucket, SHA256SUMS last (a kit without one
//            is incomplete). A kit whose digest is already stored is not stored twice.
//              npm run recovery-kit -- upload --kit <dir> [--target r2|local:<dir>]
//   verify   re-download every stored kit and re-hash it against its SHA256SUMS; also say whether
//            each is current against the manifest. Exits 1 if any kit is damaged, or none is stored.
//              npm run recovery-kit -- verify [--kit-id <id>] [--target r2|local:<dir>]
//
// The R2 target reads R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (the CI
// token's scope is enough: read and write, no delete). The kit's lock is set once, by hand, with
// account-level credentials: docs/r2-setup.md#the-recovery-kit-prefix.
//
// That the kit is COMPLETE is proved separately, by `npm run key-shares -- drill --kit <dir>`: a
// whole recovery in a container with no network and nothing but the kit.
// ─────────────────────────────────────────────────────────────────────────────

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { fetchKit } from "./lib/kitTools.js";
import { run } from "./lib/proc.js";
import {
  GENERATED_FILES,
  KIT_PREFIX,
  ManifestSchema,
  SUMS_FILE,
  checkArtifact,
  describeDiff,
  diffIsClean,
  diffSums,
  kitDigest,
  kitId,
  kitIdsIn,
  parseSums,
  renderReadme,
  renderSums,
  sha256,
  staleAgainst,
  type Manifest,
} from "./lib/recoveryKit.js";
import { makeStore, parseTarget, type Store } from "./lib/store.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = join(REPO, "recovery-kit", "manifest.yaml");
const RUNBOOK_PATH = join(REPO, "docs", "key-escrow.md");

export type Command =
  | { cmd: "build"; out?: string }
  | { cmd: "upload"; kit: string; target?: string }
  | { cmd: "verify"; kitId?: string; target?: string };

const FLAGS = ["--out", "--kit", "--kit-id", "--target"];

/** Pure, and exported so the argument grammar is testable without a network or a bucket. */
export function parseArgs(argv: string[]): Command {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!FLAGS.includes(a)) throw new Error(`unknown argument ${a}`);
    const v = rest[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    flags[a.slice(2)] = v;
  }
  const only = (allowed: string[]) => {
    const extra = Object.keys(flags).filter((k) => !allowed.includes(k));
    if (extra.length) throw new Error(`${cmd} does not take --${extra.join(", --")}`);
  };
  switch (cmd) {
    case "build":
      only(["out"]);
      return { cmd, out: flags.out };
    case "upload":
      only(["kit", "target"]);
      if (!flags.kit) throw new Error("upload needs --kit <dir> (the directory `build` wrote)");
      return { cmd, kit: flags.kit, target: flags.target };
    case "verify":
      only(["kit-id", "target"]);
      return { cmd, kitId: flags["kit-id"], target: flags.target };
    default:
      throw new Error("usage: recovery-kit build [--out <dir>] | upload --kit <dir> [--target r2|local:<dir>] | verify [--kit-id <id>] [--target r2|local:<dir>]");
  }
}

export function loadManifest(path = MANIFEST_PATH): Manifest {
  return ManifestSchema.parse(parseYaml(readFileSync(path, "utf8")));
}

/** Every file under `dir`, as kit-relative paths with forward slashes. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const go = (d: string): void => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) go(full);
      else out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  go(dir);
  return out.sort();
}

function hashDir(dir: string): Map<string, string> {
  return new Map(walk(dir).map((p) => [p, sha256(readFileSync(join(dir, p)))]));
}

async function fetchArtifact(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Fetch, check and assemble. An artifact already in `out` at the pinned hash is kept, so re-running
 * into the same directory only fetches what is missing. Anything in `out` the kit does not list is an
 * error rather than something to delete: `out` might not be the directory the caller thinks it is.
 */
export async function build(
  outDir: string,
  opts: { manifestPath?: string; fetcher?: (url: string) => Promise<Uint8Array> } = {},
): Promise<{ dir: string; sums: string }> {
  const manifestPath = opts.manifestPath ?? MANIFEST_PATH;
  const fetcher = opts.fetcher ?? fetchArtifact;
  const manifest = loadManifest(manifestPath);
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  const expected = new Set([...manifest.artifacts.map((a) => a.path), ...GENERATED_FILES, SUMS_FILE]);
  const strays = walk(out).filter((p) => !expected.has(p));
  if (strays.length) throw new Error(`${out} holds files that are not part of the kit (${strays.slice(0, 3).join(", ")}…) — use an empty directory`);

  for (const a of manifest.artifacts) {
    const dest = join(out, a.path);
    if (existsSync(dest) && sha256(readFileSync(dest)) === a.sha256) {
      console.error(`  ✓ ${a.path} (already here)`);
      continue;
    }
    const bytes = await fetcher(a.url);
    checkArtifact(a, bytes);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    console.error(`  ✓ ${a.path} (${(bytes.length / 1024 / 1024).toFixed(1)} MB, ${a.version})`);
  }
  writeFileSync(join(out, "README.md"), renderReadme(manifest));
  copyFileSync(RUNBOOK_PATH, join(out, "key-escrow.md"));
  copyFileSync(join(dirname(MANIFEST_PATH), "build-tools.sh"), join(out, "build-tools.sh"));
  copyFileSync(manifestPath, join(out, "manifest.yaml"));
  rmSync(join(out, SUMS_FILE), { force: true });
  const sums = renderSums(hashDir(out));
  writeFileSync(join(out, SUMS_FILE), sums);
  return { dir: out, sums };
}

/** A local kit must match its own SHA256SUMS exactly and carry every artifact at the manifest's hash. */
export function checkLocalKit(dir: string, manifest: Manifest): string {
  const sumsPath = join(dir, SUMS_FILE);
  if (!existsSync(sumsPath)) throw new Error(`${dir} has no ${SUMS_FILE} — not a built kit`);
  const sums = readFileSync(sumsPath, "utf8");
  const actual = hashDir(dir);
  actual.delete(SUMS_FILE);
  const diff = diffSums(parseSums(sums), actual);
  if (!diffIsClean(diff)) throw new Error(`${dir} does not match its ${SUMS_FILE}:\n${describeDiff(diff)}`);
  const stale = staleAgainst(manifest, parseSums(sums));
  if (stale.length) throw new Error(`${dir} was built from a different manifest (${stale.join(", ")}) — rebuild it`);
  return sums;
}

export async function upload(store: Store, dir: string, manifest: Manifest, now = new Date()): Promise<string> {
  const sums = checkLocalKit(dir, manifest);
  const digest = kitDigest(sums);
  const stored = kitIdsIn(await store.list(KIT_PREFIX));
  const same = stored.find((id) => id.endsWith(`-${digest}`));
  if (same && (await store.exists(`${KIT_PREFIX}/${same}/${SUMS_FILE}`))) {
    console.error(`✓ this kit is already stored as ${KIT_PREFIX}/${same}/ — nothing to upload`);
    return same;
  }
  // An earlier upload of this kit that was cut short is resumed, not duplicated. Each object went up
  // as one PUT, so one that exists is whole — and verify re-hashes everything afterwards regardless.
  const id = same ?? kitId(sums, now);
  for (const p of [...parseSums(sums).keys()]) {
    const key = `${KIT_PREFIX}/${id}/${p}`;
    if (same && (await store.exists(key))) continue;
    await store.put(join(dir, p), key);
    console.error(`  ↑ ${p}`);
  }
  // Last, so a kit interrupted mid-upload has no SHA256SUMS and verify calls it incomplete.
  await store.put(join(dir, SUMS_FILE), `${KIT_PREFIX}/${id}/${SUMS_FILE}`);
  console.error(`✓ stored ${KIT_PREFIX}/${id}/ on ${store.describe}`);
  return id;
}

export interface KitReport {
  id: string;
  ok: boolean;
  current: boolean;
  problems: string;
}

/** Re-download a stored kit and re-hash every byte against its SHA256SUMS. */
export async function verifyStored(store: Store, id: string, manifest: Manifest): Promise<KitReport> {
  const scratch = mkdtempSync(join(tmpdir(), "recovery-kit-verify-"));
  try {
    const { sums, diff } = await fetchKit(store, id, scratch);
    if (!sums) return { id, ok: false, current: false, problems: `no ${SUMS_FILE}: the upload never finished` };
    const stale = staleAgainst(manifest, sums);
    return {
      id,
      ok: diffIsClean(diff),
      current: stale.length === 0,
      problems: [describeDiff(diff), stale.length ? `older than the manifest: ${stale.join(", ")}` : ""].filter(Boolean).join("\n"),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function storeFor(target: string | undefined): Store {
  const t = parseTarget(target);
  if (t.kind === "r2") {
    const missing = ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].filter((v) => !process.env[v]);
    if (missing.length) throw new Error(`the R2 target needs ${missing.join(", ")}`);
    process.env.RCLONE_CONFIG_R2_TYPE = "s3";
    process.env.RCLONE_CONFIG_R2_PROVIDER = "Cloudflare";
    process.env.RCLONE_CONFIG_R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
    process.env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
    process.env.RCLONE_CONFIG_R2_ENDPOINT = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  }
  return makeStore(t, process.env.R2_BUCKET);
}

async function verifyCmd(store: Store, manifest: Manifest, only?: string): Promise<boolean> {
  const ids = only ? [only] : kitIdsIn(await store.list(KIT_PREFIX));
  if (!ids.length) {
    console.error(`✕ no kit is stored under ${KIT_PREFIX}/ on ${store.describe} — run build, then upload`);
    return false;
  }
  let allOk = true;
  for (const id of ids) {
    const r = await verifyStored(store, id, manifest);
    allOk &&= r.ok;
    console.error(`${r.ok ? "✓" : "✕"} ${KIT_PREFIX}/${id}/: ${r.ok ? "every file matches its SHA256SUMS" : "DAMAGED"}${r.current ? " (current)" : ""}`);
    if (r.problems) console.error(r.problems.replace(/^/gm, "    "));
  }
  return allOk;
}

async function main(): Promise<void> {
  const c = parseArgs(process.argv.slice(2));
  const manifest = loadManifest();
  if (c.cmd === "build") {
    const out = c.out ?? mkdtempSync(join(tmpdir(), "recovery-kit-"));
    const { dir, sums } = await build(out);
    const tar = `${dir}.tar`;
    // Plain tar, uncompressed: nearly everything inside is compressed already, and it is the format
    // most likely to still open in twenty years.
    const code = await run("tar", ["-cf", tar, "-C", dirname(dir), basename(dir)]);
    if (code !== 0) throw new Error(`tar exited ${code}`);
    console.error(`\n✓ kit ${kitDigest(sums)} in ${dir}\n  and as one file (for a USB copy): ${tar}`);
    console.error(`  prove it complete: npm run key-shares -- drill --kit ${dir}`);
  } else if (c.cmd === "upload") {
    const store = storeFor(c.target);
    const id = await upload(store, resolve(c.kit), manifest);
    if (!(await verifyCmd(store, manifest, id))) process.exit(1);
  } else {
    if (!(await verifyCmd(storeFor(c.target), manifest, c.kitId))) process.exit(1);
  }
}

/** Only run when invoked directly — importing this module for tests must not fetch anything. */
function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((e) => {
    process.stderr.write(`ERROR: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
