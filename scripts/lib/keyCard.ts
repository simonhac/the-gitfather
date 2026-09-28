// ─────────────────────────────────────────────────────────────────────────────
// The key-holder card: one A4 page per holder, carrying THAT holder's SLIP-39 share of every
// escrowed key, plus what it is, who else holds a share, and what to do when it is needed.
//
// Pure: it renders HTML from the ceremony and one holder's words, and nothing else. The renderer is
// handed only the shares it prints, so a card cannot leak another holder's words however the
// template changes. The HTML loads nothing external (system fonts, inline CSS, inline SVG) because it
// holds a secret and is printed by a headless browser.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const DEFAULT_RUNBOOK = "github.com/simonhac/the-gitfather/blob/main/docs/key-escrow.md";

const Holder = z
  .object({
    name: z.string().min(1),
    role: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
  })
  .strict();

const EscrowKey = z
  .object({
    title: z.string().min(1),
    blurb: z.string().optional(),
    /** The env var holding the identity (the key itself or a path to a key file) at ceremony time. */
    "identity-env": z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "an environment variable name"),
    /** The public recipient the identity must derive — the ceremony refuses to split anything else. */
    recipient: z.string().regex(/^age1[02-9ac-hj-np-z]{58}$/, "an age1… X25519 recipient"),
  })
  .strict();

export const CeremonySchema = z
  .object({
    org: z.string().min(1),
    system: z.string().default("Postgres backups"),
    /** Printed as-is; defaults to today. */
    date: z.string().optional(),
    /** Printed on every card so holders can tell which issue is current; defaults to today's ISO date. */
    issue: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/, "a short label, e.g. 2026-09-28 or 3").optional(),
    runbook: z.string().default(DEFAULT_RUNBOOK),
    holders: z.array(Holder).length(3, "2-of-3 escrow needs exactly three holders"),
    keys: z.array(EscrowKey).min(1).max(2, "a card holds at most two keys"),
  })
  .strict()
  .refine((c) => new Set(c.keys.map((k) => k.recipient)).size === c.keys.length, "the same recipient is listed twice");

export type Ceremony = z.infer<typeof CeremonySchema>;
export type CeremonyKey = Ceremony["keys"][number];

/** What one card shows for one key: this holder's words, and the set they belong to. */
export interface CardKey {
  key: CeremonyKey;
  words: string[];
  setId: string[];
}

/**
 * `live` cards hold the real keys. `test` cards hold a throwaway key made for a recovery drill: same
 * holders, same procedure, nothing real at stake — so a drill can be run whenever it is wanted. They
 * are coloured and watermarked differently so the two can never be confused in a drawer.
 */
export type CardMode = "live" | "test";

export interface CardOpts {
  /** 1-based share number, which is also the holder's position in the ceremony. */
  n: number;
  date: string;
  issue: string;
  mode: CardMode;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The card prints a recipient abbreviated; `recover` accepts the same form (see recipientMatches). */
export function shortRecipient(r: string): string {
  return `${r.slice(0, 10)}…${r.slice(-8)}`;
}

/** True when `given` is the full recipient, or the card's abbreviated `age1xxxxxx…yyyyyyyy` form of it. */
export function recipientMatches(full: string, given: string): boolean {
  const g = given.trim();
  const m = g.match(/^(age1[a-z0-9]{6,})(?:…|\.\.\.)([a-z0-9]{6,})$/);
  if (m) return full.startsWith(m[1]) && full.endsWith(m[2]);
  return full === g;
}

export function cardFilename(org: string, n: number, issue: string, mode: CardMode): string {
  const slug = org.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "keys";
  return `${slug}-${mode === "test" ? "practice" : "recovery"}-share-${n}-of-3-issue-${issue}.pdf`;
}

/** Three tokens in a row; this holder's is filled. */
function trio(n: number): string {
  const tokens = [1, 2, 3]
    .map((i) => {
      const x = 12 + (i - 1) * 26;
      const mine = i === n;
      return `<circle cx="${x}" cy="12" r="10.5" class="${mine ? "me" : "other"}"/><text x="${x}" y="15.6" class="${mine ? "me-t" : "other-t"}">${i}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 76 24" width="86" height="27" aria-hidden="true">${tokens}</svg>`;
}

function wordGrid(words: string[]): string {
  // Column-major: down column 1, then 2, then 3 — the order a person copies them in. The first four
  // letters are bold because they alone identify a SLIP-39 word.
  const rows = Math.ceil(words.length / 3);
  const cells: string[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < 3; c++) {
      const i = c * rows + r;
      const w = words[i];
      cells.push(
        w === undefined
          ? `<div></div>`
          : `<div class="w"><span class="n">${i + 1}</span><span class="t"><b>${esc(w.slice(0, 4))}</b>${esc(w.slice(4))}</span></div>`,
      );
    }
  return `<div class="grid">${cells.join("")}</div>`;
}

export function renderCard(ceremony: Ceremony, cardKeys: CardKey[], opts: CardOpts): string {
  const { n, issue } = opts;
  const test = opts.mode === "test";
  const me = ceremony.holders[n - 1];
  const others = ceremony.holders.map((h, i) => ({ ...h, n: i + 1 })).filter((h) => h.n !== n);
  const two = cardKeys.length === 2;
  const contact = (h: { phone?: string; email?: string }) => [h.phone, h.email].filter(Boolean).map((s) => esc(s!)).join(" · ");

  const panels = cardKeys
    .map(
      (ck, ki) => `
    <section class="panel">
      <header>
        <div class="kicker">${two ? `Secret ${ki + 1} of 2` : "Secret"}</div>
        <h3>${esc(ck.key.title)}</h3>
        ${ck.key.blurb ? `<p>${esc(ck.key.blurb)}</p>` : ""}
      </header>
      ${wordGrid(ck.words)}
      <dl>
        <div><dt>Set</dt><dd class="mono">${esc(ck.setId.join(" "))} · share ${n}</dd></div>
        <div><dt>Unlocks</dt><dd class="mono">${esc(shortRecipient(ck.key.recipient))}</dd></div>
      </dl>
    </section>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(ceremony.org)} — recovery share ${n} of 3</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --ink: #16202e; --soft: #5a6573; --rule: #d9dde3; --accent: ${test ? "#1f6a8a" : "#b4532a"}; --wash: ${test ? "#edf3f6" : "#f6f3ee"}; }
  html, body { width: 210mm; height: 297mm; }
  body { font: 9.2pt/1.45 "Avenir Next", "Helvetica Neue", Arial, sans-serif; color: var(--ink); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { position: relative; width: 210mm; height: 297mm; padding: 13mm 15mm 11mm; display: flex; flex-direction: column; gap: 4.6mm; }
  /* Only the watermark is clipped. Anything else that overflows spills onto a second page, which
     key-shares refuses — a card must never lose its bottom lines silently. */
  .clip { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 5; }
  .sample { position: absolute; top: 44%; left: 50%; transform: translate(-50%, -50%) rotate(-28deg); font: 700 58pt "Avenir Next", Arial, sans-serif; letter-spacing: .08em; color: rgba(31, 106, 138, .10); white-space: nowrap; }
  .mono { font-family: "SF Mono", Menlo, "DejaVu Sans Mono", monospace; font-size: 8pt; letter-spacing: .01em; }

  .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1.4pt solid var(--ink); padding-bottom: 4mm; }
  .eyebrow { font-size: 7.6pt; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); }
  h1 { font: 500 28pt/1.05 "Iowan Old Style", Georgia, serif; margin-top: 2.2mm; letter-spacing: -.01em; }
  h1 em { font-style: italic; color: var(--accent); }
  .who { margin-top: 2.4mm; color: var(--soft); }
  .who strong { color: var(--ink); font-weight: 600; }
  .badge { text-align: center; padding-top: 1mm; }
  .badge svg circle { stroke-width: 1.3; }
  .badge .me { fill: var(--accent); stroke: var(--accent); fill-opacity: .92; }
  .badge .other { fill: none; stroke: var(--ink); stroke-dasharray: 2.2 1.8; }
  .badge text { font: 600 9pt "Avenir Next", Arial, sans-serif; text-anchor: middle; }
  .badge .me-t { fill: #fff; } .badge .other-t { fill: var(--soft); }
  .badge small { display: block; font-size: 6.8pt; letter-spacing: .12em; text-transform: uppercase; color: var(--soft); margin-top: .6mm; }
  .kind { display: inline-block; vertical-align: middle; margin-left: 3mm; position: relative; top: -1.6mm; font: 700 7.4pt "Avenir Next", Arial, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #fff; background: var(--accent); border-radius: 1mm; padding: .7mm 2.2mm; }
  .who .id { font: 8.4pt "SF Mono", Menlo, "DejaVu Sans Mono", monospace; color: var(--ink); }

  .intro { display: grid; grid-template-columns: 1.55fr 1fr; gap: 8mm; }
  .intro h2, .foot h2 { font: 600 7.6pt "Avenir Next", Arial, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: var(--soft); margin-bottom: 1.6mm; }
  .lede { font: 10.4pt/1.42 "Iowan Old Style", Georgia, serif; }
  .lede p + p { margin-top: 1.4mm; }
  .people { list-style: none; }
  .people li { padding: 1.6mm 0; border-top: .6pt solid var(--rule); }
  .people li:last-child { border-bottom: .6pt solid var(--rule); }
  .people .nm { font-weight: 600; }
  .people .nm span { font-weight: 400; color: var(--soft); }
  .people .ct { color: var(--soft); font-size: 8.4pt; }

  .panels { display: grid; grid-template-columns: repeat(${cardKeys.length}, 1fr); gap: 6mm; }
  .panel { background: var(--wash); border-radius: 2.5mm; padding: 4mm 4.4mm 3.4mm; display: flex; flex-direction: column; gap: 2.8mm; }
  .kicker { font-size: 7pt; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); }
  .panel h3 { font: 500 15pt/1.15 "Iowan Old Style", Georgia, serif; margin-top: .6mm; }
  .panel header p { color: var(--soft); font-size: 8.4pt; margin-top: .6mm; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); column-gap: 2.4mm; row-gap: 1mm; }
  .w { display: flex; align-items: baseline; gap: 1.4mm; background: #fff; border: .5pt solid var(--rule); border-radius: 1mm; padding: .8mm 1.6mm; }
  .w .n { font: 600 6.6pt "Avenir Next", Arial, sans-serif; color: var(--soft); min-width: 3.4mm; text-align: right; font-variant-numeric: tabular-nums; }
  .w .t { font: 9.4pt "SF Mono", Menlo, "DejaVu Sans Mono", monospace; letter-spacing: .01em; color: #3c4655; }
  .w .t b { font-weight: 700; color: var(--ink); }
  .panel dl { display: grid; gap: .8mm; border-top: .6pt solid var(--rule); padding-top: 2.4mm; }
  .panel dl div { display: flex; gap: 2mm; }
  .panel dt { width: 13mm; flex: none; font-size: 7pt; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--soft); padding-top: .4mm; }
  .note { font-size: 7.8pt; color: var(--soft); margin-top: -2.4mm; }
  .note b { color: var(--ink); font-weight: 600; }

  .foot { display: grid; grid-template-columns: 1.15fr 1fr; gap: 8mm; }
  ol.steps { list-style: none; counter-reset: s; }
  ol.steps li { counter-increment: s; position: relative; padding-left: 6.2mm; margin-bottom: 1.1mm; }
  ol.steps li::before { content: counter(s); position: absolute; left: 0; top: .2mm; width: 4.2mm; height: 4.2mm; border-radius: 50%; background: var(--ink); color: #fff; font: 600 6.8pt/4.2mm "Avenir Next", Arial, sans-serif; text-align: center; }
  ul.rules { list-style: none; }
  ul.rules li { padding-left: 5mm; position: relative; margin-bottom: 1mm; }
  ul.rules li::before { position: absolute; left: 0; font-weight: 700; }
  ul.rules li.do::before { content: "✓"; color: #2f6b45; }
  ul.rules li.dont::before { content: "✕"; color: var(--accent); }

  .sign { margin-top: auto; display: grid; grid-template-columns: 1fr 1fr 1.1fr; gap: 8mm; align-items: end; border-top: 1.4pt solid var(--ink); padding-top: 3.4mm; }
  .line { border-bottom: .7pt solid var(--ink); height: 7mm; }
  .cap { font-size: 7pt; letter-spacing: .1em; text-transform: uppercase; color: var(--soft); margin-top: 1.2mm; }
  .verified { display: flex; gap: 2mm; align-items: flex-start; font-size: 7.8pt; color: var(--soft); }
  .verified i { flex: none; font-style: normal; font-weight: 700; color: #2f6b45; }
  .colophon { display: flex; justify-content: space-between; font-size: 7pt; color: var(--soft); margin-top: -2.2mm; }
</style></head><body><div class="page">
  ${test ? `<div class="clip"><div class="sample">PRACTICE · NOT A REAL KEY</div></div>` : ""}

  <div class="top">
    <div>
      <div class="eyebrow">${esc(ceremony.org)} · ${esc(ceremony.system)} · ${test ? "Practice drill" : "Recovery key"}</div>
      <h1>Share <em>${n}</em> of 3<span class="kind">${test ? "Practice" : "Live"}</span></h1>
      <div class="who">Held by <strong>${esc(me.name)}</strong>${me.role ? ` · ${esc(me.role)}` : ""} · issue <span class="id">${esc(issue)}</span>, ${esc(opts.date)}</div>
    </div>
    <div class="badge">${trio(n)}<small>any two of three</small></div>
  </div>

  <div class="intro">
    <div>
      <h2>What this is</h2>
      <div class="lede">${
        test
          ? `
        <p>This is a <strong>practice card</strong> for a recovery drill. Its words rebuild a throwaway test key that protects nothing — so the drill can be run for real, with nothing at stake.</p>
        <p>It works exactly like the live card: <strong>any two</strong> of the three holders can rebuild the key, one at a time, without meeting. Keep it until the drill is done, then destroy it.</p>`
          : `
        <p>${esc(ceremony.org)}’s backups are locked with ${two ? "secret keys" : "a secret key"}. This page holds <strong>one third</strong> of ${two ? "each — two sets of words, one for each key" : "it, as a set of words"}.</p>
        <p>On its own, this page is useless: it reveals nothing about the ${two ? "keys" : "key"}. <strong>Any two</strong> of the three holders, together, can rebuild ${two ? "them" : "it"} — so if the usual copy is ever lost, the backups can still be opened.</p>`
      }
      </div>
    </div>
    <div>
      <h2>The other holders</h2>
      <ul class="people">${others
        .map((h) => `<li><div class="nm">${esc(h.name)} <span>· share ${h.n}</span></div>${contact(h) ? `<div class="ct">${contact(h)}</div>` : ""}</li>`)
        .join("")}</ul>
    </div>
  </div>

  <div class="panels">${panels}</div>
  <div class="note">Copy the words exactly, in order. The <b>first four letters</b> of each word are enough to identify it.</div>

  <div class="foot">
    <div>
      <h2>${test ? "In the drill" : "If the key is ever needed"}</h2>
      <ol class="steps">
        <li>You’ll be contacted. <strong>Any two</strong> holders are needed — not together, and not at the same time.</li>
        <li>Give your words for the key named, in person or by phone. Check the <em>Set</em> words and issue first.</li>
        <li>Each share is checked as you give it, so a slip is caught while you’re still talking.</li>
        <li>With two holders’ words it rebuilds the key, confirms the <em>Unlocks</em> code, and decrypts ${test ? "the drill file" : "a backup"} to prove it.</li>
      </ol>
    </div>
    <div>
      <h2>Keeping it safe</h2>
      <ul class="rules">
        <li class="do">Keep this sheet on paper, in a safe or with your important documents.</li>
        <li class="do">Tell someone you trust where it is.</li>
        <li class="dont">Don’t photograph, scan, email or message these words, or type them anywhere online.</li>
        <li class="dont">Don’t keep it with another holder’s share.</li>
      </ul>
    </div>
  </div>

  <div class="sign">
    <div><div class="line"></div><div class="cap">Received by ${esc(me.name)}</div></div>
    <div><div class="line"></div><div class="cap">Date</div></div>
    <div class="verified"><i>✓</i><span>Every pair of shares was test-recovered and rebuilt ${two ? "both keys" : "the key"} exactly when this card was made, ${esc(opts.date)}.</span></div>
  </div>
  <div class="colophon"><span>${
    test ? `Practice issue ${esc(issue)} · unlocks nothing real · destroy after the drill` : `Live issue ${esc(issue)} · replaces all earlier live cards — destroy them`
  } · SLIP-39 2-of-3</span><span>${esc(ceremony.runbook)}</span></div>
</div></body></html>`;
}
