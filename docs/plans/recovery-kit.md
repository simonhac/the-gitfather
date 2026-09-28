# Handoff: build the recovery kit

## Goal / definition of done

A new command, `npm run recovery-kit`, builds and uploads a self-contained **recovery kit**: every
artifact a stranger needs to open the backups years from now, even if package registries, GitHub or
this repo are gone.

The command must:
- fetch each artifact at a **pinned** version;
- verify each against a **recorded checksum**;
- write a "start here" README;
- upload the kit to a **locked R2 prefix** beside the backups.

The practice drill (`npm run key-shares -- practice`, see `docs/key-escrow.md`) gains a mode that runs
the whole recovery **from the kit alone, with no network**.

The task is finished when:
- tests are green;
- the offline drill passes;
- the docs are updated;
- the work is not committed. Simon commits.

## Decisions already made (don't re-litigate)

- **Archive what recovery needs, not every dependency.** The npm tooling (tsx, TypeScript, zod,
  eslint, the `scheduler/` Worker) runs the backups; nobody needs it to open them. Don't vendor
  `node_modules`, and don't add archives to the git repo.
- **Kit contents:**
  - The **SLIP-39 spec** and its **1,024-word list**. With these, a person can rebuild a split key
    even if every library has disappeared.
  - The source of **`shamir-mnemonic`** (pinned to `0.3.0`, the version CI uses) and of **`bech32`**.
    Both are small pure-Python packages. Archive their sdists or wheels.
  - **age**: static binaries for macOS (arm64 + amd64), Linux amd64 and Windows, the source tarball,
    and the age spec.
  - **zstd**: archive objects are zstd-compressed before they are age-encrypted (see
    `docs/archiving.md`). Include its source, plus binaries where upstream publishes them.
  - The **PostgreSQL source tarball** for the major version the dumps are taken with. The CI clients
    are pinned by `pg-client-major` in `.github/actions/setup-tools/action.yml`. `pg_restore` must be
    at least that major.
  - The runbook `docs/key-escrow.md`, plus the "start here" README. The README walks through the
    no-repo recovery path (the "Without this repo" section of `docs/key-escrow.md`), then age, then
    zstd, then `pg_restore`.
- **Not in the kit:** rclone, and this repo itself. R2 speaks the standard S3 protocol, so any S3
  client works. `key-shares` is a convenience, and the no-repo path already recovers without it.
- **Where the kit is stored:** in the backup bucket, under its own prefix, with a bucket lock. It is
  not only in git, because GitHub is one of the things that might not be there. Backups and kit belong
  together.
  - Follow the lock and lifecycle conventions in `docs/r2-setup.md`. The kit must have **no lifecycle
    expiry**, like the archive prefix.
  - Setting locks needs account-level Cloudflare credentials. Document the one-time `wrangler` step
    rather than scripting it, the same way the other locks are done.
- **Optional second copy:** a USB drive held by one of the key holders, in case R2 itself is lost. The
  runbook mentions it; no tooling is needed.
- **Proof, not faith.** The offline drill is what shows the kit is complete. The likely shape: a
  container with `--network none` holding only the kit, a practice issue's shares, and its
  `drill-*.txt.age` file. It must rebuild the key and decrypt the file using only kit contents.
  Consider also restoring a tiny test dump with the kit's Postgres, if that is practical.
- This is a **public repo**. Keep client names out of code, docs and examples. Use placeholders like
  "Example Co".

## Pointers

- **Key-escrow tooling the kit builds on:**
  - `scripts/key-shares.ts`
  - `scripts/lib/slip39.ts`, which calls the Python reference library over stdin JSON. The Python
    interpreter comes from the `SLIP39_PYTHON` env var.
  - `scripts/lib/ageKey.ts` (bech32 ↔ age identity)
  - `scripts/lib/keyCard.ts`
  - `scripts/__tests__/key-shares.test.ts`
  - `docs/key-escrow.md`
  - `profiles/ceremony.example.yaml`
- **Existing script patterns:**
  - `scripts/roll-r2-token.ts` escrows and uploads.
  - `scripts/drill-object.ts` shows the `isEntrypoint()` guard, the long header comment and the
    `parseArgs` style.
  - `scripts/lib/proc.ts` has the subprocess helpers.
- **CI:** `.github/workflows/ci.yml` installs `shamir-mnemonic==0.3.0` in a venv and **fails if any
  test skips**. New tests must run in CI or be kept out of `npm test`. Tests that need Docker or the
  network should be a separate, manually run drill, not part of `npm test`.

## Transient state not in the repo

- Locally, `npm test` needs `SLIP39_PYTHON` pointing at a Python with `shamir-mnemonic` installed
  (see "Setup" in `docs/key-escrow.md`); without it the SLIP-39 tests skip.
- No live key ceremony has been run for any consuming project yet. Simon runs those himself.

## Next actions

1. Read `docs/key-escrow.md` and `docs/r2-setup.md`, then `scripts/key-shares.ts`.
2. Pin the artifacts. Record each item's source URL, version and SHA-256 in a committed manifest, e.g.
   `recovery-kit/manifest.yaml`, with a comment explaining how to bump each one.
3. Build `scripts/recovery-kit.ts` with these subcommands:
   - `build` fetches, verifies and assembles the kit plus the README into a local dir or tarball;
   - `upload` sends it to the kit prefix;
   - `verify` re-hashes what is stored against the manifest.
   Add unit tests for the manifest and checksum logic.
4. Add the offline drill and document it in `docs/key-escrow.md`. Also add a README link and the R2
   lock step to `docs/r2-setup.md`.

## Out of scope / guardrails

- Don't commit or suggest a commit until Simon asks.
- Never run the `op` (1Password) CLI without first explaining why and getting Simon's consent.
- Don't touch consuming repos without asking.
- Don't change the existing backup, verify or archive pipelines.
- Verify with `npm run typecheck && npm run lint && npm test`. This repo has no `build:local`.
