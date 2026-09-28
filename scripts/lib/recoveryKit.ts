// ─────────────────────────────────────────────────────────────────────────────
// The RECOVERY KIT's pure half: the manifest, checksums, the kit's identity and its "start here"
// README. No network, no store — recovery-kit.ts does the fetching and uploading around these.
//
// A kit is a directory: every manifest artifact at its `path`, plus the files the build writes itself
// (README.md, the runbook, a copy of the manifest) and SHA256SUMS over all of it, in the format
// `shasum -a 256 -c` and `sha256sum -c` read — so a stranger can check the kit with no tool of ours.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { z } from "zod";

/** The bucket prefix every kit is stored under: recovery-kit/<kit-id>/<path>. */
export const KIT_PREFIX = "recovery-kit";

export const SUMS_FILE = "SHA256SUMS";

/** Files the build writes itself; no artifact may claim these paths. SHA256SUMS is written (and uploaded) last. */
export const GENERATED_FILES = ["README.md", "build-tools.sh", "key-escrow.md", "manifest.yaml"] as const;

const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export const ArtifactSchema = z.object({
  path: z.string().regex(SAFE_PATH, "a relative path of plain segments (no .., no leading /)"),
  name: z.string().min(1),
  version: z.string().min(1),
  url: z.string().url().startsWith("https://", "must be https"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "64 lowercase hex digits"),
  /** Where the recorded sha256 came from — so the next bump knows what to check it against. */
  checksum: z.string().min(1),
});

export const ManifestSchema = z
  .object({ artifacts: z.array(ArtifactSchema).min(1) })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    const reserved = new Set<string>([...GENERATED_FILES, SUMS_FILE]);
    for (const [i, a] of m.artifacts.entries()) {
      if (seen.has(a.path)) ctx.addIssue({ code: "custom", path: ["artifacts", i, "path"], message: `duplicate path ${a.path}` });
      if (reserved.has(a.path)) ctx.addIssue({ code: "custom", path: ["artifacts", i, "path"], message: `${a.path} is written by the build` });
      seen.add(a.path);
    }
  });

export type Artifact = z.infer<typeof ArtifactSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Throws unless `bytes` are exactly the artifact the manifest pins. */
export function checkArtifact(a: Artifact, bytes: Uint8Array): void {
  const got = sha256(bytes);
  if (got !== a.sha256) {
    throw new Error(`${a.path}: SHA-256 is ${got}, the manifest pins ${a.sha256} — refusing it (${a.url})`);
  }
}

/** `<hash>  <path>` per line, sorted by path: what `shasum -a 256 -c` expects. */
export function renderSums(sums: Map<string, string>): string {
  return [...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, hash]) => `${hash}  ${path}\n`)
    .join("");
}

export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error(`${SUMS_FILE} line ${i + 1} is not "<sha256>  <path>": ${line}`);
    if (out.has(m[2])) throw new Error(`${SUMS_FILE} lists ${m[2]} twice`);
    out.set(m[2], m[1]);
  }
  return out;
}

export interface SumsDiff {
  missing: string[];
  extra: string[];
  mismatched: string[];
}

/** What `actual` (hashes of what is really there) gets wrong against `expected`. */
export function diffSums(expected: Map<string, string>, actual: Map<string, string>): SumsDiff {
  return {
    missing: [...expected.keys()].filter((p) => !actual.has(p)).sort(),
    extra: [...actual.keys()].filter((p) => !expected.has(p)).sort(),
    mismatched: [...expected.keys()].filter((p) => actual.has(p) && actual.get(p) !== expected.get(p)).sort(),
  };
}

export function diffIsClean(d: SumsDiff): boolean {
  return !d.missing.length && !d.extra.length && !d.mismatched.length;
}

export function describeDiff(d: SumsDiff): string {
  return [
    ...d.missing.map((p) => `missing: ${p}`),
    ...d.extra.map((p) => `not in ${SUMS_FILE}: ${p}`),
    ...d.mismatched.map((p) => `wrong bytes: ${p}`),
  ].join("\n");
}

/**
 * Artifacts in the manifest that a kit's SHA256SUMS does not carry at the pinned hash. Empty means
 * the kit is current; anything else means it was built from an older (or different) manifest.
 */
export function staleAgainst(manifest: Manifest, sums: Map<string, string>): string[] {
  return manifest.artifacts.filter((a) => sums.get(a.path) !== a.sha256).map((a) => a.path);
}

/**
 * A kit's id: its build date plus a digest of its SHA256SUMS. Two builds from the same manifest and
 * docs have the same digest, which is how `upload` knows a kit is already stored under another date.
 */
export function kitId(sumsText: string, date: Date): string {
  return `${date.toISOString().slice(0, 10)}-${kitDigest(sumsText)}`;
}

export function kitDigest(sumsText: string): string {
  return sha256(sumsText).slice(0, 12);
}

/** Kit ids under KIT_PREFIX, from a recursive key listing. */
export function kitIdsIn(keys: string[]): string[] {
  const ids = new Set<string>();
  for (const k of keys) {
    const m = new RegExp(`^${KIT_PREFIX}/([^/]+)/`).exec(k);
    if (m) ids.add(m[1]);
  }
  return [...ids].sort();
}

/** The Postgres major the kit's source tarball builds, from its manifest path. */
export function pgMajorOf(manifest: Manifest): number {
  for (const a of manifest.artifacts) {
    const m = /(?:^|\/)postgresql-(\d+)\.\d+\.tar\.(?:gz|bz2)$/.exec(a.path);
    if (m) return Number(m[1]);
  }
  throw new Error("the manifest has no postgresql-<major>.<minor>.tar.gz — a kit without pg_restore cannot restore a dump");
}

function find(manifest: Manifest, re: RegExp): Artifact {
  const a = manifest.artifacts.find((x) => re.test(x.path));
  if (!a) throw new Error(`the manifest has no artifact matching ${re}`);
  return a;
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/**
 * The kit's "start here" page, for someone who has never heard of this repo. It walks the no-repo
 * recovery path: fetch the objects, rebuild each key from two cards, then age, zstd and pg_restore.
 * Deterministic (no build date), so the same manifest always yields the same kit digest.
 */
export function renderReadme(manifest: Manifest): string {
  const age = find(manifest, /^age\/age-v[^/]+-source\.tar\.gz$/).version;
  const zstd = find(manifest, /^zstd\/zstd-[\d.]+\.tar\.gz$/);
  const pg = find(manifest, /postgresql-[\d.]+\.tar\.gz$/);
  const zlib = find(manifest, /zlib-[\d.]+\.tar\.gz$/);
  const wheels = manifest.artifacts.filter((a) => a.path.startsWith("python/"));
  const rows = manifest.artifacts.map((a) => `| \`${a.path}\` | ${a.name} | ${a.version} |`).join("\n");
  return `# Recovery kit: start here

This kit holds everything needed to open a set of encrypted database backups, even if the
company that made them, its code repository, GitHub and the usual download sites are all gone.
You need a computer with **Python 3.10 or later**, and a **C compiler, \`make\` and Perl** to build
the rest (on macOS, \`xcode-select --install\`; on Windows, use WSL). Nothing is downloaded.

Copy the kit to a scratch directory and run the commands below from its top level, in order.
\`key-escrow.md\` is the full runbook the backups were set up with; it mentions tools that are not in
this kit, which you do not need.

## What the backups are

The backups sit in an S3-compatible bucket (Cloudflare R2), next to this kit:

- **Database dumps**: \`<prefix>/{daily,weekly,monthly,intraday}/<name>-<timestamp>.dump.age\`. Each is a
  PostgreSQL custom-format dump (\`pg_dump -Fc\`), encrypted with **age**.
- **Table archives** (if the project used them): \`<store-prefix>/<table>/<year>/…ndjson.zst.age\`. Each is
  rows as newline-delimited JSON, compressed with **zstd**, then encrypted with age.

Dumps and archives use **two different keys**. Each key is split into three sets of 33 words, printed
on three cards held by three people. **Any two cards rebuild a key; one card reveals nothing.** The
cards say which key each panel is for, and its **Unlocks** code: the start and end of the key's public
\`age1…\` recipient.

## 0. Check the kit

\`\`\`bash
shasum -a 256 -c SHA256SUMS        # Linux: sha256sum -c SHA256SUMS
\`\`\`

Every line must say \`OK\`. On Windows: \`Get-FileHash <file>\` in PowerShell, compared by eye.

## 1. Fetch the backups

Use any S3 client (rclone, the AWS CLI, Cyberduck…) with the bucket's endpoint
\`https://<account-id>.r2.cloudflarestorage.com\` and an access key for the bucket. Download the object you
want to restore, usually the newest under \`daily/\` or \`monthly/\`.

## 2. Rebuild a key from two cards

Do this once per key. The two holders do not need to be together: each share is checked on its own.

\`\`\`bash
python3 -m venv slip39
slip39/bin/pip install --no-index --find-links python 'shamir-mnemonic[cli]' bech32
slip39/bin/shamir recover
\`\`\`

Type the first holder's 33 words on one line, then the second holder's. The first four letters of each
word are enough to identify it, but \`shamir\` wants whole words (the list is \`slip39/wordlist.txt\`). A
mistyped word is caught by the share's checksum. It prints \`Your master secret is: <hex>\`. Turn that
into an age identity:

\`\`\`bash
slip39/bin/python -c "import bech32,sys; print(bech32.bech32_encode('age-secret-key-', \\
  bech32.convertbits(bytes.fromhex(sys.argv[1]), 8, 5)).upper())" <hex> > identity.txt
\`\`\`

The Python packages are in \`python/\` (${wheels.map((w) => `${basename(w.path)}`).join(", ")}). A wheel is a zip
of plain Python source. If Python itself is gone, \`slip39/slip-0039.md\` specifies the scheme completely
and \`slip39/wordlist.txt\` is its word list: with those, the key can be rebuilt in any language.

## 3. Build the tools

\`build-tools.sh\` builds everything else from this kit, offline: age ${age} (ready-made binaries for
macOS and Linux), zstd ${zstd.version}, and PostgreSQL ${pg.version} with zlib ${zlib.version}, plus the m4,
bison and flex that building PostgreSQL needs. It is short; read it to see each step.

\`\`\`bash
bash build-tools.sh "$HOME/kit-tools"          # a few minutes, mostly PostgreSQL
export PATH="$HOME/kit-tools/bin:$PATH"
age-keygen -y identity.txt                    # must match the card's Unlocks code
\`\`\`

On Windows, unzip \`age/age-${age}-windows-amd64.zip\` and \`${find(manifest, /^zstd\/.*win64\.zip$/).path}\` for
age and zstd, and use WSL (Linux on Windows) for PostgreSQL. Specifications, in case the tools
themselves ever need rebuilding: \`age/age-spec.md\` and \`${find(manifest, /^zstd\/rfc\d+\.txt$/).path}\` (zstd).
age's source (\`age/age-${age}-source.tar.gz\`) needs Go to build.

## 4. Open a table archive

\`\`\`bash
age -d -i archive-identity.txt <file>.ndjson.zst.age | zstd -d > rows.ndjson
\`\`\`

## 5. Restore a database dump

\`pg_restore\` must be at least the major version the dumps were made with; this kit's is
${pgMajorOf(manifest)}. Start a scratch database, decrypt the dump and restore it:

\`\`\`bash
initdb -D "$HOME/pgdata" -U postgres && pg_ctl -D "$HOME/pgdata" -l pg.log start
age -d -i identity.txt <name>-<timestamp>.dump.age > backup.dump
createdb -U postgres restored
pg_restore -U postgres -d restored --no-owner --no-privileges backup.dump
\`\`\`

\`pg_restore -l backup.dump\` lists what a dump holds without restoring it.

## What's in the kit

| File | What | Version |
|---|---|---|
${rows}
| \`key-escrow.md\` | The runbook: the key cards, the ceremony, and recovery | |
| \`manifest.yaml\` | Where each file came from, and its SHA-256 | |
| \`SHA256SUMS\` | Checksums of everything here | |
`;
}
