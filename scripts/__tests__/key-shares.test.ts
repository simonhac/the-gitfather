import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bech32Decode, bech32Encode, identityToSecret, readIdentity, recipientOf, secretToIdentity } from "../lib/ageKey.js";
import { CeremonySchema, cardFilename, recipientMatches, renderCard, type Ceremony } from "../lib/keyCard.js";
import { commandExists } from "../lib/proc.js";
import { WORDS_PER_SHARE, combine, expandWords, inspectShare, setIdOf, slip39Available, wordlist } from "../lib/slip39.js";
import { PAIRS, countPdfPages, parseArgs, splitAndVerify } from "../key-shares.js";

// A throwaway key made for this file — it protects nothing.
const IDENTITY = "AGE-SECRET-KEY-1H8J78RY407K5WFW2RRJ2ST6KT83NSV3A6RPVSPY0QW50DE3NSMGQFH57DL";
const RECIPIENT = "age1khd7y6y5ywhrsnel77czrkv7d7c85prsv6gf5qlfjezmhdyfzeustjkl6l";

const ageSkip = commandExists("age-keygen") ? false : "age-keygen not installed";
// CI installs the reference library and asserts nothing skipped, so this only ever skips locally.
const slipSkip = slip39Available() ? false : "shamir-mnemonic not installed for SLIP39_PYTHON";

// ── bech32 / age identity ────────────────────────────────────────────────────

test("bech32: the BIP-173 valid vectors decode, and re-encode to themselves", () => {
  for (const v of ["A12UEL5L", "a12uel5l", "abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw"]) {
    const { hrp, data5 } = bech32Decode(v);
    assert.equal(bech32Encode(hrp, data5), v.toLowerCase());
  }
});

test("bech32: mixed case, a bad character and a bad checksum are all rejected", () => {
  assert.throws(() => bech32Decode("A12uEL5L"), /mixed case/);
  assert.throws(() => bech32Decode("a12uel5b"), /invalid character 'b'/);
  assert.throws(() => bech32Decode("a12uel5m"), /checksum mismatch/);
});

test("an age identity round-trips through its 32 bytes exactly", () => {
  const secret = identityToSecret(IDENTITY);
  assert.equal(secret.length, 32);
  assert.equal(secretToIdentity(secret), IDENTITY);
});

test("a one-character slip in an identity is caught by its checksum, not silently accepted", () => {
  const typo = IDENTITY.slice(0, 30) + (IDENTITY[30] === "Q" ? "P" : "Q") + IDENTITY.slice(31);
  assert.throws(() => identityToSecret(typo), /checksum/);
  assert.throws(() => identityToSecret(RECIPIENT), /not an age identity/);
});

test("readIdentity: the key itself, or a key file with its comments; never a file with two keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "ks-"));
  try {
    assert.equal(readIdentity(`  ${IDENTITY}\n`), IDENTITY);
    const file = join(dir, "key.txt");
    writeFileSync(file, `# created: 2026-09-28\n# public key: ${RECIPIENT}\n${IDENTITY}\n`);
    assert.equal(readIdentity(file), IDENTITY);
    writeFileSync(file, `${IDENTITY}\n${IDENTITY}\n`);
    assert.throws(() => readIdentity(file), /exactly one AGE-SECRET-KEY line, found 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recipientOf derives the public key with age-keygen", { skip: ageSkip }, () => {
  assert.equal(recipientOf(IDENTITY), RECIPIENT);
});

// ── the card ─────────────────────────────────────────────────────────────────

test("recipientMatches: the full recipient, or the card's abbreviated Unlocks code", () => {
  assert.equal(recipientMatches(RECIPIENT, RECIPIENT), true);
  assert.equal(recipientMatches(RECIPIENT, "age1khd7y6…ustjkl6l"), true);
  assert.equal(recipientMatches(RECIPIENT, "age1khd7y6...ustjkl6l"), true, "three dots, as typed on a keyboard");
  assert.equal(recipientMatches(RECIPIENT, "age1khd7y7…ustjkl6l"), false);
  assert.equal(recipientMatches(RECIPIENT, "age1k…l"), false, "too short to mean anything");
});

const ceremony = (over: Partial<Record<string, unknown>> = {}): Ceremony =>
  CeremonySchema.parse({
    org: "Example <Co>",
    holders: [{ name: "Alex" }, { name: "Bea", phone: "+61 400 000 002" }, { name: "Casey", email: "casey@example.com" }],
    keys: [{ title: "Daily backups key", "identity-env": "AGE_IDENTITY", recipient: RECIPIENT }],
    ...over,
  });

test("the ceremony file: exactly three holders, distinct well-formed recipients", () => {
  assert.throws(() => ceremony({ holders: [{ name: "Alex" }, { name: "Bea" }] }), /exactly three holders/);
  assert.throws(() => ceremony({ keys: [{ title: "x", "identity-env": "AGE_IDENTITY", recipient: "age1nope" }] }), /age1… X25519 recipient/);
  const dup = { title: "x", "identity-env": "AGE_IDENTITY", recipient: RECIPIENT };
  assert.throws(() => ceremony({ keys: [dup, { ...dup, title: "y" }] }), /same recipient is listed twice/);
  assert.throws(() => ceremony({ owner: "someone" }), /unrecognized/i, "a typo'd field is an error, not ignored");
});

const shares = [1, 2, 3].map((n) => Array.from({ length: WORDS_PER_SHARE }, (_, i) => `s${n}w${String(i).padStart(2, "0")}xyz`));
const printed = (w: string) => `<b>${w.slice(0, 4)}</b>${w.slice(4)}</span>`;
const card = (n: number, mode: "live" | "test" = "live") =>
  renderCard(ceremony(), [{ key: ceremony().keys[0], words: shares[n - 1], setId: ["alpha", "beta"] }], { n, date: "28 September 2026", issue: "7", mode });

test("a card carries its own holder's words and nobody else's", () => {
  const html = card(2);
  for (const w of shares[1]) assert.ok(html.includes(printed(w)), `share 2 word ${w} missing`);
  for (const w of [...shares[0], ...shares[2]]) assert.ok(!html.includes(w.slice(0, 4)), `another holder's word ${w} leaked`);
});

test("a card names the other two holders with their contacts, and itself as the holder", () => {
  const html = card(1);
  assert.match(html, /Held by <strong>Alex<\/strong>/);
  assert.match(html, /Bea <span>· share 2<\/span>/);
  assert.match(html, /\+61 400 000 002/);
  assert.match(html, /casey@example\.com/);
});

test("live and practice cards can't be confused: label, watermark and issue", () => {
  const live = card(1, "live");
  const practice = card(1, "test");
  assert.match(live, /class="kind">Live</);
  assert.ok(!live.includes("NOT A REAL KEY"));
  assert.match(live, /replaces all earlier live cards/);
  assert.match(practice, /class="kind">Practice</);
  assert.match(practice, /PRACTICE · NOT A REAL KEY/);
  assert.match(practice, /issue <span class="id">7<\/span>/);
});

test("ceremony text is escaped into the card", () => {
  assert.match(card(1), /Example &lt;Co&gt;/);
  assert.ok(!card(1).includes("<Co>"));
});

test("cardFilename says which share, which issue and whether it is practice", () => {
  assert.equal(cardFilename("Example Co", 2, "7", "live"), "example-co-recovery-share-2-of-3-issue-7.pdf");
  assert.equal(cardFilename("Example Co", 3, "P-2026-09-28", "test"), "example-co-practice-share-3-of-3-issue-P-2026-09-28.pdf");
});

test("countPdfPages counts page objects, not the page tree", () => {
  const pdf = Buffer.from("<< /Type /Pages /Count 2 >> << /Type /Page >> << /Type /Page\n>>", "latin1");
  assert.equal(countPdfPages(pdf), 2);
});

// ── arguments ────────────────────────────────────────────────────────────────

test("parseArgs: each command, and its required flags", () => {
  assert.deepEqual(parseArgs(["cards", "--ceremony", "c.yaml"]), { cmd: "cards", ceremony: "c.yaml", out: undefined });
  assert.deepEqual(parseArgs(["practice", "--ceremony", "c.yaml", "--issue", "P3"]), { cmd: "practice", ceremony: "c.yaml", issue: "P3", out: undefined });
  assert.deepEqual(parseArgs(["recover", "--recipient", RECIPIENT, "--share", "a.txt"]), { cmd: "recover", recipient: RECIPIENT, shares: ["a.txt"] });
  assert.deepEqual(parseArgs(["check-share"]), { cmd: "check-share" });
  assert.deepEqual(parseArgs(["drill", "--kit", "k"]), { cmd: "drill", kit: "k", image: "python:3.12-bookworm" });
  assert.deepEqual(parseArgs(["drill", "--kit", "k", "--image", "debian:13"]), { cmd: "drill", kit: "k", image: "debian:13" });
  assert.throws(() => parseArgs(["drill"]), /drill needs --kit/);
  assert.throws(() => parseArgs(["cards"]), /needs --ceremony/);
  assert.throws(() => parseArgs(["recover"]), /needs --recipient/);
  assert.throws(() => parseArgs(["recover", "--recipient", "x", "--share", "a", "--share", "b", "--share", "c"]), /at most two/);
});

test("parseArgs: an unknown flag, or one another command owns, is an error", () => {
  assert.throws(() => parseArgs(["cards", "--ceremony", "c", "--recipent", "x"]), /unknown argument --recipent/);
  assert.throws(() => parseArgs(["cards", "--ceremony", "c", "--issue", "3"]), /cards does not take --issue/);
  assert.throws(() => parseArgs(["check-share", "--share", "a"]), /does not take --share/);
  assert.throws(() => parseArgs(["split"]), /usage/);
});

// ── typing words ─────────────────────────────────────────────────────────────

test("expandWords: four letters are enough, card numbers are ignored, a wrong prefix is refused", () => {
  const list = ["academic", "acid", "acne", "always"];
  assert.deepEqual(expandWords("1 acad  2 ACID\n3 acne 4 alwa", list), ["academic", "acid", "acne", "always"]);
  assert.deepEqual(expandWords("academic", list), ["academic"]);
  assert.throws(() => expandWords("aca", list), /at least the first four letters/);
  assert.throws(() => expandWords("acadx", list), /not on the SLIP-39 word list/, "acadx must not be read as academic");
  assert.throws(() => expandWords("zebra", list), /word 1 "zebra" is not on the SLIP-39 word list/);
});

// ── SLIP-39, through the reference implementation ────────────────────────────

test("the SLIP-39 word list: 1024 words, unique by their first four letters", { skip: slipSkip }, () => {
  const list = wordlist();
  assert.equal(list.length, 1024);
  assert.equal(new Set(list.map((w) => w.slice(0, 4))).size, 1024);
});

test("splitAndVerify: three 33-word shares of one set, and every pair rebuilds the identity", { skip: slipSkip }, () => {
  const [{ shares: s }] = splitAndVerify([{ key: ceremony().keys[0], identity: IDENTITY }]);
  assert.equal(s.length, 3);
  for (const share of s) assert.equal(share.length, WORDS_PER_SHARE);
  assert.deepEqual(setIdOf(s[1]), setIdOf(s[0]));
  assert.deepEqual(setIdOf(s[2]), setIdOf(s[0]));
  for (const [a, b] of PAIRS) assert.equal(secretToIdentity(combine([s[a], s[b]])), IDENTITY);
  assert.deepEqual(s.map((share) => inspectShare(share).number), [1, 2, 3]);
});

test("a single share is checked on its own: a wrong word or a swap fails its checksum", { skip: slipSkip }, () => {
  const [{ shares: s }] = splitAndVerify([{ key: ceremony().keys[0], identity: IDENTITY }]);
  const list = wordlist();
  const wrong = [...s[0]];
  wrong[10] = list[(list.indexOf(wrong[10]) + 1) % list.length];
  assert.throws(() => inspectShare(wrong), /checksum/);
  const swapped = [...s[0]];
  const i = swapped.findIndex((w, k) => k > 3 && w !== swapped[k + 1]);
  [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
  assert.throws(() => inspectShare(swapped), /checksum/);
});

test("shares from two different splits refuse to combine", { skip: slipSkip }, () => {
  const [{ shares: first }] = splitAndVerify([{ key: ceremony().keys[0], identity: IDENTITY }]);
  const [{ shares: second }] = splitAndVerify([{ key: ceremony().keys[0], identity: IDENTITY }]);
  assert.throws(() => combine([first[0], second[1]]), /don't match/);
});
