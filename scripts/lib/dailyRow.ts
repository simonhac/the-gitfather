// ─────────────────────────────────────────────────────────────────────────────
// The daily Slack status row — rendering and keys, PURE and PARAMETERISED.
//
// One message per display-timezone day, persisted as _status/<basename>/<date>.json and updated
// in place: a ✅/❌ + HH:MM tick per run, a 🖐️/🩹 origin marker, and a ⬜ placeholder for every
// elapsed-but-empty slot. lib/slack.ts wraps these with the profile's timezone/cadence/name for the
// Actions-side scripts; the Cloudflare Worker's watchdog passes the same values from the published
// watchdog config. One renderer, two runtimes — so a row the backup wrote and a row the watchdog
// refreshed can never disagree about what a slot looks like.
//
// Node-free and env-free by construction: nothing here may import backupTypes.ts at value level
// (it reads process.env at module load, which the Worker does not have).
// ─────────────────────────────────────────────────────────────────────────────

import type { RunOrigin } from "./runOrigin.js";
import { tzAbbrev } from "./tzAbbrev.js";

/** Everything the row needs to know about the backup it describes. */
export interface RowContext {
  /** IANA display timezone (the profile's `timezone`). */
  tz: string;
  /** Backup cadence in minutes (`staleness.slot-minutes`); must divide 1440. */
  slotMinutes: number;
  /** The profile `name` — names the state object and the header. */
  name: string;
  /** `dashboard.url`, or "" — links the header's "<name> DB backup". */
  dashboardUrl: string;
}

export interface DailyEntry {
  label: string;
  ok: boolean;
  marker: string;
  origin?: RunOrigin; // drives the row marker (schedule → none, manual → 🖐️, self-heal → 🩹)
  manual?: boolean; // @deprecated legacy field; still WRITTEN for cross-version safety, READ as fallback
}

export interface DailyState {
  channel: string;
  ts: string;
  date: string;
  header: string;
  entries: DailyEntry[];
}

export const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Slots per day for a slot width (validated elsewhere to divide 1440). */
export const slotsPerDay = (slotMinutes: number): number => Math.round(1440 / slotMinutes);

// ── Display-timezone calendar parts (Intl only, formatter cached per zone) ──────────────────────

export interface TzParts {
  y: number;
  mo: number;
  day: number;
  hour: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar parts of `d` as seen in `tz`. */
export function tzPartsIn(d: Date, tz: string): TzParts {
  let fmt = partsFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    });
    partsFormatters.set(tz, fmt);
  }
  const parts = fmt.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0;
  return { y: get("year"), mo: get("month"), day: get("day"), hour };
}

/** "YYYY-MM-DD" of `d` in `tz` — the day-message key. */
export function dateKeyIn(d: Date, tz: string): string {
  const { y, mo, day } = tzPartsIn(d, tz);
  return `${y}-${pad2(mo)}-${pad2(day)}`;
}

/** Current HH:MM in `tz` — the tick label. */
export function dailyLabelIn(now: Date, tz: string): string {
  const { hour } = tzPartsIn(now, tz);
  const minute = new Intl.DateTimeFormat("en-GB", { timeZone: tz, minute: "2-digit" }).formatToParts(now).find((p) => p.type === "minute")?.value ?? "00";
  return `${pad2(hour)}:${minute.padStart(2, "0")}`;
}

/** The object holding a day's row state. */
export const dailyStateKey = (name: string, dateKey: string): string => `_status/${name}/${dateKey}.json`;

// ── Text ─────────────────────────────────────────────────────────────────────────────────────────

/** Generic Slack mrkdwn link: `<url|text>` when `url` is set, otherwise the plain text. */
export function link(url: string, text: string): string {
  return url ? `<${url}|${text}>` : text;
}

/**
 * Body of a loud failure alert (MENTION-FREE — callers add the mention). Bolds the dashboard-linked
 * "<name> DB backup" title and hyperlinks `reason` to `logUrl` (the GitHub Actions job log, or ""
 * when there is none — the Worker has no job log). Both links degrade to plain text.
 *   🔴 *<name> DB backup* <what> — <reason>
 */
export function failAlertTextIn(what: string, reason: string, logUrl: string, ctx: Pick<RowContext, "name" | "dashboardUrl">): string {
  return `🔴 *${link(ctx.dashboardUrl, `${ctx.name} DB backup`)}* ${what} — ${link(logUrl, reason)}`;
}

/**
 * The day-message header for `now`, e.g. `*<url|boost DB backup> — Sun 22 Jun 2026 (AEST)*`. Recomputed
 * on every persist (not just first creation), so adding `dashboard.url` relinks the existing day's message.
 */
export function dailyHeaderIn(now: Date, ctx: RowContext): string {
  // C-locale-style abbreviations (en-US gives "Sep"/"Mon", matching bash `date +%b`/`%a`). The timezone
  // abbreviation is NOT taken from here — en-US renders Australian zones as "GMT+10"; see tzAbbrev.ts.
  const dp = new Intl.DateTimeFormat("en-US", {
    timeZone: ctx.tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatToParts(now);
  const get = (t: string) => dp.find((p) => p.type === t)?.value ?? "";
  const tz = tzAbbrev(now, ctx.tz);
  // Only the "<basename> DB backup" name is linked; the whole header stays bold (Slack renders a
  // link inside *…*). With unfurl_links:false on every post, the link never expands to a preview.
  const name = link(ctx.dashboardUrl, `${ctx.name} DB backup`);
  return `*${name} — ${get("weekday")} ${get("day")} ${get("month")} ${get("year")} (${tz})*`;
}

/**
 * Render the message text: header + real ticks (✅/❌, 🖐️/🩹-prefixed by origin) interleaved with ⬜
 * placeholders for elapsed-but-empty slots, sorted by label. Pure — `now` drives which buckets are "due".
 */
export function renderDailyTextIn(state: DailyState, now: Date, ctx: RowContext): string {
  const today = dateKeyIn(now, ctx.tz);
  const curH = tzPartsIn(now, ctx.tz).hour;
  const slots = slotsPerDay(ctx.slotMinutes);
  const hoursPerSlot = 24 / slots;

  // Buckets (0..slots-1) already covered by a real run — slot = floor(HH / hoursPerSlot).
  const filled = new Set(state.entries.map((e) => Math.floor(Number(e.label.slice(0, 2)) / hoursPerSlot)));

  // "HH:00" labels for buckets that are DUE yet EMPTY. A backup can land ANYWHERE inside its slot —
  // the schedule is UTC-anchored but the display zone may be phase-shifted, so the tick isn't at the
  // slot start. To avoid a false ⬜ before a late-in-slot backup lands, a slot only counts as "missing"
  // once it has WHOLLY elapsed (hoursPerSlot*(s+1) <= curH), never mid-slot.
  const placeholders: string[] = [];
  for (let s = 0; s < slots; s++) {
    const due = state.date < today || (state.date === today && hoursPerSlot * (s + 1) <= curH);
    if (!due) continue;
    if (filled.has(s)) continue;
    placeholders.push(`${pad2(s * hoursPerSlot)}:00`);
  }

  const syms: { label: string; sym: string }[] = [];
  for (const e of state.entries) {
    // Back-compat: an entry persisted by an older instance has only `manual`, not `origin`.
    const origin: RunOrigin = e.origin ?? (e.manual ? "manual" : "schedule");
    const prefix = origin === "self-heal" ? "🩹 " : origin === "manual" ? "🖐️ " : "";
    const status = e.ok ? "✅ " : "❌ ";
    const marker = e.marker ? ` ${e.marker}` : "";
    syms.push({ label: e.label, sym: `${prefix}${status}${e.label}${marker}` });
  }
  for (const label of placeholders) {
    syms.push({ label, sym: `⬜ ${label}` });
  }
  syms.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return `${state.header}\n${syms.map((s) => s.sym).join("  ·  ")}`;
}

/** Parse a persisted day state; anything malformed → null (caller skips the update). */
export function parseDailyState(raw: string): DailyState | null {
  if (!raw || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw) as Partial<DailyState> | null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    if (typeof v.date !== "string" || !Array.isArray(v.entries)) return null;
    return {
      channel: typeof v.channel === "string" ? v.channel : "",
      ts: typeof v.ts === "string" ? v.ts : "",
      date: v.date,
      header: typeof v.header === "string" ? v.header : "",
      entries: v.entries as DailyEntry[],
    };
  } catch {
    return null;
  }
}
