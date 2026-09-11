// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare R2 API-token arithmetic and naming — the pure half of roll-r2-token.ts.
//
// An R2 token has THREE values and only two of them are independent
// (https://developers.cloudflare.com/r2/api/tokens/ — "Get S3 API credentials from an API token"):
//
//   Token value        the credential itself; shown once, on create or roll
//   Access Key ID      = the token's `id`. A roll reissues the VALUE, so this survives a roll.
//   Secret Access Key  = SHA-256(token value), hex
//
// Two consequences the dashboard does not spell out, and both matter for escrow:
//
//   1. The token value is strictly MORE recoverable than the secret — keep it and the secret can
//      always be recomputed. Escrow the value; escrowing only the secret throws information away.
//   2. It gives a free mate check. If SHA-256(value) does not equal the secret you were shown,
//      you have two halves of DIFFERENT credentials and storing them would bake in a failure that
//      only surfaces at the next backup. Same shape as `age-keygen -y` proving an age identity is
//      the mate of its recipient.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

/** Secret Access Key for an R2 token value: its SHA-256, lower-case hex. */
export function secretFromTokenValue(tokenValue: string): string {
  return createHash("sha256").update(tokenValue, "utf8").digest("hex");
}

/** Do these three values belong to ONE token? Undefined `secret` means "derive it, nothing to check". */
export function isMate(tokenValue: string, secret: string | undefined): boolean {
  return secret === undefined || secretFromTokenValue(tokenValue) === secret.trim().toLowerCase();
}

/**
 * 1Password FIELD labels for a credential prefix — the same names the workflows use as env vars.
 *
 * These were three separate `API Credential` ITEMS until 2026-09-11. They are now three fields of
 * one Secure Note (`--item`, default `backup`), because a vault holding one item per secret does
 * not scale and the per-item split bought nothing the note's own header cannot carry. See
 * docs/vaults.md in simonhac/infra.
 *
 * `op item edit <item> FIELD=value` touches only the named fields, so three writes into one note
 * cannot clobber each other or the note's body.
 */
export function opFieldNames(prefix: string): { accessKeyId: string; secretAccessKey: string; tokenValue: string } {
  return {
    accessKeyId: `${prefix}_ACCESS_KEY_ID`,
    secretAccessKey: `${prefix}_SECRET_ACCESS_KEY`,
    tokenValue: `${prefix}_TOKEN_VALUE`,
  };
}

export interface RollArgs {
  /** Empty only under --dry-run, which never touches 1Password. */
  vault: string;
  prefix: string;
  bucket: string;
  accountId: string;
  repo: string | null; // null = escrow only, do not touch GitHub
  item: string; // the 1Password Secure Note these three fields live in (default: backup)
  dryRun: boolean; // check the credential; write nothing, anywhere
}

/**
 * Parse the CLI flags.
 *
 * `--repo` is OPTIONAL on purpose: a read-only operator token is escrowed and must NEVER reach CI,
 * so "escrow without publishing" has to be a first-class mode rather than a step you remember not
 * to run. `--dry-run` runs the mate and connect checks and writes nothing anywhere — it is how you
 * answer "is this credential any good?" without a vault, and how the guards themselves are tested.
 */
export function parseRollArgs(argv: string[]): RollArgs {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  const dryRun = argv.includes("--dry-run");
  const vault = get("--vault");
  const bucket = get("--bucket");
  const accountId = get("--account-id");
  // A dry run stores nothing, so demanding a vault would be asking for a flag it will not use —
  // friction on exactly the path you want people to take before the real one.
  if (!vault && !dryRun) throw new Error("--vault <1password-vault> is required (or pass --dry-run)");
  if (!bucket) throw new Error("--bucket <r2-bucket> is required (the credential is verified against it)");
  if (!accountId) throw new Error("--account-id <cloudflare-account-id> is required (the S3 endpoint)");
  return {
    vault: vault ?? "",
    bucket,
    accountId,
    prefix: get("--prefix") ?? "R2",
    item: get("--item") ?? "backup",
    repo: get("--repo"),
    dryRun,
  };
}
