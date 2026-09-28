// ─────────────────────────────────────────────────────────────────────────────
// SLIP-39 split/combine, delegated to the reference implementation.
//
// The Shamir arithmetic is NOT reimplemented here. It runs in SatoshiLabs' `shamir-mnemonic`
// Python package — the reference implementation of the standard, and the same code behind the
// `shamir recover` CLI a recovery can fall back on without this repo. We talk to it over stdin/stdout
// JSON so a secret never appears in argv (visible to every process via `ps`).
//
// Install: python3 -m venv ~/.slip39 && ~/.slip39/bin/pip install shamir-mnemonic
// then point SLIP39_PYTHON at ~/.slip39/bin/python (default: python3 on PATH).
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";

/** A 256-bit secret is 33 words: 20 bits of set identifier/parameters, share data, 30 bits of checksum. */
export const WORDS_PER_SHARE = 33;

const BRIDGE = `
import json, sys
req = json.load(sys.stdin)
def out(**kw):
    print(json.dumps(kw))
    sys.exit(0)
try:
    import shamir_mnemonic as s
    from shamir_mnemonic.wordlist import WORDLIST
except ImportError as e:
    out(ok=False, missing=True, error=str(e))
op = req["op"]
if op == "split":
    groups = s.generate_mnemonics(1, [(req["threshold"], req["count"])], bytes.fromhex(req["secret"]))
    out(ok=True, shares=groups[0])
if op == "combine":
    try:
        out(ok=True, secret=s.combine_mnemonics(req["shares"]).hex())
    except s.MnemonicError as e:
        out(ok=False, error=str(e))
if op == "inspect":
    from shamir_mnemonic.share import Share
    try:
        sh = Share.from_mnemonic(req["share"])
        out(ok=True, index=sh.index, threshold=sh.member_threshold)
    except s.MnemonicError as e:
        out(ok=False, error=str(e))
if op == "wordlist":
    out(ok=True, words=WORDLIST)
out(ok=False, error="unknown op " + op)
`;

type BridgeReply = {
  ok: boolean;
  missing?: boolean;
  error?: string;
  shares?: string[];
  secret?: string;
  words?: string[];
  index?: number;
  threshold?: number;
};

function python(): string {
  return process.env.SLIP39_PYTHON || "python3";
}

function bridge(req: Record<string, unknown>): BridgeReply {
  const r = spawnSync(python(), ["-c", BRIDGE], { input: JSON.stringify(req), encoding: "utf8" });
  if (r.error) throw new Error(`${python()}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`SLIP-39 bridge failed: ${r.stderr.trim()}`);
  const reply = JSON.parse(r.stdout) as BridgeReply;
  if (reply.missing) {
    throw new Error(
      `the SLIP-39 reference library is not installed for ${python()} (${reply.error}).\n` +
        "  python3 -m venv ~/.slip39 && ~/.slip39/bin/pip install shamir-mnemonic\n" +
        "  then re-run with SLIP39_PYTHON=~/.slip39/bin/python",
    );
  }
  return reply;
}

/** True when the reference library is importable — tests use it to decide whether to run. */
export function slip39Available(): boolean {
  try {
    bridge({ op: "wordlist" });
    return true;
  } catch {
    return false;
  }
}

/** Split `secret` into `count` shares, any `threshold` of which rebuild it. Single group, no passphrase. */
export function split(secret: Uint8Array, threshold: number, count: number): string[][] {
  const reply = bridge({ op: "split", secret: Buffer.from(secret).toString("hex"), threshold, count });
  if (!reply.ok || !reply.shares) throw new Error(`SLIP-39 split failed: ${reply.error}`);
  return reply.shares.map((m) => m.split(" "));
}

/**
 * Rebuild the secret. Throws the library's own message on a failure — which is the useful part: it
 * names a bad checksum ("Invalid mnemonic checksum for …"), shares from different sets ("identifier
 * parameters don't match") and too few shares, and it checks a digest of the rebuilt secret.
 */
export function combine(shares: string[][]): Uint8Array {
  const reply = bridge({ op: "combine", shares: shares.map((s) => s.join(" ")) });
  if (!reply.ok || !reply.secret) throw new Error(reply.error ?? "SLIP-39 combine failed");
  return Uint8Array.from(Buffer.from(reply.secret, "hex"));
}

/**
 * Check ONE share on its own: every word on the list, and its 30-bit checksum. This is what lets a
 * recovery collect shares at different times — each is verified the moment it is given (a holder can
 * be corrected while still on the phone), and one share alone reveals nothing, so it can be kept
 * until the second arrives. Returns the share's 1-based number.
 */
export function inspectShare(share: string[]): { number: number; threshold: number } {
  const reply = bridge({ op: "inspect", share: share.join(" ") });
  if (!reply.ok || reply.index === undefined || reply.threshold === undefined) throw new Error(reply.error ?? "not a valid share");
  return { number: reply.index + 1, threshold: reply.threshold };
}

/** The 1024-word SLIP-39 list, from the reference library. */
export function wordlist(): string[] {
  const reply = bridge({ op: "wordlist" });
  if (!reply.ok || !reply.words) throw new Error(`could not read the SLIP-39 wordlist: ${reply.error}`);
  return reply.words;
}

/**
 * Turn what a person typed into list words. SLIP-39 words are unique by their first four letters,
 * so `acad` is `academic`; a longer token must still be a prefix of that word, so `acadx` is
 * rejected rather than silently read as `academic`. Numbers copied off the card (`12`) are ignored.
 */
export function expandWords(typed: string, list: string[]): string[] {
  const byPrefix = new Map(list.map((w) => [w.slice(0, 4), w]));
  const tokens = typed.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !/^\d+$/.test(t));
  return tokens.map((t, i) => {
    const word = byPrefix.get(t.slice(0, 4));
    if (t.length < 4 && !list.includes(t)) throw new Error(`word ${i + 1} "${t}": type at least the first four letters`);
    if (!word || !word.startsWith(t)) throw new Error(`word ${i + 1} "${t}" is not on the SLIP-39 word list`);
    return word;
  });
}

/** The words every share in a set begins with — they encode the set's identifier, so cards can be matched. */
export function setIdOf(share: string[]): string[] {
  return share.slice(0, 2);
}
