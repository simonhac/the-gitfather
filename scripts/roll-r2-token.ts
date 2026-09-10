// ─────────────────────────────────────────────────────────────────────────────
// Escrow a freshly rolled (or freshly minted) Cloudflare R2 API token: verify it, store it in
// 1Password, and publish it to GitHub Actions FROM that escrow.
//
// Rolling an R2 token is the only way to learn its credential — neither Cloudflare nor GitHub will
// show you an existing one again. That makes the roll the moment escrow is possible, and also the
// moment it is easy to get wrong: the old credential dies immediately, the new one is displayed
// once, and nothing downstream can be read back to check what you stored.
//
// So this does the checking in the order that fails cheapest:
//
//   1. MATE     SHA-256(token value) must equal the Secret Access Key you were shown. Two halves
//               of different tokens is otherwise a silent, deferred failure.
//   2. CONNECT  the credential must actually list the bucket — BEFORE anything is written anywhere.
//               A credential proven at rest is not a credential proven to work; the reverse order
//               is how a wrong value gets sealed into a store that cannot be read back.
//   3. ESCROW   write 1Password, then read it BACK and compare bytes.
//   4. PUBLISH  set the GitHub secrets from what 1Password returned — never from the paste buffer.
//               If the escrow were wrong, this is where it surfaces, while it is still free.
//
// Usage:
//   npx tsx scripts/roll-r2-token.ts --vault boost-prod --bucket boost-pg-backups \
//     --account-id <cf-account> [--prefix R2] [--repo boost-suite/boost]
//
// Omit --repo for an operator credential that must never reach CI (a read-only DR token).
// ─────────────────────────────────────────────────────────────────────────────

import { createInterface } from "node:readline";
import { capture, commandExists } from "./lib/proc.js";
import { secretFromTokenValue, isMate, opItemNames, parseRollArgs, type RollArgs } from "./lib/r2Token.js";

function die(msg: string): never {
  process.stderr.write(`\nERROR: ${msg}\n`);
  process.exit(1);
}

/**
 * A non-echoing prompter over ONE readline interface.
 *
 * One interface for the whole session, not one per question: a fresh interface takes ownership of
 * stdin and buffers what it reads, so opening a second one loses whatever the first swallowed —
 * fine against a live TTY, silently truncating against a pipe or a here-doc.
 */
function makePrompter(): { ask: (label: string) => Promise<string>; done: () => void } {
  // `terminal` follows isTTY. There is nothing to hide when input is piped — and forcing it true
  // against a pipe makes readline echo the rest of the stream and never resolve, which exits 0.
  const isTty = process.stdin.isTTY === true;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: isTty });
  const out = process.stdout as NodeJS.WriteStream & { muted?: boolean };
  const write = out.write.bind(out);
  out.muted = false;
  if (isTty) {
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (!out.muted) write(s);
    };
  }
  // Pull lines through the async iterator rather than rl.question(). Against a pipe, readline
  // emits every line as soon as it arrives and DROPS any with no question pending — so a
  // question-per-value silently loses everything after the first. The iterator pauses the stream
  // between pulls, which also makes the interactive and piped paths behave identically.
  const lines = rl[Symbol.asyncIterator]();
  return {
    ask: async (label: string): Promise<string> => {
      write(`${label}: `);
      out.muted = isTty;
      const { value, done } = await lines.next();
      out.muted = false;
      write("\n");
      // stdin ended early: resolve empty so the caller's "required" check reports it, rather than
      // hanging forever or exiting 0 as though everything had succeeded.
      return done ? "" : String(value).trim();
    },
    done: () => {
      out.muted = false;
      rl.close();
    },
  };
}

/** Does an item already exist in the vault? Determines create-vs-edit; a roll is usually an edit. */
function itemExists(vault: string, title: string): boolean {
  return capture("op", ["item", "get", title, "--vault", vault, "--format=json"]).ok;
}

function putItem(vault: string, title: string, value: string, note: string): void {
  const r = itemExists(vault, title)
    ? capture("op", ["item", "edit", title, "--vault", vault, `credential=${value}`, `notesPlain=${note}`, "--format=json"])
    : capture("op", ["item", "create", "--category", "API Credential", "--vault", vault, "--title", title,
        `credential=${value}`, `notesPlain=${note}`, "--format=json"]);
  if (!r.ok) die(`could not write ${title} to 1Password: ${r.stderr.trim()}`);
}

function readItem(vault: string, title: string): string {
  const r = capture("op", ["read", `op://${vault}/${title}/credential`]);
  if (!r.ok) die(`could not read ${title} back from 1Password: ${r.stderr.trim()}`);
  return r.out.replace(/\n$/, "");
}

/** List one object under the bucket with these credentials. Proves the credential WORKS. */
function credentialListsBucket(a: RollArgs, keyId: string, secret: string): { ok: boolean; detail: string } {
  const r = capture("rclone", ["lsf", "--max-depth", "1", `r2:${a.bucket}`, "--s3-no-check-bucket"], {
    ...process.env,
    RCLONE_CONFIG_R2_TYPE: "s3",
    RCLONE_CONFIG_R2_PROVIDER: "Cloudflare",
    RCLONE_CONFIG_R2_ACCESS_KEY_ID: keyId,
    RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: secret,
    RCLONE_CONFIG_R2_ENDPOINT: `https://${a.accountId}.r2.cloudflarestorage.com`,
  });
  return { ok: r.ok, detail: r.ok ? r.out.trim().split("\n").filter(Boolean).join(", ") : r.stderr.trim() };
}

function ghSecretTimestamps(repo: string, names: string[]): Record<string, string> {
  const r = capture("gh", ["secret", "list", "-R", repo, "--json", "name,updatedAt"]);
  if (!r.ok) return {};
  const rows = JSON.parse(r.out) as { name: string; updatedAt: string }[];
  return Object.fromEntries(rows.filter((s) => names.includes(s.name)).map((s) => [s.name, s.updatedAt]));
}

function setGhSecret(repo: string, name: string, value: string): void {
  // Piped via stdin: the value never appears in argv, so it cannot be read out of `ps` or history.
  const r = capture("sh", ["-c", `printf '%s' "$SECRET_VALUE" | gh secret set ${name} -R ${repo}`], {
    ...process.env,
    SECRET_VALUE: value,
  });
  if (!r.ok) die(`could not set ${name} on ${repo}: ${r.stderr.trim()}`);
}

async function main(): Promise<void> {
  const args = parseRollArgs(process.argv.slice(2));
  const names = opItemNames(args.prefix);

  for (const bin of ["rclone", ...(args.dryRun ? [] : ["op", ...(args.repo ? ["gh"] : [])])]) {
    if (!commandExists(bin)) die(`${bin} not found on PATH`);
  }
  if (!args.dryRun && !capture("op", ["whoami"]).ok) {
    die("1Password CLI is not signed in — unlock the app or run `op signin`");
  }

  console.log(`\nRolling ${args.prefix} for bucket ${args.bucket}${args.dryRun ? "  [DRY RUN — nothing will be written]" : ""}`);
  console.log(
    args.dryRun
      ? "  escrow  → NONE (dry run: the credential is checked, not stored)"
      : `  escrow  → 1Password vault ${args.vault} (${names.tokenValue}, ${names.accessKeyId}, ${names.secretAccessKey})`,
  );
  console.log(
    args.dryRun ? "  publish → NONE (dry run)"
      : args.repo ? `  publish → GitHub secrets on ${args.repo}`
      : "  publish → NONE (escrow only — this credential stays off CI)",
  );
  console.log("\nPaste the values Cloudflare showed you. Input is hidden.\n");

  const prompt = makePrompter();
  const tokenValue = await prompt.ask("Token value");
  const accessKeyId = await prompt.ask("Access Key ID");
  const shown = await prompt.ask("Secret Access Key (blank = derive it)");
  prompt.done();
  if (!tokenValue) die("token value is required — it is what the secret is derived from");
  if (!accessKeyId) die("access key id is required (it is the token's id; a roll does not change it)");

  // ── 1. MATE ────────────────────────────────────────────────────────────────
  if (!isMate(tokenValue, shown || undefined)) {
    die(
      "the Secret Access Key is NOT the SHA-256 of that token value — these are halves of two " +
        "different tokens. Nothing was written. Re-copy both from the same Cloudflare dialog.",
    );
  }
  const secret = secretFromTokenValue(tokenValue);
  console.log(shown ? "✓ mate check: the secret is the SHA-256 of the token value" : "✓ derived the secret from the token value");

  // ── 2. CONNECT (before anything is stored) ─────────────────────────────────
  const live = credentialListsBucket(args, accessKeyId, secret);
  if (!live.ok) {
    die(
      `the credential does NOT work against ${args.bucket} — nothing was written.\n  ${live.detail}\n` +
        "  Check the token is scoped to this bucket and that --account-id matches the S3 endpoint.",
    );
  }
  console.log(`✓ connects: listed ${args.bucket} (${live.detail || "empty at depth 1"})`);

  if (args.dryRun) {
    console.log("\nDry run: the credential is valid and works. Nothing was written.\n");
    return;
  }

  // ── 3. ESCROW, then read it back ───────────────────────────────────────────
  const when = new Date().toISOString().slice(0, 10);
  const scope = `Cloudflare R2 token for ${args.bucket} (account ${args.accountId}). Rolled ${when} by roll-r2-token.ts.`;
  const consumers = args.repo
    ? `Published to GitHub secrets ${names.accessKeyId} / ${names.secretAccessKey} on ${args.repo}. A GitHub secret cannot be read back, so THIS is the source of truth — always set the secret from here, never the reverse.`
    : "Deliberately NOT published to CI: operator credential only.";
  putItem(args.vault, names.tokenValue, tokenValue,
    `${scope} The TOKEN VALUE — the Secret Access Key is its SHA-256, so this item alone can regenerate it. ${consumers}`);
  putItem(args.vault, names.accessKeyId, accessKeyId, `${scope} Access Key ID = the token's id; a roll does not change it. ${consumers}`);
  putItem(args.vault, names.secretAccessKey, secret, `${scope} SHA-256 of ${names.tokenValue}. ${consumers}`);

  const back = { keyId: readItem(args.vault, names.accessKeyId), secret: readItem(args.vault, names.secretAccessKey), value: readItem(args.vault, names.tokenValue) };
  if (back.keyId !== accessKeyId || back.secret !== secret || back.value !== tokenValue) {
    die("1Password did not return what was written — do not publish. Inspect the vault by hand.");
  }
  console.log(`✓ escrowed in ${args.vault}, and read back byte-identical`);

  // ── 4. PUBLISH from the escrow ─────────────────────────────────────────────
  if (!args.repo) {
    console.log("\nDone. Nothing published — this credential stays off CI by design.\n");
    return;
  }
  const before = ghSecretTimestamps(args.repo, [names.accessKeyId, names.secretAccessKey]);
  setGhSecret(args.repo, names.accessKeyId, back.keyId);
  setGhSecret(args.repo, names.secretAccessKey, back.secret);
  const after = ghSecretTimestamps(args.repo, [names.accessKeyId, names.secretAccessKey]);
  for (const n of [names.accessKeyId, names.secretAccessKey]) {
    if (before[n] && after[n] === before[n]) die(`${n} on ${args.repo} did not change (still ${before[n]}) — the write did not land`);
    console.log(`✓ ${n}: ${before[n] ?? "(new)"} → ${after[n]}`);
  }
  console.log(
    `\nDone. The value was published from the escrow, not from your paste buffer, so ${args.vault} is\n` +
      "correct by construction. Now run the workflow that uses it and watch it succeed — a secret\n" +
      "that is merely SET is not a secret that is known to WORK.\n",
  );
}

main().catch((e: unknown) => die((e as Error).message));
