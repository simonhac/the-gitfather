// ─────────────────────────────────────────────────────────────────────────────
// The archive `_index/` reader — the dashboard's second source, and the only one
// that knows what happened to a week's ROWS as opposed to how a run went.
//
//   <store-prefix>/<table>/_index/<table>-<year>.jsonl   one WeekRecord per line
//
// It lives under the ARCHIVE store prefix, not `_log/`, so it needs its own fetch: the run-log
// download (logStore.ts) only ever copies `_log/<name>/*.jsonl`. This module mirrors that pair —
// a pure directory reader and an rclone download over the `r2` remote — rather than inventing a
// second fetch idiom.
//
// Node-only (child_process + fs). Everything the BROWSER sees goes through scrubArchiveWeek, which
// is pure and is the whole privacy surface: fingerprints, digests, part numbers and roles never
// leave the private bucket.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activePart, type WeekState } from "./archive.js";
import type { PublicArchiveWeek } from "./backupTypes.js";

const warn = (msg: string): void => void process.stderr.write(`${msg}\n`);

/**
 * One private index line reduced to what the dashboard may say out loud: the week, its state, and
 * how many rows it holds. `rows` is the ACTIVE part's count — the highest-numbered `full` part, per
 * archive.ts — because supplements describe rows that arrived late, not a snapshot of the window.
 *
 * Pure, and tested as such: it is the only thing standing between the private index and a public
 * page, so "no digest ever reaches the payload" is a unit test rather than a code review.
 */
export function scrubArchiveWeek(table: string, record: unknown): PublicArchiveWeek | null {
  if (!record || typeof record !== "object") return null;
  const rec = record as Partial<WeekState>;
  if (typeof rec.label !== "string") return null;
  if (rec.state !== "archived" && rec.state !== "pruned") return null;
  const parts = Array.isArray(rec.parts) ? rec.parts : [];
  return { table, week: rec.label, state: rec.state, rows: activePart(parts)?.rowCount ?? 0 };
}

/**
 * Parse one table's `_index/` directory. Tolerates a missing directory and skips malformed lines,
 * exactly as readLogDir does: a half-written index must degrade to fewer weeks on the page, never
 * to a failed build.
 *
 * A week may be rewritten in place (the index is a materialised view, not a log), so a later line
 * for the same label wins.
 */
export function readIndexDir(dir: string, table: string): PublicArchiveWeek[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const byWeek = new Map<string, PublicArchiveWeek>();
  for (const f of files.filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n").map((s) => s.trim()).filter(Boolean)) {
      let week: PublicArchiveWeek | null = null;
      try {
        week = scrubArchiveWeek(table, JSON.parse(line));
      } catch {
        /* skip malformed line */
      }
      if (week) byWeek.set(week.week, week);
    }
  }
  return [...byWeek.values()];
}

/**
 * The whole `_index/` for every table, from R2 over the `r2` remote (configured from
 * `RCLONE_CONFIG_R2_*` by the caller — there is no rclone.conf on disk).
 *
 * The WHOLE directory is copied, not a guessed year: a 52-week window straddling New Year touches
 * three ISO years, and the files are a few dozen bytes per week.
 *
 * **Fails soft, per table.** A missing `_index/` (rclone exit 3) is an ordinary state — that table
 * has never been archived — and anything else is reported as a warning naming the credential scope,
 * because the likeliest cause is a token that can read `_log/` but not the archive prefix. Either
 * way the dashboard renders with runs only, and the archive BODY is what goes missing, not the page.
 */
export function downloadArchiveIndexFromR2(
  bucket: string,
  storePrefix: string,
  tables: string[],
): PublicArchiveWeek[] {
  const dest = mkdtempSync(join(tmpdir(), "pg-index-"));
  const weeks: PublicArchiveWeek[] = [];
  for (const table of tables) {
    const from = `r2:${bucket}/${storePrefix}/${table}/_index/`;
    const into = join(dest, table);
    try {
      execFileSync("rclone", ["copy", from, into, "--include", "*.jsonl", "--s3-no-check-bucket"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 3) {
        console.log(`dashboard: no _index/ for ${table} — runs only`);
      } else {
        warn(
          `dashboard: WARNING could not read ${from} (rclone exit ${status ?? "?"}). ` +
            `The archive columns will show runs but no row states. Check that R2_ACCESS_KEY_ID ` +
            `covers the archive store prefix, not just _log/.`,
        );
      }
      continue;
    }
    weeks.push(...readIndexDir(into, table));
  }
  return weeks;
}

/** The `--logdir` twin: `<logdir>/_index/<table>/*.jsonl`, silent when there is nothing there. */
export function readArchiveIndexDir(logdir: string, tables: string[]): PublicArchiveWeek[] {
  return tables.flatMap((table) => readIndexDir(join(logdir, "_index", table), table));
}
