// ─────────────────────────────────────────────────────────────────────────────
// Turning a job's outcome record into Slack text — pure.
//
// The record comes out of the client's private bucket, so every piece of free text in it is
// untrusted: it goes through codeSpan() (escaped, un-linkable, capped) and is only ever placed inside
// fixed templates. The one mention is the profile's alert-mention (already a safe mention — see
// slackText.ts), added here and only for pages. A record can therefore make the Worker say, at worst,
// misleading words inside a code span, in its own client's channel, under its own client's name.
// ─────────────────────────────────────────────────────────────────────────────

import { dailyLabelIn, link, type DailyEntry, type RowContext } from "../../scripts/lib/dailyRow.js";
import type { JobOutcome, OutcomeAlert, OutcomeJob } from "../../scripts/lib/jobOutcome.js";
import { codeSpan, escapeSlack, safeMention, safeUrl } from "../../scripts/lib/slackText.js";

/** What a message needs beyond the record: the backup's published view, sanitised, and where the log is. */
export interface RenderContext {
  /** Display-safe row context (see displayContext). */
  row: RowContext;
  /** A safe mention (the profile's alert-mention). */
  mention: string;
  /** The job's log page, or "" when unknown. */
  logUrl: string;
}

/**
 * A RowContext safe to render: the name escaped, the dashboard link dropped unless it is a plain
 * https URL. Everything in it came from the published watchdog config, i.e. from the bucket.
 */
export function displayContext(v: { tz: string; slotMinutes: number; name: string; dashboardUrl: string | null }): RowContext {
  return { tz: v.tz, slotMinutes: v.slotMinutes, name: escapeSlack(v.name, 80), dashboardUrl: safeUrl(v.dashboardUrl) };
}

export interface RenderInputs {
  tz: string;
  slotMinutes: number;
  name: string;
  dashboardUrl: string | null;
  alertMention: string | null;
  logUrl: string;
}

export const renderContext = (v: RenderInputs): RenderContext => ({
  row: displayContext(v),
  mention: safeMention(v.alertMention),
  logUrl: safeUrl(v.logUrl),
});

/** The job's log page: per-job when the job id is known, else the run page. */
export function jobLogUrl(owner: string, repo: string, runId: string, jobId: string | null): string {
  const run = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
  return jobId ? `${run}/job/${jobId}` : run;
}

const TIER_CODE: Record<string, string> = { daily: "D", weekly: "W", monthly: "M" };

/** 📅 + backticked codes for the durable tiers a backup was promoted to (D/W/M); "" for plain intraday. */
export function tierMarker(tiers: readonly string[]): string {
  const codes = tiers.map((t) => TIER_CODE[t] ?? "").join("");
  return codes ? `📅\`${codes}\`` : "";
}

/** A backup's tick on the daily row: labelled with when it STARTED, in the backup's timezone. */
export function dailyEntryFor(o: JobOutcome, tz: string): DailyEntry {
  const tiers = o.summary?.kind === "backup" ? o.summary.tiers : [];
  return {
    label: dailyLabelIn(new Date(o.startedAt), tz),
    ok: o.ok,
    marker: o.ok ? tierMarker(tiers) : "",
    origin: o.origin ?? "schedule",
  };
}

const JOB_LABEL: Record<OutcomeJob, string> = {
  backup: "backup",
  durableVerify: "durable-verify",
  restoreDrill: "restore-drill",
  archive: "archive",
};

/** Codes an archive run raises for rows a human must look at — not a crash (see archive-table.ts). */
const ATTENTION_CODES = new Set(["archive_refusal", "archive_anomaly"]);
const MAX_BULLETS = 8;

function bullets(alerts: readonly OutcomeAlert[]): string {
  const shown = alerts.slice(0, MAX_BULLETS).map((a) => `• ${codeSpan(a.text, 400)}`);
  if (alerts.length > MAX_BULLETS) shown.push(`• …and ${alerts.length - MAX_BULLETS} more`);
  return shown.join("\n");
}

export interface RenderedOutcome {
  /** backup: the tick for the daily row. */
  row?: DailyEntry;
  /** A mentioning page. backup threads it under the row (and broadcasts it); others post top-level. */
  page?: string;
  /** A quiet warning. */
  warn?: string;
  /** A quiet notice (drill OK, archive summary). */
  info?: string;
  /** Plain text for the client's failure webhook — set exactly when `page` is. */
  webhook?: string;
}

export function renderOutcome(o: JobOutcome, ctx: RenderContext): RenderedOutcome {
  const out: RenderedOutcome = {};
  const { row } = ctx;
  const title = `*${link(row.dashboardUrl, `${row.name} DB backup`)}*`;
  const log = ctx.logUrl ? ` · <${ctx.logUrl}|job log>` : "";
  const label = JOB_LABEL[o.job];
  const at = dailyLabelIn(new Date(o.startedAt), row.tz);

  if (o.job === "backup") out.row = dailyEntryFor(o, row.tz);

  const pages = o.alerts.filter((a) => a.severity === "page");
  const warns = o.alerts.filter((a) => a.severity === "warn");
  // A failed run always pages, even if (somehow) it recorded no reason.
  const reasons = pages.length > 0 ? pages : o.ok ? [] : [{ severity: "page" as const, code: "failed", text: `exited with code ${o.exitCode}` }];

  if (reasons.length > 0) {
    const attentionOnly = o.job === "archive" && reasons.every((a) => ATTENTION_CODES.has(a.code));
    if (attentionOnly) {
      out.page = `${ctx.mention} 🟠 ${title} archive needs attention${log}\n${bullets(reasons)}`;
    } else {
      const what = o.job === "backup" ? `FAILED at ${at}` : `${label} FAILED`;
      out.page =
        reasons.length === 1
          ? `${ctx.mention} 🔴 ${title} ${what} — ${codeSpan(reasons[0].text, 400)}${log}`
          : `${ctx.mention} 🔴 ${title} ${what} — ${reasons.length} problems${log}\n${bullets(reasons)}`;
    }
    const first = escapeSlack(reasons[0].text, 300);
    out.webhook = `🔴 PG ${label} ${attentionOnly ? "needs attention" : "FAILED"} (${row.name}): ${first}${reasons.length > 1 ? ` (+${reasons.length - 1} more)` : ""}`;
  }

  if (warns.length > 0) {
    out.warn = warns.length === 1 ? `⚠️ *${row.name} backups* — ${codeSpan(warns[0].text, 400)}` : `⚠️ *${row.name} backups*\n${bullets(warns)}`;
  }

  if (o.ok && o.summary?.kind === "restoreDrill") {
    const s = o.summary;
    out.info = `✅ PG restore-drill OK (${row.name}) — ${codeSpan(s.table, 80)} ${s.count ?? "?"} (ratio ${s.ratio ?? "?"}) — ${codeSpan(s.key, 200)}`;
  }

  if (o.ok && o.summary?.kind === "archive" && o.summary.dryRun === "none") {
    const worked = o.summary.tables.filter((t) => t.weeksArchived || t.weeksPruned);
    if (worked.length > 0) {
      const lines = worked.map(
        (t) => `${codeSpan(t.table, 80)}: +${t.weeksArchived}w/${t.rowsArchived} rows archived, −${t.weeksPruned}w/${t.rowsPruned} rows pruned`,
      );
      out.info = `🗄️ *${row.name} archive* ok in ${(o.durationMs / 1000).toFixed(1)}s\n${lines.join("\n")}`;
    }
  }
  return out;
}
