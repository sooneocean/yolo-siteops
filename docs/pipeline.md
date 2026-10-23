# Operations pipeline

The local service owns daily data synchronization and weekly proposal generation. A single operator automation inspects the durable state and can run the bounded weekly Skill candidate/replay tool. Keep one service per database. The computer and local app must remain available; this is not hosted uptime or automatic process recovery.

The sequence is:

1. Daily synchronization reads WordPress, final Search Console periods, and GA4 evidence.
2. Opportunity ranking uses independent page totals and observed queries. Audience interpretations are hypotheses; GA4 quality remains unknown when measurement checks fail.
3. Weekly scheduling queues up to three articles, excluding active posts. Successful generation stops at pending proposals.
4. Inspection reports the actual task and proposal outcomes. A completed weekly scheduling claim only means queueing completed.
5. After Monday 10:00 in Asia/Taipei, an eligible weekly Skill run creates one candidate and evaluates three fixed synthetic cases. The active Skill remains unchanged until a human activates a reviewed candidate.
6. Every production article apply, rollback, or formatting reconciliation requires separate human approval for its concrete reviewed change.

## Read-only status

Use an existing, absolute, canonical directory containing `siteops.sqlite`:

```bash
SITEOPS_DATA_DIR=/absolute/path/to/database-directory npm run pipeline:status
```

For these operator commands, `SITEOPS_DATA_DIR` means the final database directory, including a `live` subdirectory when applicable. Unlike the server's base-directory setting, the tools do not append a mode. They do not load the WordPress connection file or infer a production database.

The JSON report projects a fixed set of fields from a read-only SQLite transaction. It does not initialize state, call providers or models, or read writer payloads. It excludes article bodies, titles, URLs, private errors, connection messages, Skill text, credentials, and bootstrap/session material. Observed queries are bounded private analysis data; keep the report local. Missing, malformed, partial, or stale evidence must be reported rather than treated as zero or healthy. An absent scheduler health record is unknown, not a successful heartbeat.

## Weekly Skill candidate and replay

Both checking and running require three explicit local settings:

```bash
SITEOPS_DATA_DIR=/absolute/path/to/database-directory \
SITEOPS_PORT=4317 \
SITEOPS_CODEX_COMMAND=/absolute/path/to/verified/codex \
npm run pipeline:skill -- --check
```

Use the same settings with `--run` only when `--check` reports eligibility. The port must identify the operator's local service, and the database and executable must be the reviewed local paths. The TCP probe proves localhost liveness only; it cannot prove database or process ownership. The executable remains trusted operator configuration and must pass ownership and permission checks. The existing Codex adapter enforces the model execution policy; the tool cannot select a model or relax tool/network restrictions.

The run checks Monday timing, completed current-day daily and weekly claims, fresh evidence, readiness, no running tasks, no pending Skill, one active Skill, completed-task evidence, a seven-day cooldown, and room for four calls under the combined daily cap. Before the first model call, one SQLite transaction rechecks the database gates, claims the week, reserves all four calls, and records the cooldown. Article creation uses the same database transaction boundary and refuses a running weekly Skill job. The prepaid reflection/replay path consumes the reservation without charging twice.

The whole lifecycle has a ten-minute deadline and each native model call has a two-minute maximum. A failed, timed-out, or interrupted run retains its claim and reserved budget. There are no automatic retries or refunds. A hard crash can leave a running claim; inspect it and preserve the evidence for operator review. Do not delete the claim, change its key, or rerun to bypass an unknown result. Passing replay establishes the recorded safety/provenance checks, not traffic improvement.

## Automation ownership and acceptance

Do not run a second daily sync or weekly queueing loop from the operator automation. Inspect the service's durable daily/weekly claims, report meaningful changes, and invoke the Skill runner only at the allowed time and once per week. Existing pending article proposals do not stop daily analysis. Unchanged pending reviews should not cause repeated notifications.

The integration acceptance uses real scheduler/service/storage components with deterministic agents and synthetic WordPress/data providers. It checks synchronization through pending proposals and evaluated Skill candidates, duplicate execution, budget claims, failure handling, unchanged active Skill, and zero WordPress mutations. Live status/check execution is separate evidence. A synthetic Monday is never evidence that a future live Monday run has already occurred.
