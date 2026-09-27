// In-memory stand-ins for the Worker's ports (scheduler/src/objectStore.ts, slackPort.ts, deliver.ts
// GithubPort), faithful to the R2 behaviours the delivery code relies on: etags change on every write,
// a put whose `onlyIf.etagMatches` is stale stores nothing and returns null, and list() returns custom
// metadata only when asked to via `include`.

import type { ObjectStore, StoredMeta, StoredObject, StoreListOptions, StorePutOptions } from "../../../scheduler/src/objectStore.js";
import type { SlackPort } from "../../../scheduler/src/slackPort.js";
import type { SlackResult } from "../../../scheduler/src/slackApi.js";
import type { GithubJob, GithubPort, GithubRun } from "../../../scheduler/src/deliver.js";

interface Entry {
  body: string;
  etag: string;
  uploaded: Date;
  customMetadata?: Record<string, string>;
}

export class FakeStore implements ObjectStore {
  readonly objects = new Map<string, Entry>();
  private n = 0;
  /** Called before each put — lets a test change the object "concurrently". */
  beforePut?: (key: string) => void;
  puts = 0;
  gets = 0;

  constructor(private clock: () => Date = () => new Date()) {}

  seed(key: string, body: string, opts: { uploaded?: Date; customMetadata?: Record<string, string> } = {}): void {
    this.objects.set(key, { body, etag: `e${++this.n}`, uploaded: opts.uploaded ?? this.clock(), customMetadata: opts.customMetadata });
  }

  private meta(key: string, e: Entry, withMeta: boolean): StoredMeta {
    return { key, etag: e.etag, size: e.body.length, uploaded: e.uploaded, ...(withMeta && e.customMetadata ? { customMetadata: { ...e.customMetadata } } : {}) };
  }

  async get(key: string): Promise<StoredObject | null> {
    this.gets++;
    const e = this.objects.get(key);
    if (!e) return null;
    const body = e.body;
    return { ...this.meta(key, e, true), text: async () => body };
  }

  async put(key: string, value: string, options: StorePutOptions = {}): Promise<StoredMeta | null> {
    this.beforePut?.(key);
    this.puts++;
    const cur = this.objects.get(key);
    const want = options.onlyIf?.etagMatches;
    if (want !== undefined && cur?.etag !== want) return null;
    const e: Entry = { body: value, etag: `e${++this.n}`, uploaded: this.clock(), customMetadata: options.customMetadata };
    this.objects.set(key, e);
    return this.meta(key, e, true);
  }

  async list(opts: StoreListOptions = {}): Promise<{ objects: StoredMeta[]; truncated: boolean }> {
    const withMeta = opts.include?.includes("customMetadata") ?? false;
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(opts.prefix ?? "") && (!opts.startAfter || k > opts.startAfter))
      .sort();
    return { objects: keys.map((k) => this.meta(k, this.objects.get(k)!, withMeta)), truncated: false };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  json(key: string): unknown {
    const e = this.objects.get(key);
    return e ? JSON.parse(e.body) : undefined;
  }
}

export interface SlackCall {
  kind: "post" | "update";
  text: string;
  ts?: string;
  thread?: string;
  broadcast?: boolean;
}

export class FakeSlack implements SlackPort {
  readonly calls: SlackCall[] = [];
  /** Queue of forced failures: the next post/update consumes one. */
  failures: string[] = [];
  /** ts values that can't be updated (e.g. posted by another app). */
  foreign = new Set<string>();
  private n = 0;

  constructor(readonly channel = "C0TESTCHAN1") {}

  private result(ts = ""): SlackResult {
    const error = this.failures.shift();
    return error ? { ok: false, ts: "", error } : { ok: true, ts, error: "" };
  }

  async post(text: string, opts: { thread?: string; broadcast?: boolean } = {}): Promise<SlackResult> {
    this.calls.push({ kind: "post", text, ...opts });
    return this.result(`1000.${++this.n}`);
  }

  async update(ts: string, text: string): Promise<SlackResult> {
    this.calls.push({ kind: "update", text, ts });
    if (this.foreign.has(ts)) return { ok: false, ts: "", error: "cant_update_message" };
    return this.result(ts);
  }

  posts(): SlackCall[] {
    return this.calls.filter((c) => c.kind === "post");
  }
}

export class FakeGithub implements GithubPort {
  runs = new Map<string, GithubRun>();
  jobs = new Map<string, GithubJob>();
  runJobs = new Map<string, GithubJob[]>();
  fail = false;

  async getRun(runId: string): Promise<GithubRun | null> {
    if (this.fail) throw new Error("github down");
    return this.runs.get(runId) ?? null;
  }

  async getJob(jobId: string): Promise<GithubJob | null> {
    if (this.fail) throw new Error("github down");
    return this.jobs.get(jobId) ?? null;
  }

  async listRunJobs(runId: string): Promise<GithubJob[]> {
    if (this.fail) throw new Error("github down");
    return this.runJobs.get(runId) ?? [];
  }
}
