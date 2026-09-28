# The recovery kit: how it works

The recovery kit is everything a stranger needs to open the backups years from now, stored in each
backup bucket beside the backups. This page explains how it is built, stored and proved, and why.
To *use* it, see the [recovery kit guide](recovery-kit-guide.md): it has the full-restore and
monthly-check runbooks.

## The problem

With `encryption: age`, every dump and archive needs its age identity to open. [Key
escrow](key-escrow.md) makes sure the identities survive: two of three holders can rebuild each one
from printed cards. But the cards are only half of a recovery. Whoever holds them years from now also
needs:

- code that turns 33 words back into a key (SLIP-39 and bech32);
- `age`, to decrypt;
- `zstd`, to decompress table archives;
- a `pg_restore` at least as new as the `pg_dump` that made the dumps, and a PostgreSQL to restore into.

None of these can be assumed to be one `pip install` or `brew install` away in ten years. Package
registries move, GitHub might not be there, and this repo might not be either. The kit removes that
dependency: every tool a recovery needs, pinned to exact bytes, stored where the backups are.

## What is in it, and what is not

The rule is **archive what recovery needs, not what runs the backups.** tsx, TypeScript, zod,
eslint and the scheduler Worker run the backup pipeline; nobody needs them to open a backup.

| In the kit | Why |
|---|---|
| SLIP-39 spec and 1,024-word list | With these alone, a key can be rebuilt by hand, in any language |
| `shamir-mnemonic` 0.3.0, `bech32`, `click` (wheels) | The reference code for SLIP-39 and the identity's bech32 encoding; `click` runs the `shamir` CLI. The same `shamir-mnemonic` version CI tests the cards against. |
| age: macOS arm64 and amd64, Linux amd64 and arm64, Windows binaries; source; spec | Decrypts every `.age` object |
| zstd: source, Windows binary, RFC 8878 | Table archives are zstd-compressed before they are encrypted |
| PostgreSQL source (the dump major), zlib, bison, flex, m4 | `pg_restore` and a server. Dumps are `pg_dump -Fc`, which gzip-compresses, so `pg_restore` needs zlib. Since PostgreSQL 17 the source no longer ships its generated parser, so building it needs bison and flex, and both need m4. |
| `README.md` ("start here"), `build-tools.sh`, `key-escrow.md`, `manifest.yaml`, `SHA256SUMS` | The instructions, the build, the runbook, provenance, and checksums |

**Deliberately left out:**
- **rclone**: R2 speaks the standard S3 protocol, so any S3 client can fetch the objects.
- **This repo**: `key-shares` is a convenience; the kit's README walks the no-repo path.
- **Python itself**: the kit assumes Python 3.10 or later. If even that is gone, the spec and word
  list are enough to rebuild a key by hand.
- **`node_modules`**, and any archive in the git repo.

The kit is about 136 MB, mostly the age binaries (about 18 MB each since age 1.3) and PostgreSQL's
source. It holds no secret: anyone can have a copy.

## Pinning: the manifest

[`recovery-kit/manifest.yaml`](../recovery-kit/manifest.yaml) lists every artifact with its path in
the kit, URL, version, SHA-256, and where that checksum came from (`checksum:`). For example: PyPI's
digest, the GitHub release's asset digest, PostgreSQL's published `.sha256`, or a hash taken after a
good GPG signature check (m4, bison). Spec files are pinned to a commit, never a branch. The comment
at the top of the manifest says how to bump each kind of artifact.

The manifest is validated when loaded ([`scripts/lib/recoveryKit.ts`](../scripts/lib/recoveryKit.ts)):
- paths must be plain relative segments (no `..`, no leading `/`);
- URLs must be `https`;
- hashes must be 64 lowercase hex digits;
- paths must be unique and must not collide with the files the build writes.

Tests pin the invariants that matter:
- the kit's `shamir-mnemonic` is the version `ci.yml` installs;
- the PostgreSQL major is at least 17, the default `dump.client-major`;
- zlib, bison, flex and m4 are present.

## Building: `npm run recovery-kit -- build`

[`scripts/recovery-kit.ts`](../scripts/recovery-kit.ts) `build [--out <dir>]`:

1. Fetches each artifact and **refuses it unless its SHA-256 matches the manifest**. An artifact
   already in `<dir>` at the pinned hash is kept, so a re-run only fetches what is missing.
2. Refuses a directory holding files that are not part of the kit, rather than deleting them.
3. Writes the README, generated from the manifest so it names the kit's own versions. It has no build
   date, so the same manifest always gives the same bytes.
4. Copies in `build-tools.sh`, `docs/key-escrow.md` and the manifest.
5. Writes `SHA256SUMS` over everything, in the format `shasum -a 256 -c` and `sha256sum -c` read.
6. Writes `<dir>.tar` as well: plain, uncompressed tar, the format most likely to still open in
   twenty years. That is the file for a USB copy.

**`build-tools.sh`** ([source](../recovery-kit/build-tools.sh)) builds every tool from the kit, with
no network, into `<prefix>/bin`:
- age: it unpacks the binary for the platform;
- zstd: built with lzma, lz4 and zlib support switched off, so it links nothing it happens to find;
- m4, bison and flex;
- zlib, built static so `pg_restore` carries it inside;
- PostgreSQL, built `--without-icu --without-readline` against that zlib.

It needs a C compiler, `make` and Perl, and works on Linux and macOS (Windows via WSL). It takes about
five minutes, mostly PostgreSQL. The built PostgreSQL has **no SSL support**. That is fine for
restoring into a local scratch server, which is all a recovery needs.

## Storing: `upload` and `verify`

Each kit is stored at `recovery-kit/<kit-id>/` at the root of the backup bucket, outside any
`<prefix>/`. The kit id is `<build date>-<first 12 hex of SHA-256(SHA256SUMS)>`, e.g.
`2026-09-28-2809d993e808`.

- **Stored once, never changed.** `upload` first checks the local kit against its own `SHA256SUMS`
  and against the manifest, so a stale or tampered kit is refused. If a kit with the same digest is
  already stored, even under another date, it uploads nothing. Every write is a single PUT that
  refuses to overwrite.
- **`SHA256SUMS` goes up last.** A kit without it is an upload that was cut short: `verify` calls it
  incomplete, the monthly drill skips it, and a re-run of `upload` resumes it.
- **`verify`** re-downloads every stored kit and re-hashes every byte against that kit's
  `SHA256SUMS`. It also says whether each kit is **current**, meaning it carries every artifact at the
  hash the manifest now pins. It exits 1 if any kit is damaged, or if none is stored. `upload` runs it
  on the kit it just stored.

Both use the `R2_*` variables and the ordinary backup token (Object Read & Write). Uploading needs no
delete.

**Lock and lifecycle.** No lifecycle rule covers `recovery-kit/`: every expiry rule is scoped to
`<prefix>/…`, `_status/` or `_log/`. That absence is what makes the kit permanent. A bucket lock,
`lock-recovery-kit`, makes each kit object immutable for **180 days** after it is written, so a leaked
credential cannot delete or overwrite a kit. The one-time `wrangler` step is in [R2
setup](r2-setup.md#the-recovery-kit-prefix). Locks outrank lifecycle rules, which is another reason
never to add an expiry rule here.

**A second copy**, on a USB drive held by one of the key holders, covers losing R2 itself. It needs no
tooling: it is the `.tar` that `build` writes.

## Proof, not faith: the offline drill

A kit nobody has recovered from is a kit on faith. `npm run key-shares -- drill --kit <dir>` runs a
whole recovery with **nothing but the kit**, in a container with **no network**:

1. **On the host,** it:
   - makes two throwaway age keys (a "dump" key and an "archive" key);
   - splits each 2-of-3 and proves every pair rebuilds it;
   - writes holders 1 and 3's shares, and the public recipient each key must derive;
   - writes an archive file made the way the archiver makes them: rows, then zstd, then age.

   The keys themselves are never written.
2. **In a stock `python:3.12-bookworm` container,** started with `--network none`, with the kit and
   the practice files mounted read-only, [`recovery-kit/offline-drill.sh`](../recovery-kit/offline-drill.sh)
   follows the kit's README. It:
   - checks the container really is offline, then checks the kit against `SHA256SUMS`;
   - installs the wheels with `pip --no-index`, and checks the library's word list is the spec's;
   - rebuilds both keys with `shamir recover` and the README's bech32 one-liner;
   - runs `build-tools.sh`, and checks each rebuilt key derives its recipient;
   - decrypts and decompresses the archive file;
   - uses the kit's own `pg_dump -Fc` to dump a small database (the host's `pg_dump` may be a newer
     major), and encrypts that dump to the practice recipient using only the public key;
   - decrypts the dump with the rebuilt key, restores it, and checks the row.

If the kit lacks anything a recovery needs, a step fails. This is how bison, flex and m4 got into the
kit: the first drill failed on PostgreSQL 17's configure. The drill needs Docker; OrbStack and
Podman work too (`DOCKER=<binary>`). It is not part of `npm test`, because it needs Docker and takes
minutes.

## The monthly manual drill runs on the kit

The [manual drill](verify-and-restore.md#verifying-backups-integrity) (`npm run drill-object`) is the
human check that a real stored object still opens with the escrowed key. It is also the kit's
recurring proof: [`scripts/lib/kitTools.ts`](../scripts/lib/kitTools.ts) makes it run on tools built
**from the stored kit**, not whatever is installed on the laptop.

1. **Choose a kit:** `--kit-id <id>`, or else the newest complete kit in the bucket. With none, the
   drill refuses to run.
2. **Fetch it** into the cache, hash every byte against its `SHA256SUMS`, and refuse a damaged kit
   before running any of it. Warn if it is older than the manifest.
3. **Build** with the kit's own `build-tools.sh`, and cache the result in
   `~/.cache/the-gitfather/kit-tools/<kit-id>/` (or `$GITFATHER_KIT_CACHE`). A kit id names exact
   bytes, so a cache hit can never be a different kit. The first drill on a new kit takes about five
   extra minutes; after that the cache is reused. The cache keeps only the built tools (about 50 MB).
4. **Put the kit's `bin/` first on `PATH`,** and check that `age`, `pg_restore` and `psql` resolve
   there.
5. **Record the kit id** in the verification record (`kit`).

`verify-durable.drill-max-age-days` counts only manual drills whose record names a kit. A drill that
did not use the kit does not stop the "manual decrypt drill overdue" warning.

## Limits

- **Bucket access is not in the kit.** Fetching the backups (and the kit) still needs an R2
  credential or the Cloudflare account. The USB copy covers the tools, not the backups.
- **Python 3.10 or later** is assumed. Without it, the spec and word list are the fallback.
- **The age source needs Go** to build. The binaries cover macOS, Linux and Windows on the common
  architectures.
- **PostgreSQL on Windows** means WSL.
- **The kit's PostgreSQL has no SSL**, so restore into a local server.
- **The kit carries one PostgreSQL major.** Bump it before any profile's `dump.client-major` moves
  past it.

## Where things are

| | |
|---|---|
| [`recovery-kit/manifest.yaml`](../recovery-kit/manifest.yaml) | The pinned artifacts |
| [`recovery-kit/build-tools.sh`](../recovery-kit/build-tools.sh) | Builds the tools from a kit (ships inside it) |
| [`recovery-kit/offline-drill.sh`](../recovery-kit/offline-drill.sh) | The in-container half of the offline drill |
| [`scripts/recovery-kit.ts`](../scripts/recovery-kit.ts) | `build`, `upload`, `verify` |
| [`scripts/lib/recoveryKit.ts`](../scripts/lib/recoveryKit.ts) | Manifest schema, checksums, kit ids, the README |
| [`scripts/lib/kitTools.ts`](../scripts/lib/kitTools.ts) | Fetch, check, build and cache a stored kit's tools for the manual drill |
| [`scripts/key-shares.ts`](../scripts/key-shares.ts) `drill` | The host half of the offline drill |
