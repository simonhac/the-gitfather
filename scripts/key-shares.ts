// ─────────────────────────────────────────────────────────────────────────────
// 2-of-3 KEY ESCROW for the age identities that decrypt the backups — see docs/key-escrow.md.
//
// A backup nobody can decrypt is not a backup. While the identity lives in exactly one password
// vault, losing that vault (or its owner) loses every encrypted object. This splits each identity
// into three SLIP-39 shares — 33 English words each — any two of which rebuild it, and prints one
// A4 card per holder carrying that holder's share of every key.
//
//   cards        the LIVE ceremony. Reads each identity from the env var its ceremony file names,
//                refuses unless it derives the recipient the file pins, splits it, PROVES every pair
//                of shares rebuilds it exactly, and prints the three cards to PDF.
//                  AGE_IDENTITY="$(op read 'op://<vault>/<item>/AGE_IDENTITY')" \
//                  AGE_ARCHIVE_IDENTITY="$(op read 'op://<vault>/<item>/AGE_ARCHIVE_IDENTITY')" \
//                    npm run key-shares -- cards --ceremony ceremony.yaml [--out <dir>]
//   practice     a PRACTICE issue for a recovery drill: the same holders and layout, but throwaway
//                keys, practice-coloured cards, and one encrypted drill file per key for the drill to
//                open. Needs no real key, so it can be run whenever a drill is wanted.
//                  npm run key-shares -- practice --ceremony ceremony.yaml [--issue <label>] [--out <dir>]
//   demo         `practice` with built-in sample holders — to show someone what a card looks like.
//   drill        prove the RECOVERY KIT is complete (recovery-kit.ts): make a throwaway practice issue,
//                then run the whole recovery — rebuild both keys from two holders' shares, open a
//                zstd+age archive file, restore an encrypted dump — in a container with --network none
//                and nothing but the kit. Needs Docker (or OrbStack, Podman: DOCKER=<binary>).
//                  npm run key-shares -- drill --kit <dir> [--image python:3.12-bookworm]
//   check-share  check ONE holder's words on their own (word list + checksum) and say which share
//                of which set they are. Prints the words to stdout when redirected, so a share given
//                today can be kept until the second holder is reachable — one share reveals nothing.
//                  npm run key-shares -- check-share > share-from-alex.txt
//   recover      rebuild ONE key from two shares, typed now and/or saved earlier by check-share;
//                prints the identity only if it derives the recipient given (the full age1…, or the
//                abbreviated Unlocks code printed on the card).
//                  npm run key-shares -- recover --recipient 'age1q8x3w5…x0sa4mv7' \
//                    [--share share-from-alex.txt] > identity.txt
//
// The Shamir arithmetic runs in the SLIP-39 reference implementation (lib/slip39.ts), not here;
// this script is the ceremony around it. Secrets travel over stdin, never argv. The HTML each card is
// printed from is written to a private temp dir and deleted (headless Chrome already runs on a
// throwaway profile of its own); the PDFs themselves are secret — print them, then delete them.
//
// Needs: age + age-keygen, Python 3 with `shamir-mnemonic` (SLIP39_PYTHON), and Chrome/Chromium
// (CHROME) for the commands that print cards; `drill` needs zstd and Docker instead of Chrome.
// ─────────────────────────────────────────────────────────────────────────────

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { identityToSecret, readIdentity, recipientOf, secretToIdentity } from "./lib/ageKey.js";
import {
  CeremonySchema,
  cardFilename,
  recipientMatches,
  renderCard,
  type CardMode,
  type Ceremony,
  type CeremonyKey,
} from "./lib/keyCard.js";
import { commandExists } from "./lib/proc.js";
import { MANIFEST_PATH, checkLocalKit, loadManifest } from "./recovery-kit.js";
import { WORDS_PER_SHARE, combine, expandWords, inspectShare, setIdOf, split, wordlist } from "./lib/slip39.js";

export type Command =
  | { cmd: "cards"; ceremony: string; out?: string }
  | { cmd: "practice"; ceremony: string; issue?: string; out?: string }
  | { cmd: "demo"; out?: string }
  | { cmd: "drill"; kit: string; image: string }
  | { cmd: "check-share" }
  | { cmd: "recover"; recipient: string; shares: string[] };

const FLAGS = ["--ceremony", "--out", "--recipient", "--issue", "--share", "--kit", "--image"];

/**
 * The offline drill's container: a stock OS image with Python 3 and a C toolchain, which is what the
 * kit's README asks a stranger to have. Nothing else in it is used.
 */
export const DRILL_IMAGE = "python:3.12-bookworm";

/** Pure, and exported so the argument grammar is testable without a key. */
export function parseArgs(argv: string[]): Command {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string> = {};
  const shares: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!FLAGS.includes(a)) throw new Error(`unknown argument ${a}`);
    const v = rest[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    if (a === "--share") shares.push(v);
    else flags[a.slice(2)] = v;
  }
  const only = (allowed: string[]) => {
    const extra = [...Object.keys(flags), ...(shares.length ? ["share"] : [])].filter((k) => !allowed.includes(k));
    if (extra.length) throw new Error(`${cmd} does not take --${extra.join(", --")}`);
  };
  switch (cmd) {
    case "cards":
      only(["ceremony", "out"]);
      if (!flags.ceremony) throw new Error("cards needs --ceremony <file.yaml>");
      return { cmd, ceremony: flags.ceremony, out: flags.out };
    case "practice":
      only(["ceremony", "issue", "out"]);
      if (!flags.ceremony) throw new Error("practice needs --ceremony <file.yaml> (the live one: its holders are reused)");
      return { cmd, ceremony: flags.ceremony, issue: flags.issue, out: flags.out };
    case "demo":
      only(["out"]);
      return { cmd, out: flags.out };
    case "drill":
      only(["kit", "image"]);
      if (!flags.kit) throw new Error("drill needs --kit <dir> (a kit from `npm run recovery-kit -- build`)");
      return { cmd, kit: flags.kit, image: flags.image ?? DRILL_IMAGE };
    case "check-share":
      only([]);
      return { cmd };
    case "recover":
      only(["recipient", "share"]);
      if (!flags.recipient) throw new Error("recover needs --recipient <age1…> (the Unlocks code on the card is enough)");
      if (shares.length > 2) throw new Error("recover takes at most two --share files");
      return { cmd, recipient: flags.recipient, shares };
    default:
      throw new Error(
        "usage: key-shares cards|practice --ceremony <file> [--issue <label>] [--out <dir>] | demo | check-share | recover --recipient <age1…> [--share <file>]… | drill --kit <dir> [--image <image>]",
      );
  }
}

export interface Escrowed {
  key: CeremonyKey;
  identity: string;
}

export interface SplitKey {
  key: CeremonyKey;
  /** shares[i] is holder i+1's words. */
  shares: string[][];
}

/** Every 2-of-3 combination, as share indexes. */
export const PAIRS: [number, number][] = [
  [0, 1],
  [0, 2],
  [1, 2],
];

/**
 * Split each identity 2-of-3 and PROVE it before anything is printed: every pair of shares must
 * rebuild the identity byte-for-byte. A card that has not been through this is a card that might
 * not work on the one day it is needed.
 */
export function splitAndVerify(escrowed: Escrowed[]): SplitKey[] {
  return escrowed.map(({ key, identity }) => {
    const shares = split(identityToSecret(identity), 2, 3);
    if (shares.length !== 3 || shares.some((s) => s.length !== WORDS_PER_SHARE)) {
      throw new Error(`${key.title}: expected 3 shares of ${WORDS_PER_SHARE} words`);
    }
    for (const [a, b] of PAIRS) {
      const rebuilt = secretToIdentity(combine([shares[a], shares[b]]));
      if (rebuilt !== identity) throw new Error(`${key.title}: shares ${a + 1}+${b + 1} did not rebuild the identity`);
    }
    return { key, shares };
  });
}

/** Pages in a PDF, by counting page objects. 0 means "could not tell" (e.g. compressed object streams). */
export function countPdfPages(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page(?![a-z])/g) ?? []).length;
}

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  for (const c of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) if (commandExists(c)) return c;
  throw new Error("Chrome/Chromium not found — set CHROME to its binary");
}

function today(): { display: string; iso: string } {
  const d = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
  return {
    display: d.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }),
    iso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Split, verify and print. Returns the output directory. */
function makeCards(ceremony: Ceremony, escrowed: Escrowed[], opts: { out?: string; mode: CardMode; issue?: string }): string {
  for (const { key, identity } of escrowed) {
    const derived = recipientOf(identity);
    if (derived !== key.recipient) {
      throw new Error(`${key["identity-env"]} derives ${derived}, not the ${key.title} recipient ${key.recipient} — refusing to escrow the wrong key`);
    }
  }
  const split = splitAndVerify(escrowed);
  console.error(`✓ split ${split.length} key(s) 2-of-3; all ${PAIRS.length} pairs rebuild each one exactly`);

  const out = resolve(opts.out ?? mkdtempSync(join(tmpdir(), "key-cards-")));
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const date = ceremony.date ?? today().display;
  const issue = opts.issue ?? ceremony.issue ?? today().iso;
  const chrome = findChrome();
  const scratch = mkdtempSync(join(tmpdir(), "key-cards-html-"));
  const written: string[] = [];
  try {
    for (const n of [1, 2, 3]) {
      const html = join(scratch, `card-${n}.html`);
      const cardKeys = split.map((s) => ({ key: s.key, words: s.shares[n - 1], setId: setIdOf(s.shares[n - 1]) }));
      writeFileSync(html, renderCard(ceremony, cardKeys, { n, date, issue, mode: opts.mode }), { mode: 0o600 });
      const pdf = join(out, cardFilename(ceremony.org, n, issue, opts.mode));
      written.push(pdf);
      execFileSync(
        chrome,
        ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--no-pdf-header-footer", `--print-to-pdf=${pdf}`, pathToFileURL(html).href],
        { stdio: "ignore", timeout: 60_000 },
      );
      const pages = countPdfPages(readFileSync(pdf));
      if (pages > 1) throw new Error(`card ${n} ran onto ${pages} pages — shorten the ceremony text`);
      console.error(`  share ${n} → ${ceremony.holders[n - 1].name}: ${pdf}`);
    }
  } catch (e) {
    // An incomplete issue is worse than none: nobody should be handed card 1 of a set whose card 3
    // was never made.
    for (const f of written) rmSync(f, { force: true });
    throw e;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const s of split) console.error(`  ${s.key.title}: set "${setIdOf(s.shares[0]).join(" ")}", unlocks ${s.key.recipient}`);
  console.error(`\n⚠ These PDFs are secret. Print them, get each to its holder by hand or courier (never email), then delete them.`);
  return out;
}

function loadCeremony(path: string): Ceremony {
  return CeremonySchema.parse(parseYaml(readFileSync(path, "utf8")));
}

function cards(ceremonyPath: string, out?: string): void {
  const ceremony = loadCeremony(ceremonyPath);
  const escrowed = ceremony.keys.map((key) => {
    const value = process.env[key["identity-env"]];
    if (!value) throw new Error(`${key["identity-env"]} is not set (the ${key.title} identity, or a path to it)`);
    return { key, identity: readIdentity(value) };
  });
  makeCards(ceremony, escrowed, { out, mode: "live" });
}

function freshIdentity(): { identity: string; recipient: string } {
  const r = spawnSync("age-keygen", [], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`age-keygen failed: ${r.stderr || r.error?.message}`);
  const identity = readIdentity(r.stdout);
  return { identity, recipient: recipientOf(identity) };
}

/**
 * A practice issue: the ceremony's holders and key titles, but a throwaway key for each, so the
 * whole drill — collecting two holders' words, rebuilding, decrypting — can run with nothing real at
 * stake. Alongside the cards goes one small file per key, encrypted to that practice key: opening it
 * is how the drill proves the rebuilt key works. The drill files are not secret.
 */
function practice(base: Ceremony, opts: { issue?: string; out?: string }): void {
  const keys = base.keys.map((key) => ({ key, ...freshIdentity() }));
  const ceremony: Ceremony = { ...base, keys: keys.map(({ key, recipient }) => ({ ...key, recipient })) };
  const issue = opts.issue ?? `P-${today().iso}`;
  const out = makeCards(
    ceremony,
    keys.map((k, i) => ({ key: ceremony.keys[i], identity: k.identity })),
    { out: opts.out, mode: "test", issue },
  );
  for (const key of ceremony.keys) {
    const file = join(out, `drill-${slug(key.title)}-issue-${issue}.txt.age`);
    const r = spawnSync("age", ["-r", key.recipient, "-o", file], {
      input: `Practice issue ${issue}: the ${key.title} was rebuilt from two holders' shares and opened this file.\n`,
    });
    if (r.status !== 0) throw new Error(`age failed writing ${file}: ${r.stderr}`);
    console.error(`  drill file for the ${key.title}: ${file}`);
  }
}

function demo(out?: string): void {
  const sample = CeremonySchema.parse({
    org: "Example Co",
    holders: [
      { name: "Alex Example", role: "Director", phone: "+61 400 000 001", email: "alex@example.com" },
      { name: "Bea Sample", role: "Engineering lead", phone: "+61 400 000 002", email: "bea@example.com" },
      { name: "Casey Demo", role: "External accountant", phone: "+61 400 000 003", email: "casey@example.com" },
    ],
    // Placeholders: practice() replaces each recipient with a fresh throwaway key's.
    keys: [
      { title: "Daily backups key", blurb: "Opens the daily, weekly and monthly database backups.", "identity-env": "AGE_IDENTITY", recipient: `age1${"q".repeat(58)}` },
      { title: "Archive key", blurb: "Opens the long-term archives of old table rows.", "identity-env": "AGE_ARCHIVE_IDENTITY", recipient: `age1${"p".repeat(58)}` },
    ],
  });
  practice(sample, { out });
}

/** Which holders' shares the offline drill hands over: not the first two, so it is not the easy case. */
export const DRILL_HOLDERS: [number, number] = [0, 2];

/**
 * The practice issue for the offline drill, as files: for each key, two holders' shares (one per line,
 * as `shamir recover` reads them) and the recipient the rebuilt key must derive. Plus an archive file
 * made the way table archives are — rows, zstd, then age — so the kit's zstd has something real to
 * decompress. The keys are throwaway and are never written here; only their shares are.
 */
function writeDrillIssue(dir: string, sentinel: string): void {
  const keys = (["dump", "archive"] as const).map((name) => {
    const { identity, recipient } = freshIdentity();
    const key: CeremonyKey = { title: `Practice ${name} key`, blurb: "", "identity-env": "", recipient };
    return { name, recipient, split: splitAndVerify([{ key, identity }])[0] };
  });
  for (const { name, recipient, split } of keys) {
    writeFileSync(join(dir, `shares-${name}.txt`), DRILL_HOLDERS.map((h) => `${split.shares[h].join(" ")}\n`).join(""));
    writeFileSync(join(dir, `holders-${name}.txt`), DRILL_HOLDERS.map((h) => h + 1).join(" and "));
    writeFileSync(join(dir, `recipient-${name}.txt`), recipient);
  }
  writeFileSync(join(dir, "sentinel.txt"), sentinel);
  const rows = `${JSON.stringify({ id: 1, note: sentinel })}\n${JSON.stringify({ id: 2, note: "second row" })}\n`;
  const zst = spawnSync("zstd", ["-q", "-c"], { input: rows });
  if (zst.status !== 0) throw new Error(`zstd failed: ${zst.stderr}`);
  const archive = keys.find((k) => k.name === "archive")!;
  const enc = spawnSync("age", ["-r", archive.recipient, "-o", join(dir, "drill-archive.ndjson.zst.age")], { input: zst.stdout });
  if (enc.status !== 0) throw new Error(`age failed: ${enc.stderr}`);
}

function findDocker(): string {
  if (process.env.DOCKER) return process.env.DOCKER;
  for (const c of ["docker", "podman"]) if (commandExists(c)) return c;
  const orb = "/Applications/OrbStack.app/Contents/MacOS/xbin/docker";
  if (existsSync(orb)) return orb;
  throw new Error("the offline drill needs Docker (or OrbStack, or Podman) — set DOCKER to its binary if it is not on PATH");
}

/**
 * Prove the recovery kit is complete: run recovery-kit/offline-drill.sh in a container with no
 * network, the kit and the practice issue mounted read-only. The script follows the kit's README;
 * if the kit is missing anything a recovery needs, a step fails.
 */
function drill(kitDir: string, image: string): void {
  const kit = resolve(kitDir);
  checkLocalKit(kit, loadManifest());
  const docker = findDocker();
  const dir = mkdtempSync(join(tmpdir(), "kit-drill-"));
  try {
    const sentinel = `practice issue P-${today().iso}-${process.pid}`;
    writeDrillIssue(dir, sentinel);
    copyFileSync(join(dirname(MANIFEST_PATH), "offline-drill.sh"), join(dir, "offline-drill.sh"));
    console.error(`✓ practice issue: two throwaway keys, shares ${DRILL_HOLDERS.map((h) => h + 1).join(" and ")} of each, in ${dir}`);
    console.error(`  running the recovery in ${image} with --network none…`);
    // The image is pulled (with the network) before the run; the container itself never has one.
    // initdb refuses to run as root, so the drill runs as an ordinary user created for it.
    const r = spawnSync(
      docker,
      [
        "run", "--rm", "--network", "none",
        "-v", `${kit}:/kit:ro`, "-v", `${dir}:/drill:ro`,
        image, "bash", "-c", "useradd -m drill && runuser -u drill -- bash /drill/offline-drill.sh",
      ],
      { stdio: "inherit" },
    );
    if (r.error) throw new Error(`${docker}: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`the offline drill FAILED (exit ${r.status}) — the kit is missing something a recovery needs, or its README is wrong`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Parse one share's words and check it on its own. Throws a message fit to show the person typing. */
function checkShare(typed: string, list: string[]): { words: string[]; number: number } {
  const words = expandWords(typed, list);
  if (words.length !== WORDS_PER_SHARE) throw new Error(`a share is ${WORDS_PER_SHARE} words; got ${words.length}`);
  const { number, threshold } = inspectShare(words);
  if (threshold !== 2) throw new Error(`this share is from a ${threshold}-of-N set, not one of ours (2-of-3)`);
  return { words, number };
}

function describe(words: string[], number: number): string {
  return `share ${number}, set "${setIdOf(words).join(" ")}"`;
}

/**
 * Collect one share interactively, a few words per line. Each line is checked against the word list
 * as it is typed, so a misspelling is caught on the line it happened; the share's checksum is checked
 * the moment the 33rd word is in, so a wrong-but-real word is caught while the holder is still there.
 */
async function promptShare(rl: Interface, label: string, list: string[]): Promise<{ words: string[]; number: number }> {
  console.error(`\n${label}: type the ${WORDS_PER_SHARE} words for this key, a few per line (the first four letters of each is enough).`);
  for (;;) {
    const typed: string[] = [];
    while (typed.length < WORDS_PER_SHARE) {
      const line = await rl.question(`  words ${typed.length + 1}–: `);
      try {
        typed.push(...expandWords(line, list));
      } catch (e) {
        console.error(`  ✕ ${(e as Error).message.replace(/^word \d+/, "on that line,")} — re-type that line`);
      }
    }
    try {
      return checkShare(typed.join(" "), list);
    } catch (e) {
      console.error(`  ✕ ${(e as Error).message}\n  Something was copied wrongly — read the words back from the card and start this share again.`);
    }
  }
}

async function checkShareCmd(): Promise<void> {
  const list = wordlist();
  let share: { words: string[]; number: number };
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      share = await promptShare(rl, "The holder", list);
    } finally {
      rl.close();
    }
  } else {
    share = checkShare(readFileSync(0, "utf8"), list);
  }
  console.error(`✓ valid: ${describe(share.words, share.number)}. On its own it reveals nothing about the key.`);
  if (!process.stdout.isTTY) process.stdout.write(`${share.words.join(" ")}\n`);
  else console.error("  (redirect stdout to a file to keep it until the second holder's words are in)");
}

async function recover(recipient: string, shareFiles: string[]): Promise<void> {
  const list = wordlist();
  const shares = shareFiles.map((f) => {
    const s = checkShare(readFileSync(f, "utf8"), list);
    console.error(`✓ ${f}: ${describe(s.words, s.number)}`);
    return s;
  });
  const needed = 2 - shares.length;
  if (needed > 0) {
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        for (let i = 0; i < needed; i++) {
          const s = await promptShare(rl, shares.length ? "The second holder" : "The first holder", list);
          console.error(`  ✓ ${describe(s.words, s.number)}`);
          shares.push(s);
        }
      } finally {
        rl.close();
      }
    } else {
      const words = expandWords(readFileSync(0, "utf8"), list);
      if (words.length !== needed * WORDS_PER_SHARE) {
        throw new Error(`expected ${needed * WORDS_PER_SHARE} words on stdin (${needed} share(s)), got ${words.length}`);
      }
      for (let i = 0; i < needed; i++) shares.push(checkShare(words.slice(i * WORDS_PER_SHARE, (i + 1) * WORDS_PER_SHARE).join(" "), list));
    }
  }
  const [a, b] = shares.map((s) => setIdOf(s.words).join(" "));
  if (a !== b) throw new Error(`these shares are from different sets ("${a}" and "${b}") — a different key, or a different issue of the cards`);
  if (shares[0].number === shares[1].number) {
    throw new Error(`both are share ${shares[0].number} — the same holder's words twice; a second holder is needed`);
  }
  const identity = secretToIdentity(combine(shares.map((s) => s.words)));
  const derived = recipientOf(identity);
  if (!recipientMatches(derived, recipient)) {
    throw new Error(`the rebuilt key unlocks ${derived}, not ${recipient} — are both shares for that key?`);
  }
  console.error(`✓ rebuilt the key for ${derived}`);
  process.stdout.write(`# public key: ${derived}\n${identity}\n`);
}

async function main(): Promise<void> {
  const c = parseArgs(process.argv.slice(2));
  if (c.cmd === "cards") cards(c.ceremony, c.out);
  else if (c.cmd === "practice") practice(loadCeremony(c.ceremony), c);
  else if (c.cmd === "demo") demo(c.out);
  else if (c.cmd === "drill") drill(c.kit, c.image);
  else if (c.cmd === "check-share") await checkShareCmd();
  else await recover(c.recipient, c.shares);
}

/** Only run when invoked directly — importing this module for tests must not touch a key. */
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
