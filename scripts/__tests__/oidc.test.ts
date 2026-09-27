import { test } from "node:test";
import assert from "node:assert/strict";
import { b64urlEncode, b64urlJson } from "../../scheduler/src/b64url.js";
import { jwksKeySource, resolveNotifyTarget, verifyGithubOidc, GITHUB_OIDC_ISSUER, type GithubClaims } from "../../scheduler/src/oidc.js";
import type { Client } from "../../scheduler/src/roster.js";

const RS256 = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as const;
const pair = (await crypto.subtle.generateKey(RS256, true, ["sign", "verify"])) as CryptoKeyPair;
const other = (await crypto.subtle.generateKey(RS256, true, ["sign", "verify"])) as CryptoKeyPair;
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", use: "sig", alg: "RS256" };

const NOW = Date.UTC(2026, 8, 27, 8, 5, 0);
const nowS = Math.floor(NOW / 1000);

const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: GITHUB_OIDC_ISSUER,
  aud: "the-gitfather",
  iat: nowS - 5,
  nbf: nowS - 5,
  exp: nowS + 295,
  repository: "acme/Alpha",
  repository_id: "987654321",
  job_workflow_ref: "simonhac/the-gitfather/.github/workflows/pg-backup.yml@refs/heads/main",
  run_id: "17000000001",
  run_attempt: "1",
  check_run_id: "50000000001",
  ...over,
});

async function sign(payload: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: CryptoKey } = {}): Promise<string> {
  const input = `${b64urlJson({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" })}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64urlEncode(sig)}`;
}

const keys = jwksKeySource(async () => ({ keys: [jwk] }));
const verify = (token: string, audience = "the-gitfather") => verifyGithubOidc(token, { audience, nowMs: NOW, keys });

test("verify: a well-formed GitHub token passes and returns its claims", async () => {
  const r = await verify(await sign(claims()));
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.claims.run_id, "17000000001");
});

test("verify: an aud array containing ours is accepted", async () => {
  assert.equal((await verify(await sign(claims({ aud: ["x", "the-gitfather"] })))).ok, true);
});

test("verify: rejects what it must", async () => {
  const cases: [string, Promise<string>][] = [
    ["wrong issuer", sign(claims({ iss: "https://evil.example" }))],
    ["wrong audience", sign(claims({ aud: "sts.amazonaws.com" }))],
    ["expired", sign(claims({ iat: nowS - 900, nbf: nowS - 900, exp: nowS - 120 }))],
    ["not yet valid", sign(claims({ nbf: nowS + 600 }))],
    ["lifetime too long", sign(claims({ exp: nowS + 7200 }))],
    ["no run_id", sign(claims({ run_id: 17 }))],
    ["unknown kid", sign(claims(), { kid: "nope" })],
    ["bad signature", sign(claims(), { key: other.privateKey })],
    ["alg HS256 not accepted", sign(claims(), { alg: "HS256" })],
  ];
  for (const [reason, tokenP] of cases) {
    const r = await verify(await tokenP);
    assert.equal(r.ok, false, reason);
    assert.equal(!r.ok && r.reason, reason);
  }
  const good = await sign(claims());
  const [h, p] = good.split(".");
  assert.equal((await verify(`${h}.${p}.`)).ok, false, "empty signature");
  assert.equal((await verify(`${b64urlJson({ alg: "none", kid: "k1" })}.${p}.`)).ok, false, "alg none");
  assert.equal((await verify("not-a-jwt")).ok, false);
  // A payload swapped under a valid signature fails verification.
  const [, forged] = (await sign(claims({ repository: "evil/repo" }))).split(".");
  assert.equal((await verify(`${h}.${forged}.${good.split(".")[2]}`)).ok, false);
});

test("jwksKeySource: an unknown kid refetches, at most once per minRefetchMs", async () => {
  let fetches = 0;
  let t = 0;
  const src = jwksKeySource(async () => (fetches++, { keys: [jwk] }), { minRefetchMs: 60_000, now: () => t });
  assert.ok(await src("k1"));
  assert.equal(fetches, 1);
  assert.equal(await src("rotated"), null);
  assert.equal(fetches, 1, "inside the throttle window: no refetch");
  t += 61_000;
  assert.equal(await src("rotated"), null);
  assert.equal(fetches, 2);
  assert.ok(await src("k1"), "cached");
  assert.equal(fetches, 2);
});

test("jwksKeySource: a failed refetch keeps the keys it had", async () => {
  let fail = false;
  let t = 0;
  const src = jwksKeySource(
    async () => {
      if (fail) throw new Error("down");
      return { keys: [jwk] };
    },
    { ttlMs: 1000, minRefetchMs: 0, now: () => t },
  );
  assert.ok(await src("k1"));
  fail = true;
  t += 5000; // stale → refetch → fails
  assert.ok(await src("k1"));
});

const roster: Client[] = [
  { id: "alpha", owner: "acme", repo: "Alpha", installationId: 1, bucket: "ALPHA_R2", repositoryId: 987654321 },
  { id: "beta", owner: "beta-org", repo: "beta", installationId: 2, bucket: "BETA_R2" },
];

test("resolveNotifyTarget: maps repo + engine workflow to client and job", () => {
  const r = resolveNotifyTarget(claims({ repository: "ACME/alpha" }) as unknown as GithubClaims, roster);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.target.client.id, "alpha");
  assert.equal(r.target.job, "backup");
  assert.equal(r.target.runAttempt, 1);
  assert.equal(r.target.jobId, "50000000001");
  assert.equal(r.target.iatMs, (nowS - 5) * 1000);

  const files: [string, string][] = [
    ["pg-durable-verify.yml", "durableVerify"],
    ["pg-restore-drill.yml", "restoreDrill"],
    ["pg-archive.yml", "archive"],
  ];
  for (const [file, job] of files) {
    const t = resolveNotifyTarget(
      claims({ repository: "beta-org/beta", job_workflow_ref: `simonhac/the-gitfather/.github/workflows/${file}@v2` }) as unknown as GithubClaims,
      roster,
    );
    assert.equal(t.ok && t.target.job, job);
  }
});

test("resolveNotifyTarget: refuses strangers", () => {
  const r = (over: Record<string, unknown>) => resolveNotifyTarget(claims(over) as unknown as GithubClaims, roster);
  assert.deepEqual(r({ repository: "someone/else" }), { ok: false, error: "not_rostered" });
  assert.deepEqual(r({ repository_id: "1" }), { ok: false, error: "repository_id" }, "the roster pins alpha's id");
  assert.deepEqual(r({ job_workflow_ref: "acme/Alpha/.github/workflows/pg-backup.yml@refs/heads/main" }), { ok: false, error: "not_engine_workflow" });
  assert.deepEqual(r({ job_workflow_ref: "evil/the-gitfather/.github/workflows/pg-backup.yml@main" }), { ok: false, error: "not_engine_workflow" });
  assert.deepEqual(r({ job_workflow_ref: "simonhac/the-gitfather/.github/workflows/ci.yml@main" }), { ok: false, error: "not_engine_workflow" });
  assert.deepEqual(r({ run_id: "12x" }), { ok: false, error: "bad_claims" });
  assert.deepEqual(r({ run_attempt: "0" }), { ok: false, error: "bad_claims" });
  // A different engine repo (a fork) is honoured when configured.
  const fork = resolveNotifyTarget(
    claims({ job_workflow_ref: "me/the-gitfather/.github/workflows/pg-backup.yml@main" }) as unknown as GithubClaims,
    roster,
    "me/the-gitfather",
  );
  assert.equal(fork.ok, true);
});

test("resolveNotifyTarget: a missing or odd check_run_id leaves jobId null", () => {
  const a = resolveNotifyTarget(claims({ check_run_id: undefined }) as unknown as GithubClaims, roster);
  assert.equal(a.ok && a.target.jobId, null);
  const b = resolveNotifyTarget(claims({ check_run_id: 42 }) as unknown as GithubClaims, roster);
  assert.equal(b.ok && b.target.jobId, "42");
});
