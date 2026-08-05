// ─────────────────────────────────────────────────────────────────────────────
// Natural-language duration parser for the profile's retention block, e.g.
// "2 days", "3 weeks", "13 weeks", "2 years". Node-side only (config validation):
// the parsed { days, label } is what rides into the dashboard payload, so the
// browser bundle never needs this module.
//
//   days  — the duration in days, for expiry math (months ≈ 365/12, years = 365)
//   label — the normalised "<n> <unit(s)>" string, for the dashboard subtitle
// ─────────────────────────────────────────────────────────────────────────────

/** Days per unit. month/year are nominal (calendar-agnostic) — good enough for retention windows. */
const UNIT_DAYS: Record<string, number> = {
  hour: 1 / 24,
  day: 1,
  week: 7,
  month: 365 / 12,
  year: 365,
};

export interface Duration {
  days: number;
  label: string;
}

/**
 * Parse "<integer> <hours|days|weeks|months|years>" → { days, label }. The unit may be singular or
 * plural on input; `label` is always re-pluralised to agree with the count. Throws on anything else.
 */
export function parseDuration(input: string): Duration {
  const s = String(input).trim();
  const m = /^(\d+)\s+(hour|day|week|month|year)s?$/i.exec(s);
  if (!m) {
    throw new Error(
      `invalid duration "${input}" — expected "<n> <hours|days|weeks|months|years>" (e.g. "13 weeks")`,
    );
  }
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return { days: n * UNIT_DAYS[unit], label: `${n} ${unit}${n === 1 ? "" : "s"}` };
}

/**
 * Human elapsed time for log lines and alert prose: "45m", "16h 19m", "1d 1h".
 *
 * The staleness log used to interpolate `${ageH}h ${ageM}m` where ageM was the TOTAL minutes,
 * so a 16-hour-old backup printed as "16h 979m old". The minutes here are the remainder, the
 * larger unit is dropped when zero, and a negative input (clock skew between the runner and the
 * object stamp) clamps to "<1m" rather than rendering "-1h -3m".
 */
export function formatElapsed(ms: number): string {
  const totalMin = Math.floor(Math.max(0, ms) / 60_000);
  if (totalMin < 1) return "<1m";
  if (totalMin < 60) return `${totalMin}m`;

  const totalHours = Math.floor(totalMin / 60);
  if (totalHours < 24) {
    const m = totalMin % 60;
    return m ? `${totalHours}h ${m}m` : `${totalHours}h`;
  }

  const d = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  return h ? `${d}d ${h}h` : `${d}d`;
}
