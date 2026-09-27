// ─────────────────────────────────────────────────────────────────────────────
// The slice of an R2 bucket binding the Slack delivery code uses — declared here, structurally, so that
// code stays free of Worker types (and testable from the Node side with an in-memory fake). An R2Bucket
// satisfies it as-is.
//
// Two R2 behaviours the delivery code depends on:
//   • put() with `onlyIf: { etagMatches }` stores nothing and returns null when the object changed —
//     the compare-and-swap every claim and every daily-row write goes through;
//   • list() with `include: ["customMetadata"]` returns each object's custom metadata, which is where an
//     outcome record's delivery state lives (so finding un-posted records costs one list, no GETs).
// ─────────────────────────────────────────────────────────────────────────────

export interface StoredMeta {
  key: string;
  etag: string;
  size: number;
  uploaded: Date;
  customMetadata?: Record<string, string>;
}

export interface StoredObject extends StoredMeta {
  text(): Promise<string>;
}

export interface StorePutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  onlyIf?: { etagMatches?: string };
}

export interface StoreListOptions {
  prefix?: string;
  startAfter?: string;
  cursor?: string;
  limit?: number;
  include?: "customMetadata"[];
}

export interface StoreListing {
  objects: StoredMeta[];
  truncated: boolean;
  cursor?: string;
}

export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  /** null when an `onlyIf` precondition failed (nothing was stored). */
  put(key: string, value: string, options?: StorePutOptions): Promise<StoredMeta | null>;
  list(options?: StoreListOptions): Promise<StoreListing>;
  delete(key: string): Promise<void>;
}

export const JSON_TYPE = { contentType: "application/json" } as const;

/** Every object under `opts.prefix`, following the cursor (bounded — a runaway listing is a bug, not data). */
export async function listAll(store: ObjectStore, opts: StoreListOptions, maxPages = 5): Promise<StoredMeta[]> {
  const out: StoredMeta[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await store.list({ ...opts, ...(cursor ? { cursor } : {}) });
    out.push(...res.objects);
    if (!res.truncated || !res.cursor) break;
    cursor = res.cursor;
  }
  return out;
}
