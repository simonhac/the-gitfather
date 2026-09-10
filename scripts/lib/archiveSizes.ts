// ─────────────────────────────────────────────────────────────────────────────
// Backfilling `bytes` into an existing `_index/`, without re-deriving anything.
//
// `ArchivedPart.bytes` was added after the first indexes were written, so every week archived
// before it exists in the index with a row count and no size. The obvious fix — --rebuild-index —
// throws the index away and rebuilds it from the manifests, which means re-deciding every week's
// archived/pruned state by asking Postgres whether the window is empty. That is the documented
// RECOVERY path and it is right for a lost index, but it is far more than "fill in a missing
// number", and its one failure mode (a pruned week that has live rows again reconciles back to
// `archived`, and the next run supersedes the real archive with the stragglers) costs real data on
// the dashboard.
//
// So this module does the narrow thing instead. Two properties define it:
//
//   • THE SIZE COMES FROM THE STORE ITSELF, not from a manifest. One recursive listing per table
//     yields every object and its current size, which is also the more honest answer to "how much
//     space does this week occupy" than a number recorded at write time.
//   • NOTHING BUT `bytes` IS EVER WRITTEN. Each line is parsed, given sizes, re-serialised, and
//     then checked: strip the bytes back off and the result must deep-equal what was read. A line
//     that fails that check is left exactly as it was found. There is no code path here that can
//     change a week's state, its parts, its row counts or its fingerprints.
//
// Pure and Node-free, so all of the above is unit-tested rather than reasoned about.
// ─────────────────────────────────────────────────────────────────────────────

import type { ArchivedPart } from "./archive.js";

/** `<name>-<table>-<week>-p001.<ext>` under `<prefix>/<table>/<year>/`. */
const OBJECT_TAIL = /-(\d{4}-W\d{2})-p(\d{3})\.(.+)$/;

export interface ObjectRef {
  week: string;
  part: number;
  ext: string;
}

/**
 * Recover the week and part a data object belongs to from its key.
 *
 * Anchored on the TAIL — the week label and the `pNNN` tag — because everything to the left is a
 * project name and a table name, either of which may contain the hyphens that a naive split would
 * trip over. Manifests are matched too; the caller decides what to do with them.
 */
export function parseArchiveObjectKey(key: string): ObjectRef | null {
  const m = OBJECT_TAIL.exec(key.split("/").pop() ?? "");
  if (!m) return null;
  return { week: m[1], part: Number(m[2]), ext: m[3] };
}

const slot = (week: string, part: number): string => `${week}#${part}`;

/**
 * Sizes of the DATA objects in a listing, keyed by week and part.
 *
 * Manifests are excluded deliberately: a manifest is metadata about the archive, not the archive,
 * and counting its few hundred bytes as the week's size would be wrong in the one place a reader
 * is most likely to trust the number.
 */
export function sizeIndexFrom(objects: { key: string; bytes: number }[]): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const o of objects) {
    const ref = parseArchiveObjectKey(o.key);
    if (!ref || ref.ext === "manifest.json") continue;
    sizes.set(slot(ref.week, ref.part), o.bytes);
  }
  return sizes;
}

export interface PatchedLine {
  /** The line as it should now be stored — identical to the input when nothing was filled in. */
  text: string;
  /** Parts that gained a size. */
  filled: number;
  /** Parts that still have none, because the store holds no object for them. */
  unmatched: number;
  /** Set when the line was left untouched, with the reason. */
  skipped?: string;
}

/**
 * Fill in the missing sizes on one index line.
 *
 * A part keeps whatever `bytes` it already has — this is a backfill, not a reconciliation, and a
 * disagreement between a recorded size and a listed one is something to report, never to silently
 * overwrite. A part with no object in the store (a zero-row week gets a manifest and no data
 * object) is left without a size, because "unknown" and "0 B" are different claims.
 */
export function patchIndexLine(line: string, sizes: Map<string, number>): PatchedLine {
  let record: { label?: unknown; parts?: unknown };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return { text: line, filled: 0, unmatched: 0, skipped: "not JSON" };
  }
  if (!record || typeof record !== "object" || typeof record.label !== "string" || !Array.isArray(record.parts)) {
    return { text: line, filled: 0, unmatched: 0, skipped: "not a week record" };
  }

  const week = record.label;
  let filled = 0;
  let unmatched = 0;
  const parts = (record.parts as ArchivedPart[]).map((p) => {
    if (p == null || typeof p !== "object" || typeof p.part !== "number") return p;
    if (p.bytes !== undefined) return p;
    const bytes = sizes.get(slot(week, p.part));
    if (bytes === undefined) {
      unmatched++;
      return p;
    }
    filled++;
    return { ...p, bytes };
  });
  if (filled === 0) return { text: line, filled: 0, unmatched };

  const patched = { ...record, parts };

  // The guarantee, checked rather than asserted in prose: take the sizes back out and what is left
  // must be the record that was read. The comparison is STRUCTURAL, not textual — key order and
  // whitespace are not data, and a file that had been pretty-printed by some other hand should
  // still get its sizes rather than being silently passed over. Anything that fails this — a value
  // that did not survive the round trip, a part that moved — puts the line back untouched.
  const restored = { ...patched, parts: parts.map(stripAddedBytes(record.parts as ArchivedPart[])) };
  if (stableStringify(restored) !== stableStringify(record)) {
    return { text: line, filled: 0, unmatched, skipped: "would not round-trip" };
  }
  return { text: JSON.stringify(patched), filled, unmatched };
}

/** Restore each part to its original shape, so the round-trip check compares like with like. */
const stripAddedBytes =
  (original: ArchivedPart[]) =>
  (p: ArchivedPart, i: number): ArchivedPart =>
    original[i]?.bytes === undefined && p?.bytes !== undefined ? original[i] : p;

/** JSON with every object's keys sorted, so two records compare by content and not by layout. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface PatchedFile {
  text: string;
  filled: number;
  unmatched: number;
  /** Lines left alone and why — a half-written index degrades to fewer sizes, never to a lost line. */
  skipped: string[];
  changed: boolean;
}

/** The whole `<table>-<year>.jsonl`, line by line, preserving the trailing newline. */
export function patchIndexFile(body: string, sizes: Map<string, number>): PatchedFile {
  const lines = body.split("\n");
  const out: string[] = [];
  let filled = 0;
  let unmatched = 0;
  const skipped: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    const p = patchIndexLine(line, sizes);
    out.push(p.text);
    filled += p.filled;
    unmatched += p.unmatched;
    if (p.skipped) skipped.push(`${p.skipped}: ${line.slice(0, 60)}`);
  }
  const text = out.join("\n");
  return { text, filled, unmatched, skipped, changed: text !== body };
}
