// ─────────────────────────────────────────────────────────────────────────────
// Typed subprocess helpers for the ported backup/drill/staleness scripts.
//
// Two distinct concerns, because the data plane is multi-GB:
//   • DATA-PLANE (pg_dump / age / pg_restore / rclone download): use spawn() wired
//     to OS file descriptors and pipes so bytes NEVER transit the V8 heap. The shell
//     equivalents (`pg_dump > out`, `pg_dump | age > out`) buffer nothing; neither do
//     runToFile()/pipeToFile() here. (execFileSync's default 1 MiB maxBuffer would
//     throw on a real dump — see runlog.ts, which only ever handles tiny outputs.)
//   • CONTROL-PLANE (rclone lsf/cat/copyto of jsonl + small objects, gh, psql counts):
//     small, bounded output — capture() via execFileSync, mirroring runlog.ts:28-35.
//
// `set -euo pipefail` fidelity: each helper resolves a numeric exit code; pipeToFile()
// awaits BOTH children and reports failure if EITHER is non-zero (Node has no pipefail).
// Best-effort `|| true` legs are modelled by bestEffort(); fatal `|| fail` legs stay the
// caller's responsibility (each script owns a fatal() that records ❌ then process.exit(1)).
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, execFileSync, execSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";

type Env = NodeJS.ProcessEnv;

/** True if `cmd` is on PATH — replaces the scripts' `command -v X >/dev/null`. */
export function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn `cmd args`, inheriting stdio by default, and resolve with the exit code. NEVER
 * rejects: a non-zero exit resolves that code, and a spawn-time error (ENOENT/EACCES/fork
 * failure) is logged and resolved as 127. This keeps the bash `cmd … || fail` contract — the
 * caller's `if (code !== 0) await fail(...)` runs for BOTH a non-zero exit and a spawn error,
 * so a failure can never bypass the ❌-tick / alert / runlog discipline via an uncaught reject.
 */
export function run(
  cmd: string,
  args: string[],
  opts: { env?: Env; stdio?: "inherit" | "ignore" } = {},
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: opts.stdio ?? "inherit", env: opts.env ?? process.env });
    child.on("error", (e) => {
      process.stderr.write(`${cmd}: ${(e as Error).message}\n`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * `cmd args > outPath` — stdout streamed straight to a file descriptor (no buffering),
 * stderr inherited. Resolves the exit code (127 on a spawn error, like run()); never rejects,
 * so the caller's `if (code !== 0) await fail(...)` always runs. The fd is always closed.
 */
export function runToFile(cmd: string, args: string[], outPath: string, env: Env = process.env): Promise<number> {
  const fd = openSync(outPath, "w");
  return new Promise((resolve) => {
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      try {
        closeSync(fd);
      } catch {
        /* fd may already be gone */
      }
      resolve(code);
    };
    const child = spawn(cmd, args, { stdio: ["ignore", fd, "inherit"], env });
    child.on("error", (e) => {
      process.stderr.write(`${cmd}: ${(e as Error).message}\n`);
      done(127);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}

/**
 * `a aArgs | b bArgs > outPath` with pipefail semantics. Spawns both children, wires
 * a.stdout → b.stdin and b.stdout → the file fd, awaits BOTH, and resolves the FIRST non-zero
 * exit code (0 only if both succeed). This is the safety-critical piece: `age` exits 0 on a
 * truncated stream, so checking only the right-hand process would mask a pg_dump failure (the
 * MIN_BYTES floor in the caller is the second line of defence). A spawn-time error on either
 * child kills the other and resolves 127 — never rejects, so fail() still runs.
 */
export function pipeToFile(
  a: { cmd: string; args: string[] },
  b: { cmd: string; args: string[] },
  outPath: string,
  env: Env = process.env,
): Promise<number> {
  const fd = openSync(outPath, "w");
  return new Promise((resolve) => {
    let settled = false;
    let aCode: number | null = null;
    let bCode: number | null = null;
    let closed = 0;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      resolve(code);
    };

    const left = spawn(a.cmd, a.args, { stdio: ["ignore", "pipe", "inherit"], env });
    const right = spawn(b.cmd, b.args, { stdio: ["pipe", fd, "inherit"], env });

    if (left.stdout && right.stdin) {
      // If `right` dies first, swallow the resulting EPIPE on the left's stdout rather
      // than crashing the process with an unhandled 'error'.
      left.stdout.on("error", () => {});
      left.stdout.pipe(right.stdin);
    }

    left.on("error", (e) => {
      process.stderr.write(`${a.cmd}: ${(e as Error).message}\n`);
      try {
        right.kill();
      } catch {
        /* ignore */
      }
      finish(127);
    });
    right.on("error", (e) => {
      process.stderr.write(`${b.cmd}: ${(e as Error).message}\n`);
      try {
        left.kill();
      } catch {
        /* ignore */
      }
      finish(127);
    });

    const maybeDone = () => {
      if (closed === 2) finish(aCode ? aCode : (bCode ?? 0)); // pipefail: leftmost non-zero wins
    };
    left.on("close", (code) => {
      aCode = code ?? 1;
      closed++;
      maybeDone();
    });
    right.on("close", (code) => {
      bCode = code ?? 1;
      closed++;
      maybeDone();
    });
  });
}

/**
 * Run `cmd args` and capture its stdout — for rclone lsf/cat/copyto and psql counts. Returns
 * ok=false (not a throw) on non-zero so the caller can distinguish "command ran, empty result"
 * from "command failed". stderr is suppressed (mirrors the bash control-plane `2>/dev/null`),
 * and maxBuffer is raised to 256 MiB so a long-retention recursive `rclone lsf -R` listing
 * cannot trip the default 1 MiB limit (which would masquerade as an empty bucket). Do NOT use
 * this for a dump-sized stream — that path uses runToFile/pipeToFile.
 */
export function capture(cmd: string, args: string[], env: Env = process.env): { ok: boolean; out: string } {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, {
        encoding: "utf8",
        env,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    };
  } catch (e) {
    const err = e as { stdout?: Buffer | string };
    return { ok: false, out: err.stdout ? err.stdout.toString() : "" };
  }
}

/**
 * Run a best-effort side-channel action (Slack tick, run-log append, heartbeat ping).
 * Its failure is logged to stderr and swallowed — it can NEVER change the process exit
 * code (the `… || true` discipline from the bash scripts). Returns the result or
 * undefined on failure.
 */
export async function bestEffort<T>(label: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    process.stderr.write(`${label}: non-fatal failure: ${(e as Error).message ?? e}\n`);
    return undefined;
  }
}
