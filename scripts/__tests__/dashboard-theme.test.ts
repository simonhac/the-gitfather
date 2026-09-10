import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cellOps, type BodyClass } from "../lib/cellGlyph.js";
import { summarizeOutcomes, NO_MARK } from "../lib/outcomes.js";

// The renderer's colours are CSS classes now, which is what lets the theme switch recolour a grid
// that has already been drawn. The cost of that is a seam: a class the SVG emits but the stylesheet
// does not name is an INVISIBLE cell, and it fails silently — the page still builds, still renders,
// and simply has a hole in it. These tests read the template as text and close that seam.
//
// theme.ts is not imported here: it touches `document` at call time, and this is a Node process.
// The one thing that must agree across the boundary — the storage key — is asserted as a literal.

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "../../dashboard/template.html");
const html = readFileSync(TEMPLATE, "utf8");
/** THEME_KEY in dashboard/theme.ts. Deliberately duplicated: that is the agreement being tested. */
const THEME_KEY = "gitfather:theme";

test("the pre-paint script runs before the stylesheet, or a dark reader gets a white flash", () => {
  const script = html.indexOf(`localStorage.getItem("${THEME_KEY}")`);
  assert.ok(script > 0, "pre-paint script reads THEME_KEY");
  assert.ok(script < html.indexOf("<style>"), "and it does so before <style>");
  assert.ok(script < html.indexOf("<body>"), "from inside <head>");
});

test("the pre-paint script only ever honours a forced theme, and cannot throw", () => {
  const line = html.split("\n").find((l) => l.includes(`localStorage.getItem("${THEME_KEY}")`))!;
  assert.match(line, /try\{/, "wrapped — localStorage THROWS when site data is blocked");
  assert.match(line, /catch\(e\)\{\}/);
  assert.match(line, /t==="light"\|\|t==="dark"/, "an unrecognised value must fall through to Auto");
  assert.match(line, /setAttribute\("data-theme",\s*t\)/);
});

test("both forced themes pin color-scheme, and no attribute means Auto", () => {
  assert.match(html, /:root\s*\{[^}]*color-scheme:\s*light dark/, "the default follows the OS");
  assert.match(html, /:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light/);
  assert.match(html, /:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark/);
});

test("no stylesheet rule resolves a palette at load — every colour token is declared once", () => {
  // A `@media (prefers-color-scheme)` block that re-declares a COLOUR is the old two-block form
  // creeping back; shadows are not colours, so they are the one thing allowed to use it.
  const media = html.match(/@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?\n {2}\}/g) ?? [];
  for (const block of media) {
    const declared = [...block.matchAll(/(--[a-z-]+):/g)].map((m) => m[1]);
    for (const token of declared) {
      assert.match(token, /shadow/, `${token} must use light-dark(), not a second block`);
    }
  }
});

// Every class cellOps() can emit, plus the chrome classes the renderer hardcodes. If the glyph
// gains a body colour and the stylesheet does not, this is what says so.
const BODIES: BodyClass[] = ["b-ok", "b-verified", "b-expired", "b-archived", "b-pruned"];
const CHROME = ["backdrop", "gridline", "axis", "moat", "cell-hit", "dot", "theme-btn", "header-text",
                // The rule between an archive tooltip's two halves is the anti-ambiguity device, so
                // it is chrome the renderer depends on, not decoration.
                "tip-rule"];

test("every class the glyph can emit has a selector in the template", () => {
  const emitted = new Set<string>();
  for (const body of [...BODIES, null]) {
    for (const m of [NO_MARK, summarizeOutcomes(["ok"]), summarizeOutcomes(["attention"]),
                     summarizeOutcomes(["failed"]), summarizeOutcomes(["failed", "ok"])]) {
      for (const op of cellOps(body, m)) emitted.add(op.cls);
    }
  }
  // The glyph must be able to reach all of them, or this test is checking less than it looks.
  for (const cls of [...BODIES, "moat", "m-ok", "m-attention", "m-failed"]) {
    assert.ok(emitted.has(cls), `cellOps() should be able to emit .${cls}`);
  }
  for (const cls of [...emitted, ...CHROME]) {
    assert.ok(html.includes(`.${cls}`), `template.html has no rule for .${cls}`);
  }
});

test("every body and mark class colours the SVG and the tooltip from one declaration", () => {
  // One rule, two properties: `fill` for the grid, `background-color` for the tooltip's dots. Two
  // separate rules would be two places for the palette to drift.
  for (const cls of [...BODIES, "m-ok", "m-attention", "m-failed"]) {
    const rule = html.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`))?.[1];
    assert.ok(rule, `no rule for .${cls}`);
    assert.match(rule, /fill:\s*var\(--/, `.${cls} must set fill from a token`);
    assert.match(rule, /background-color:\s*var\(--/, `.${cls} must set background-color from a token`);
  }
});

// ── Palette separation ───────────────────────────────────────────────────────

/** WCAG relative luminance of a #rrggbb literal. */
function luminance(hex: string): number {
  const ch = (i: number): number => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
}
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** The two `light-dark()` arms of a token, as hex literals. */
function arms(token: string): [string, string] {
  const m = html.match(new RegExp(`${token}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`));
  assert.ok(m, `${token} must be declared as light-dark() of two hex literals`);
  return [m![1], m![2]];
}

/** Each ordinal ramp: its lesser step, its stronger step. */
const RAMPS: [string, string][] = [["--ok", "--verified"], ["--archived", "--pruned"]];

test("each ramp's two steps are a real step apart — the stronger one must LOOK like the stronger claim", () => {
  // Within a ramp the two steps are the same shape in the same column, so colour is the only thing
  // carrying "a drill proved this one restores" / "and the rows are gone from the database". One
  // step apart and they read as a single colour on the published page, which is why this floor
  // exists. It is a floor on the PAIR, deliberately, not on either value.
  for (const [lesser, stronger] of RAMPS) {
    const [aL, aD] = arms(lesser);
    const [bL, bD] = arms(stronger);
    assert.ok(ratio(aL, bL) >= 3, `light ${lesser}/${stronger}: ${aL} vs ${bL} is ${ratio(aL, bL).toFixed(2)}:1`);
    assert.ok(ratio(aD, bD) >= 3, `dark ${lesser}/${stronger}: ${aD} vs ${bD} is ${ratio(aD, bD).toFixed(2)}:1`);
  }
});

test("…and the lesser step still stands off the grid it sits on", () => {
  // The other side of the trade, and the reason both tests have to exist: the floor above is
  // satisfiable by dimming the lesser step until it vanishes into the surface, at which point a
  // week WITH data looks like a week without. 2.1 is under the 3:1 AA wants of a graphical object —
  // knowingly, see template.html: these are steps of an ordinal scale read as a field, and buying
  // AA here costs the separation that carries the actual information. What must not happen is the
  // number drifting further without anyone deciding to.
  const [surfL, surfD] = arms("--surface");
  for (const [lesser] of RAMPS) {
    const [aL, aD] = arms(lesser);
    assert.ok(ratio(aL, surfL) >= 2.1, `light ${lesser}: ${aL} on ${surfL} is ${ratio(aL, surfL).toFixed(2)}:1`);
    assert.ok(ratio(aD, surfD) >= 2.1, `dark ${lesser}: ${aD} on ${surfD} is ${ratio(aD, surfD).toFixed(2)}:1`);
  }
});

test("every token a rule reads is actually declared", () => {
  // A declaration is `--x:`; a read is `var(--x)` and is never followed by a colon, so a plain
  // global match separates the two without caring how the stylesheet is wrapped.
  const declared = new Set([...html.matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1]));
  // Only reads WITHOUT a fallback have to be declared here. `var(--beak-x, 20px)` is set from JS
  // per tooltip, and its fallback is the author saying so — that is not a missing token.
  const used = new Set([...html.matchAll(/var\((--[a-z-]+)\s*\)/g)].map((m) => m[1]));
  for (const token of used) assert.ok(declared.has(token), `var(${token}) is used but never declared`);
});
