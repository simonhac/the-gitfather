// ─────────────────────────────────────────────────────────────────────────────
// The object-store seam for the archiver: one small interface, three implementations.
//
//   R2Store          — rclone against the real bucket (the production sink)
//   LocalStore       — the same operations against a directory (test the whole pipeline
//                      end-to-end, with real bytes, before pointing it at R2)
//   SuppressedStore  — a decorator that records intended writes and performs none
//                      (--dry-run=store)
//
// WRITE-ONCE IS ENFORCED IN CODE, ON BOTH SINKS. In production the real guarantees are
// external — a scoped R2 token with no delete permission, unique never-reused keys, and a
// bucket lock over the data prefixes. None of those exist on a local directory, so LocalStore
// refuses to overwrite too; otherwise local testing would quietly diverge from the behaviour
// it is supposed to be rehearsing. putTextOverwrite() is the single, named exception, and it
// exists only for the derived _index/ file (see archive.ts → indexObjectKey).
//
// A DELIBERATE ASYMMETRY IN exists(): a missing object and an unreachable store are NOT the
// same answer, and conflating them is dangerous here — "absent" makes the planner write a
// fresh part, so a network blip could re-archive a week or mis-number a part. So exists()
// lists the parent directory and tests membership (the same trick runlog.ts uses), and a
// listing failure THROWS rather than reporting false.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdirSync, existsSync, copyFileSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { capture, run } from "./proc.js";

let seq = 0; // unique staging filenames when several small writes share one process

export class ObjectExistsError extends Error {
  constructor(key: string) {
    super(`refusing to overwrite an existing object: ${key}`);
    this.name = "ObjectExistsError";
  }
}

export class StoreUnreachableError extends Error {
  constructor(detail: string) {
    super(`object store unreachable: ${detail}`);
    this.name = "StoreUnreachableError";
  }
}

export interface Store {
  readonly kind: "r2" | "local";
  /** Human-readable sink description for logs (never contains a credential). */
  readonly describe: string;
  exists(key: string): Promise<boolean>;
  /** Upload a local file. Throws ObjectExistsError if the key is taken. */
  put(localPath: string, key: string): Promise<void>;
  /** Upload a small text object. Throws ObjectExistsError if the key is taken. */
  putText(text: string, key: string): Promise<void>;
  /** The ONE write that may replace an existing object — the derived _index/ file. */
  putTextOverwrite(text: string, key: string): Promise<void>;
  /** Download an object to a local path (verification re-reads). */
  fetchToFile(key: string, localPath: string): Promise<void>;
  /** Object body as text, or null when the key does not exist. */
  cat(key: string): Promise<string | null>;
  /** Every key under `prefix`, recursively. Empty when the prefix holds nothing. */
  list(prefix: string): Promise<string[]>;
}

// ── --target parsing ─────────────────────────────────────────────────────────

export type Target = { kind: "r2" } | { kind: "local"; dir: string };

/**
 * "r2" (or unset) → R2; "local:<dir>" → the filesystem sink. Anything else throws rather than
 * falling back to R2 — a typo'd target must never silently write to production.
 */
export function parseTarget(spec: string | undefined): Target {
  if (spec === undefined || spec === "r2") return { kind: "r2" };
  const m = /^local:(.+)$/.exec(spec ?? "");
  if (m) return { kind: "local", dir: m[1] };
  throw new Error(`invalid --target "${spec}" — expected "r2" or "local:<dir>"`);
}

// ── LocalStore ───────────────────────────────────────────────────────────────

export class LocalStore implements Store {
  readonly kind = "local" as const;
  readonly describe: string;

  constructor(private readonly root: string) {
    this.describe = `local:${root}`;
  }

  private path(key: string): string {
    return join(this.root, ...key.split("/"));
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.path(key));
  }

  async put(localPath: string, key: string): Promise<void> {
    const dest = this.path(key);
    if (existsSync(dest)) throw new ObjectExistsError(key);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(localPath, dest);
  }

  async putText(text: string, key: string): Promise<void> {
    const dest = this.path(key);
    if (existsSync(dest)) throw new ObjectExistsError(key);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }

  async putTextOverwrite(text: string, key: string): Promise<void> {
    const dest = this.path(key);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }

  async fetchToFile(key: string, localPath: string): Promise<void> {
    mkdirSync(dirname(localPath), { recursive: true });
    copyFileSync(this.path(key), localPath);
  }

  async cat(key: string): Promise<string | null> {
    const p = this.path(key);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  async list(prefix: string): Promise<string[]> {
    const base = this.path(prefix);
    if (!existsSync(base)) return [];
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else out.push(relative(this.root, full).split(sep).join("/"));
      }
    };
    if (statSync(base).isDirectory()) walk(base);
    else out.push(relative(this.root, base).split(sep).join("/"));
    return out;
  }
}

// ── R2Store ──────────────────────────────────────────────────────────────────

/**
 * rclone against R2. The remote itself is configured purely from RCLONE_CONFIG_<REMOTE>_*
 * environment variables by the calling task (the-gitfather pattern — no rclone.conf on disk),
 * so this class only ever composes paths.
 *
 * Uploads use `copyto` with --s3-upload-cutoff=4Gi, deliberately matching backup-pg-to-r2.ts:
 * a single atomic PUT, never multipart, so a killed run can never leave orphaned parts behind.
 */
export class R2Store implements Store {
  readonly kind = "r2" as const;
  readonly describe: string;

  constructor(
    private readonly bucket: string,
    private readonly remote = process.env.ARCHIVE_RCLONE_REMOTE ?? "r2",
  ) {
    this.describe = `r2:${bucket}`;
  }

  private obj(key: string): string {
    return `${this.remote}:${this.bucket}/${key}`;
  }

  /** True when the store answers at all — used to tell "absent" from "unreachable". */
  private reachable(): boolean {
    return capture("rclone", ["lsf", "--max-depth", "1", `${this.remote}:${this.bucket}/`, "--s3-no-check-bucket"]).ok;
  }

  async exists(key: string): Promise<boolean> {
    const slash = key.lastIndexOf("/");
    const dir = slash === -1 ? "" : key.slice(0, slash);
    const file = key.slice(slash + 1);
    const ls = capture("rclone", ["lsf", "--files-only", `${this.obj(dir)}/`, "--s3-no-check-bucket"]);
    if (!ls.ok) {
      // Could be "prefix holds nothing" or "R2 is down" — only the latter may abort the run,
      // so probe the bucket root before deciding.
      if (!this.reachable()) throw new StoreUnreachableError(`could not list ${this.remote}:${this.bucket}/${dir}/`);
      return false;
    }
    return ls.out.split("\n").map((s) => s.trim()).includes(file);
  }

  async put(localPath: string, key: string): Promise<void> {
    if (await this.exists(key)) throw new ObjectExistsError(key);
    const code = await run("rclone", [
      "copyto",
      localPath,
      this.obj(key),
      "--s3-no-check-bucket",
      "--s3-upload-cutoff=4Gi",
      "--stats-one-line",
    ]);
    if (code !== 0) throw new Error(`rclone copyto failed (exit ${code}) for ${key}`);
  }

  async putText(text: string, key: string): Promise<void> {
    if (await this.exists(key)) throw new ObjectExistsError(key);
    await this.putTextViaFile(text, key);
  }

  async putTextOverwrite(text: string, key: string): Promise<void> {
    await this.putTextViaFile(text, key);
  }

  /**
   * Write a small text object by STAGING IT TO A FILE and using `copyto` (a sized PUT).
   *
   * Not `rclone rcat`, which would be the obvious choice for a few hundred bytes of stdin: R2
   * rejects rcat's streaming-signature upload. runlog.ts hit this first and carries the same note —
   * this is the shape that actually works against R2, so manifests and the index use it too.
   */
  private async putTextViaFile(text: string, key: string): Promise<void> {
    const tmp = join(tmpdir(), `gf-store-${process.pid}-${seq++}.tmp`);
    try {
      writeFileSync(tmp, text);
      const code = await run("rclone", ["copyto", tmp, this.obj(key), "--s3-no-check-bucket", "--stats-one-line"]);
      if (code !== 0) throw new Error(`rclone copyto failed (exit ${code}) for ${key}`);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* temp cleanup is best-effort */
      }
    }
  }

  async fetchToFile(key: string, localPath: string): Promise<void> {
    mkdirSync(dirname(resolve(localPath)), { recursive: true });
    const code = await run("rclone", ["copyto", this.obj(key), localPath, "--s3-no-check-bucket", "--stats-one-line"]);
    if (code !== 0) throw new Error(`rclone copyto (download) failed (exit ${code}) for ${key}`);
  }

  async cat(key: string): Promise<string | null> {
    if (!(await this.exists(key))) return null;
    const res = capture("rclone", ["cat", this.obj(key), "--s3-no-check-bucket"]);
    if (!res.ok) throw new StoreUnreachableError(`could not read ${key}`);
    return res.out;
  }

  async list(prefix: string): Promise<string[]> {
    const res = capture("rclone", ["lsf", "-R", "--files-only", `${this.obj(prefix)}/`, "--s3-no-check-bucket"]);
    if (!res.ok) {
      if (!this.reachable()) throw new StoreUnreachableError(`could not list ${prefix}/`);
      return []; // prefix genuinely holds nothing (a first run)
    }
    return res.out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((rel) => `${prefix.replace(/\/+$/, "")}/${rel}`);
  }
}

// ── SuppressedStore (--dry-run=store) ────────────────────────────────────────

/**
 * Reads pass through; writes are recorded and dropped. Two properties matter:
 *
 *   • reads MUST pass through, so a dry run plans against the store's real prior state
 *     rather than an empty fiction;
 *   • a suppressed write MUST read back as absent, so the planner cannot believe a part it
 *     only pretended to write — otherwise a dry run would report part numbers that a real
 *     run would never produce.
 */
export class SuppressedStore implements Store {
  readonly kind: "r2" | "local";
  readonly describe: string;
  readonly suppressed: string[] = [];

  constructor(private readonly inner: Store) {
    this.kind = inner.kind;
    this.describe = `${inner.describe} (writes suppressed)`;
  }

  async exists(key: string): Promise<boolean> {
    return this.inner.exists(key);
  }
  async put(_localPath: string, key: string): Promise<void> {
    this.suppressed.push(key);
  }
  async putText(_text: string, key: string): Promise<void> {
    this.suppressed.push(key);
  }
  async putTextOverwrite(_text: string, key: string): Promise<void> {
    this.suppressed.push(key);
  }
  async fetchToFile(key: string, localPath: string): Promise<void> {
    return this.inner.fetchToFile(key, localPath);
  }
  async cat(key: string): Promise<string | null> {
    return this.inner.cat(key);
  }
  async list(prefix: string): Promise<string[]> {
    return this.inner.list(prefix);
  }
}

/** Build the sink for a parsed --target. */
export function makeStore(target: Target, r2Bucket?: string): Store {
  if (target.kind === "local") return new LocalStore(target.dir);
  if (!r2Bucket) throw new Error("R2_BUCKET must be set for --target=r2");
  return new R2Store(r2Bucket);
}
