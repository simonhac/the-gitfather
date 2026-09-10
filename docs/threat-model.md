# Where this fits: 3-2-1-1-0

**3-2-1-1-0** is the hardened evolution of the classic 3-2-1 backup rule:

| Digit | Rule | What it's for |
|---|---|---|
| **3** | ≥3 copies of the data | One primary + two backups, so no single loss is fatal |
| **2** | on ≥2 different media | Different *failure domains* — a flaw that kills one medium doesn't kill both |
| **1** | ≥1 copy off-site | Survives a site-level disaster (fire, theft, region outage) |
| **1** | ≥1 copy immutable / offline | Survives ransomware or a leaked/malicious credential that tries to delete backups |
| **0** | **0** recovery-verification errors | A backup you've never restored is a hope, not a backup — prove it restores |

The last two digits are what most setups skip, and they're exactly where this tool is strong. Here's
the honest mapping of what the-gitfather delivers:

| Digit | Coverage | How |
|---|---|---|
| **3** copies | ⚠️ partial | Manages **one** backup destination (a single R2 bucket). The GFS tiers are point-in-time *versions of the same dump in the same bucket* — more restore points, not independent copies. Your production DB is copy #1 (the source, not the tool's job); R2 is copy #2; a 3rd copy is on you. |
| **2** media | ❌ not provided | Every copy the tool writes lives on one medium / provider / failure domain (R2). "2 media" only exists incidentally because your prod DB lives elsewhere. |
| **1** off-site | ✅ delivered | Dumps go to Cloudflare R2 — a different provider and location from your Postgres host. |
| **1** immutable | ✅ delivered* | R2 bucket locks (WORM) + a no-delete CI token make the durable tiers immutable for 14 days against the primary threat (a leaked CI key). *It's immutable, not air-gapped — a full account takeover can strip the locks. See [Threat model](#threat-model). |
| **0** errors | ✅ delivered | Each backup carries a SHA-256 and is structurally validated (`pg_restore -l`) before it's declared good; `verify-durable-pg.ts` then proves **every** durable copy — hash-checked on write, full-restored daily (the freshest dump) and again at ~2 weeks (weekly/monthly) — with row-count gates, a `pg_restore`-error classifier, and failed drills recorded to the log. Backed by the staleness check (size + freshness), Slack status, and an external dead-man's switch. |

**Net:** the tool nails the back half (**1-1-0**) and supplies **one off-site copy** toward the front
half — it does not by itself give you 3 independent copies on 2 distinct media. To earn the full
**3-2-1-1-0**, add a second, independent backup leg on a different medium / failure domain (e.g. a
periodic `pg_dump` to local disk/NAS, or replicate the R2 bucket to another provider or region). The
dump this tool already produces is the natural feed for it.

## Threat model

- **Leaked CI R2 key** (primary threat): scoped read+write, no delete → cannot delete/overwrite objects,
  cannot empty the bucket while locks exist, cannot touch lock/lifecycle config. The last 14 days of
  durable backups are immutable.
- **Leaked `PG_BACKUP_DATABASE_URL`**: the master DB credential and the highest-value secret here.
  Mitigations (a read-only role, ephemeral creds, server-side push) and at-rest encryption are the
  obvious next steps.
- **Full Cloudflare-account takeover**: can remove bucket locks (R2 has no COMPLIANCE "even-root-can't-
  delete" mode). Accepted for a DR / leaked-token model.
- **At rest**: with `encryption: none`, dumps sit unencrypted in a **private** bucket (R2 still encrypts at
  rest). Set `encryption: age` for client-side encryption if a full dump contains sensitive data.
