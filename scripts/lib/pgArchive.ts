// ─────────────────────────────────────────────────────────────────────────────
// The archiver's Postgres side: every statement it issues, and nothing else.
//
// Like the rest of the engine there is NO Postgres driver — this shells out to `psql` through
// proc.ts, with the password isolated into a 0600 PGPASSFILE by pgconn.ts so it never reaches a
// child's argv or environment. Timestamps are always bound as psql variables (-v start=…), never
// interpolated into SQL text; the SQL itself is built by archive.ts and unit-tested there.
//
// Two divisions of labour worth knowing:
//   • DATA PLANE — extract() alone can be gigabytes, so it streams psql's stdout straight to a
//     file descriptor (runToFile) and never lets a byte through the V8 heap.
//   • CONTROL PLANE — the scalar queries (oldest row, fingerprint, one delete batch) return a
//     line or two, so they use capture().
//
// deleteWindow() is the only method that writes, and it is deliberately awkward to misuse: it
// takes the row count the caller expects, refuses to exceed it, and reports what it actually
// removed so the caller can assert agreement.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runToFile } from "./proc.js";
import { pgConn, type PgConn } from "./pgconn.js";
import {
  oldestRowSql,
  fingerprintSql,
  extractSql,
  deleteBatchSql,
  anomalousWeeksSql,
  type Fingerprint,
  type IsoWeek,
} from "./archive.js";

/** psql args shared by every scalar query: no psqlrc, quiet, tuples-only, unaligned, stop on error. */
const SCALAR_FLAGS = ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"];

export class PgArchiveError extends Error {}

/**
 * Run psql and capture stdout AND stderr.
 *
 * proc.ts's capture() deliberately discards stderr (the control-plane `2>/dev/null` idiom), but a
 * failing query here is nearly undiagnosable without the server's message — "psql failed" tells you
 * nothing about which of a dozen expressions was malformed. The output is a SQL error, never a
 * credential: the password lives in PGPASSFILE and never reaches argv or the environment.
 */
function psqlCapture(args: string[], env: NodeJS.ProcessEnv): { ok: boolean; out: string; err: string } {
  try {
    const out = execFileSync("psql", args, {
      encoding: "utf8",
      env,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out, err: "" };
  } catch (e) {
    const x = e as { stdout?: Buffer | string; stderr?: Buffer | string };
    return { ok: false, out: x.stdout?.toString() ?? "", err: (x.stderr?.toString() ?? "").trim() };
  }
}

export class PgArchive {
  private readonly conn: PgConn;

  constructor(url: string, private readonly workDir: string) {
    this.conn = pgConn(url, workDir);
  }

  cleanup(): void {
    this.conn.cleanup();
  }

  /**
   * Run a scalar query through a temp FILE, not `-c`.
   *
   * psql's -c takes "a command string that is completely parsable by the server", which means it
   * does NOT perform psql variable interpolation — `:'start'` would arrive at the backend verbatim
   * and fail with a syntax error. Since binding the window through variables (rather than pasting
   * timestamps into SQL text) is the whole point, every query goes via -f.
   */
  private scalar(sql: string, vars: Record<string, string> = {}): string {
    const scriptPath = join(this.workDir, "scalar.sql");
    writeFileSync(scriptPath, `${sql};\n`, { mode: 0o600 });
    const varArgs = Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]);
    const res = psqlCapture([this.conn.safeUrl, ...SCALAR_FLAGS, ...varArgs, "-f", scriptPath], this.conn.env);
    if (!res.ok) throw new PgArchiveError(`psql failed: ${res.err || sql.slice(0, 120)}`);
    // ON_ERROR_STOP makes psql exit non-zero on a server error, but a \-command problem can still
    // print to stderr while exiting 0 — treat any stderr output as a failure rather than parsing junk.
    if (res.err) throw new PgArchiveError(`psql reported: ${res.err}`);
    return res.out.trim();
  }

  /** The oldest row's timestamp, or null when the table is empty. */
  oldestRowAt(table: string, timeColumn: string): Date | null {
    const out = this.scalar(oldestRowSql(table, timeColumn));
    return out === "" ? null : new Date(out);
  }

  /**
   * The live (count, digest) for a window. This is the value the prune gate compares against the
   * manifest — recomputed immediately before any delete, never cached from the archive step.
   */
  fingerprint(table: string, timeColumn: string, week: IsoWeek): Fingerprint {
    const out = this.scalar(fingerprintSql(table, timeColumn), {
      start: week.start.toISOString(),
      end: week.end.toISOString(),
    });
    const [n, digest] = out.split(/\s+/);
    if (!/^\d+$/.test(n ?? "") || !/^[0-9a-f]{16}$/.test(digest ?? "")) {
      throw new PgArchiveError(`unexpected fingerprint output for ${week.label}: "${out}"`);
    }
    return { n: Number(n), digest };
  }

  /** ISO week labels holding rows older than `watermark` — the post-prune anomaly sweep. */
  anomalousWeeks(table: string, timeColumn: string, watermark: Date): string[] {
    const out = this.scalar(anomalousWeeksSql(table, timeColumn), { watermark: watermark.toISOString() });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  /**
   * Stream one week's rows to `outPath` as NDJSON. The script goes through a temp file rather than
   * -c because it carries \pset/\o meta-commands that only psql's script mode understands.
   */
  async extract(table: string, timeColumn: string, week: IsoWeek, outPath: string, fetchCount = 1000): Promise<void> {
    const scriptPath = join(this.workDir, `extract-${week.label}.sql`);
    writeFileSync(scriptPath, extractSql(table, timeColumn, fetchCount), { mode: 0o600 });
    const code = await runToFile(
      "psql",
      [
        this.conn.safeUrl,
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        `start=${week.start.toISOString()}`,
        "-v",
        `end=${week.end.toISOString()}`,
        "-f",
        scriptPath,
      ],
      outPath,
      this.conn.env,
    );
    if (code !== 0) throw new PgArchiveError(`psql extract failed (exit ${code}) for ${week.label}`);
  }

  /**
   * Delete a window in bounded batches, returning the number of rows actually removed.
   *
   * Stops on the first empty batch, and refuses to remove more than `expectRows` — if the window
   * somehow holds more than the archive recorded, that is precisely the state where deleting is
   * unsafe, so it aborts with what it has done so far rather than pressing on. The caller asserts
   * the returned count equals `expectRows`.
   */
  async deleteWindow(opts: {
    table: string;
    timeColumn: string;
    week: IsoWeek;
    batchRows: number;
    expectRows: number;
    onBatch?: (deletedSoFar: number) => void;
  }): Promise<number> {
    const { table, timeColumn, week, batchRows, expectRows, onBatch } = opts;
    if (expectRows === 0) return 0;

    let total = 0;
    // Bounded by expectRows/batchRows; the +2 leaves room for the terminating empty batch.
    const maxBatches = Math.ceil(expectRows / batchRows) + 2;
    for (let i = 0; i < maxBatches; i++) {
      const remaining = expectRows - total;
      if (remaining <= 0) break;
      const size = Math.min(batchRows, remaining);
      const out = this.scalar(deleteBatchSql(table, timeColumn, size), {
        start: week.start.toISOString(),
        end: week.end.toISOString(),
      });
      const deleted = Number(out);
      if (!Number.isInteger(deleted)) throw new PgArchiveError(`unexpected delete output for ${week.label}: "${out}"`);
      if (deleted === 0) break;
      total += deleted;
      onBatch?.(total);
    }
    return total;
  }
}
