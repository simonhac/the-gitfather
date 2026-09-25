// ─────────────────────────────────────────────────────────────────────────────
// /health/jobs — every client's job proofs, read through the R2 bindings this Worker already holds,
// judged by the pure rules in scripts/lib/jobProof.ts. One uptime monitor on this URL replaces a
// push heartbeat per job per project (CB-299: the free plan's ten heartbeat slots were exhausted,
// and four of the ten had never beaten because a caller never passed the optional URL).
//
// Owed proofs come from the roster (which cadences the client subscribes to) crossed with each
// published config (which databases exist, and whether each archives). Anything the Worker cannot
// LOOK at fails the check — a failed listing, no published config — because "could not look" is not
// health. Never throws.
// ─────────────────────────────────────────────────────────────────────────────

import { jobProofKey, jobsVerdict, owedJobs, parseJobProof, type JobCheck, type JobsVerdict } from "../../scripts/lib/jobProof.js";
import { subscribes, type Client, type Env } from "./github.js";
import { getText, readConfigs } from "./watchdog.js";

async function clientChecks(env: Env, client: Client): Promise<JobCheck[]> {
  const subscribed = { durableVerify: subscribes(client, "durableVerify"), archive: subscribes(client, "archive") };
  const rostered = owedJobs(subscribed);
  if (rostered.length === 0) return [];
  const failAll = (problem: string): JobCheck[] => rostered.map((job) => ({ client: client.id, job, proof: null, problem }));

  const bucket = env[client.bucket] as R2Bucket;
  let configs: Awaited<ReturnType<typeof readConfigs>>;
  try {
    configs = await readConfigs(bucket);
  } catch (e) {
    console.error(`jobs ${client.id}: config listing failed: ${String(e)}`);
    return failAll("config listing failed");
  }
  if (configs.length === 0) return failAll("no published config — cannot tell which databases owe proofs");

  const perConfig = await Promise.all(
    configs.map(async ({ key, cfg }): Promise<JobCheck[]> => {
      if (!cfg) return failAll(`${key} is not a valid published config`);
      const owed = owedJobs({ ...subscribed, archives: cfg.archives });
      return Promise.all(
        owed.map(async (job): Promise<JobCheck> => {
          try {
            return { client: client.id, job, proof: parseJobProof(await getText(bucket, jobProofKey(cfg.name, job))) };
          } catch (e) {
            console.error(`jobs ${client.id}: [${cfg.name}] ${job} proof read failed: ${String(e)}`);
            return { client: client.id, job, proof: null, problem: "proof could not be read" };
          }
        }),
      );
    }),
  );
  return perConfig.flat();
}

export async function jobsHealth(env: Env, clients: Client[], now: Date): Promise<JobsVerdict> {
  const checks = (await Promise.all(clients.map((c) => clientChecks(env, c)))).flat();
  return jobsVerdict(checks, now);
}
