// ─────────────────────────────────────────────────────────────────────────────
// The timezone abbreviation shown in the Slack day header and the dashboard.
//
// Browser-safe (Intl only): backupHistory.ts imports this and is bundled into the
// dashboard by build-dashboard.ts, which `define`s DISPLAY_TZ at build time.
// ─────────────────────────────────────────────────────────────────────────────

import { DISPLAY_TZ } from "./backupTypes.js";

/**
 * CLDR only carries letter abbreviations for a zone in the locales of that zone's OWN region, so no
 * single locale is right everywhere: en-US knows EDT but renders Sydney as "GMT+10"; en-AU knows
 * AEST but renders New York as "GMT-4". Probe in order and take the first non-offset answer.
 */
const LOCALES = ["en-AU", "en-US", "en-GB", "en-IE", "en-IN", "en-SG", "en-ZA"];

const formatters = new Map<string, Intl.DateTimeFormat>();

function shortName(locale: string, timeZone: string, d: Date): string {
  const key = `${locale}|${timeZone}`;
  let fmt = formatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" });
    formatters.set(key, fmt);
  }
  return fmt.formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
}

/**
 * Abbreviation for `timeZone` at the instant `d` — "AEST"/"AEDT", "EDT", "BST", "UTC" — falling back
 * to the raw offset ("GMT+9") for zones English CLDR has no abbreviation for (Tokyo, Shanghai, São
 * Paulo). DST-correct because the probe runs per instant, not once at module load.
 */
export function tzAbbrev(d: Date, timeZone: string = DISPLAY_TZ): string {
  let fallback = "";
  for (const locale of LOCALES) {
    const v = shortName(locale, timeZone, d);
    if (!fallback) fallback = v;
    // Bare "UTC"/"GMT" are real answers; "GMT+10"/"GMT-4:30" are the offset fallback we're avoiding.
    if (v && !/^(?:GMT|UTC)[+-]/.test(v)) return v;
  }
  return fallback;
}
