/**
 * Best-effort dead-man's-switch ping (curl -fsS -m 10 equivalent). A failed ping only warns: the
 * heartbeat service pages on the ABSENCE of pings, so a run must never fail because one was lost.
 */
export async function pingHeartbeat(url: string, label: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) process.stderr.write(`warning: ${label} ping failed\n`);
  } catch {
    process.stderr.write(`warning: ${label} ping failed\n`);
  } finally {
    clearTimeout(timer);
  }
}
