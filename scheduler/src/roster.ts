// ─────────────────────────────────────────────────────────────────────────────
// The client roster — `vars.ROSTER` in the (gitignored) wrangler.jsonc, whose source of truth is the
// operator's private infra repo. One entry per client: which repo to dispatch to, which R2 binding
// holds its dumps, and — since the Worker became the only thing that posts to Slack — where and as
// whom to post about it.
//
// The Slack block sits here, beside the token it goes with, rather than in the client's profile: the
// channel decides where an operator-held credential posts, so it must not come from the client's
// bucket (which anyone holding that client's CI key can write). Pinning channel + identity here
// confines anything a leaked client key could make the Worker say to that client's own channel and
// name. It is still GitHub → Cloudflare: the roster is deployed with wrangler, never read back.
//
// Deliberately free of Worker types so the parser is testable from the Node side.
// ─────────────────────────────────────────────────────────────────────────────

import { safeUrl } from "../../scripts/lib/slackText.js";

export type Cadence = "backup" | "staleness" | "durableVerify" | "restoreDrill" | "archive";

/** Where and as whom the Worker posts about this client. No block → Slack is off for the client. */
export interface RosterSlack {
  /** Channel id (`C…`, `G…` or `D…`) — the app must be invited to it. */
  channel: string;
  /** Display name for every post (needs chat:write.customize). Default `<id> backup`. */
  username?: string;
  /** `:emoji:` icon for every post. Mutually exclusive with iconUrl. Default: the app's own icon. */
  iconEmoji?: string;
  /** https URL of an icon image. Mutually exclusive with iconEmoji. */
  iconUrl?: string;
}

export interface Client {
  id: string; // opaque label — the ONLY client identifier that may appear in logs
  owner: string;
  repo: string;
  /** GitHub's numeric id for owner/repo. Optional; when set, /notify also requires the OIDC `repository_id` to match — a renamed-and-recreated repo can't inherit the client. */
  repositoryId?: number;
  installationId: number; // the GitHub App's installation id on this owner's account (not secret)
  bucket: string; // the R2 binding name of this client's PRIVATE dump bucket (declared in wrangler.jsonc)
  cadences?: Cadence[]; // optional allowlist of cadences this client runs (default: all NON-opt-in ones)
  workflows?: Partial<Record<Cadence, string>>; // optional per-client filename overrides (default: DEFAULT_WORKFLOWS)
  slack?: RosterSlack;
}

export const ALL_CADENCES: readonly Cadence[] = ["backup", "staleness", "durableVerify", "restoreDrill", "archive"];

// the-gitfather's conventional caller-workflow filenames. They're identical across consuming repos by
// convention, so they live here as defaults rather than being repeated for every client in the roster.
// `staleness` has no caller any more — it runs natively (watchdog.ts) — but stays a cadence so a client
// can opt out of it via `cadences`, and so `/trigger?cadence=staleness` fires it on demand.
export const DEFAULT_WORKFLOWS: Record<Exclude<Cadence, "staleness">, string> = {
  backup: "pg-backup.yml",
  durableVerify: "pg-durable-verify.yml",
  restoreDrill: "pg-restore-drill.yml",
  archive: "pg-archive.yml",
};

export const workflowFor = (c: Client, cadence: Exclude<Cadence, "staleness">): string =>
  c.workflows?.[cadence] ?? DEFAULT_WORKFLOWS[cadence];

// Cadences a client gets ONLY by naming them. `cadences` defaults to "everything", so a cadence added
// after clients are already in the roster MUST be opt-in — otherwise it starts dispatching to repos
// that have no such caller workflow and 404s on every tick. `archive` also deletes rows, which is not
// something any client should acquire by upgrade.
const OPT_IN_CADENCES: readonly Cadence[] = ["archive"];

export const subscribes = (c: Client, cadence: Cadence): boolean =>
  c.cadences ? c.cadences.includes(cadence) : !OPT_IN_CADENCES.includes(cadence);

export function isCadence(s: string | null): s is Cadence {
  return s !== null && (ALL_CADENCES as readonly string[]).includes(s);
}

const SLACK_KEYS = new Set(["channel", "username", "iconEmoji", "iconUrl"]);
const CHANNEL = /^[CGD][A-Z0-9]{8,20}$/;
const ICON_EMOJI = /^:[a-z0-9_+'-]{1,60}:$/;

function checkSlack(label: string, s: unknown): void {
  if (s === undefined) return;
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error(`${label}: slack must be an object`);
  const o = s as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !SLACK_KEYS.has(k));
  if (unknown.length) throw new Error(`${label}: unknown slack key(s) ${unknown.join(", ")} (allowed: ${[...SLACK_KEYS].join(", ")})`);
  if (typeof o.channel !== "string" || !CHANNEL.test(o.channel)) throw new Error(`${label}: slack.channel must be a channel id like C0123456789`);
  if (o.username !== undefined) {
    // eslint-disable-next-line no-control-regex
    if (typeof o.username !== "string" || !o.username.trim() || o.username.length > 80 || /[\u0000-\u001f<>&]/.test(o.username)) {
      throw new Error(`${label}: slack.username must be 1–80 plain characters`);
    }
  }
  if (o.iconEmoji !== undefined && (typeof o.iconEmoji !== "string" || !ICON_EMOJI.test(o.iconEmoji))) {
    throw new Error(`${label}: slack.iconEmoji must look like :floppy_disk:`);
  }
  if (o.iconUrl !== undefined && (typeof o.iconUrl !== "string" || !safeUrl(o.iconUrl))) throw new Error(`${label}: slack.iconUrl must be an https URL`);
  if (o.iconEmoji !== undefined && o.iconUrl !== undefined) throw new Error(`${label}: set slack.iconEmoji OR slack.iconUrl, not both`);
}

/**
 * Parse + validate the roster. Throws with a clear message — a bad roster must not surface as a cryptic
 * 404 later. `hasBucket` says whether an R2 binding of that name exists.
 */
export function parseRoster(roster: unknown, hasBucket: (binding: string) => boolean): Client[] {
  const raw: unknown = typeof roster === "string" ? JSON.parse(roster) : roster;
  if (!Array.isArray(raw)) throw new Error("ROSTER must be a JSON array (a `vars` entry in wrangler.jsonc)");
  const clients = raw as Client[];
  const seen = new Set<string>();
  const repos = new Set<string>();
  for (const c of clients) {
    const label = `ROSTER entry "${c.id ?? "?"}"`;
    if (typeof c.id !== "string" || !c.id) throw new Error(`${label} needs a non-empty id`);
    if (seen.has(c.id)) throw new Error(`${label} is duplicated`);
    seen.add(c.id);
    if (typeof c.owner !== "string" || !c.owner || typeof c.repo !== "string" || !c.repo) throw new Error(`${label} needs owner + repo`);
    // /notify identifies the client by repository, so two entries for one repo would be ambiguous.
    const repoKey = `${c.owner}/${c.repo}`.toLowerCase();
    if (repos.has(repoKey)) throw new Error(`${label}: ${c.owner}/${c.repo} is already in the roster`);
    repos.add(repoKey);
    if (typeof c.installationId !== "number" || !Number.isInteger(c.installationId) || c.installationId <= 0) {
      throw new Error(`${label} needs a positive integer installationId (got ${JSON.stringify(c.installationId)})`);
    }
    if (c.repositoryId !== undefined && (typeof c.repositoryId !== "number" || !Number.isInteger(c.repositoryId) || c.repositoryId <= 0)) {
      throw new Error(`${label}: repositoryId must be a positive integer`);
    }
    if (typeof c.bucket !== "string" || !c.bucket) throw new Error(`${label} needs bucket (an R2 binding name)`);
    if (!hasBucket(c.bucket)) throw new Error(`${label}: no R2 binding named ${c.bucket} — add it to r2_buckets in wrangler.jsonc`);
    checkSlack(label, c.slack);
  }
  return clients;
}

/** The roster entry for an `owner/repo` (case-insensitive, as GitHub treats it), or null. */
export function clientForRepository(clients: readonly Client[], repository: string): Client | null {
  const want = repository.toLowerCase();
  return clients.find((c) => `${c.owner}/${c.repo}`.toLowerCase() === want) ?? null;
}

/** The chat.postMessage identity fields for a client's posts. */
export interface SlackIdentity {
  username: string;
  icon_emoji?: string;
  icon_url?: string;
}

export function slackIdentity(c: Client): SlackIdentity {
  const s = c.slack;
  return {
    username: s?.username ?? `${c.id} backup`,
    ...(s?.iconEmoji ? { icon_emoji: s.iconEmoji } : {}),
    ...(s?.iconUrl ? { icon_url: s.iconUrl } : {}),
  };
}
