# YOLO SiteOps

YOLO SiteOps is a local-first WordPress operations workbench. It reads evidence, proposes a bounded change for one post, and requires a human to approve, apply, and roll back each change when needed. Task events, proposal hashes, backups, and writer receipts remain available for review.

## Status

The v0.1.0 MVP has passed fresh installation, 140 tests, the Chromium journey, real Codex plus disposable WordPress apply/restore, and Skill reflection/replay checks. One human-approved production article acceptance also passed, including a separate acceptance record for server-side paragraph formatting. The verified Codex CLI is `0.163.0`.

See [`docs/validation.md`](docs/validation.md) for scope and limitations. These results prove the recorded MVP workflows; ranking, traffic, CTR, GEO, and ROI outcomes require later measurement.

## Requirements and demo

Use Node.js `22.13+` or `24+` and npm with the committed lockfile:

```bash
npm ci
npm run demo
```

The server binds to localhost and prints a one-time bootstrap URL. Demo WordPress, GSC, and GA4 data are synthetic. The demo checks the UI, API, SQLite, SSE, human approval, and demo writer flow; it is not live E2E evidence. The read-only sandbox is an application constraint, not an operating-system secret boundary.

Scheduling is off by default. If enabled, the local process must remain running. This repository does not deploy or publish automatically.

To verify the real Codex CLI against a local fake snapshot, use an already logged-in local CLI:

```bash
npm run smoke:codex
```

This smoke does not use production credentials or request real external data. It writes redacted evidence JSON under `work/`. `SITEOPS_CODEX_COMMAND` may select an absolute CLI executable path in the server environment; it does not override the model or login.

The WordPress writer check uses a disposable local Docker fixture:

```bash
npm run test:wordpress
```

The fixture uses synthetic article data, a temporary database, and a local Docker context. It does not use production credentials or connect to production WordPress. If a fixture stage fails, retain its evidence and do not describe it as live E2E.

## Live configuration

Keep private configuration, service-account JSON, application passwords, SQLite data, and `.env` files outside the repository. Point to a private JSON file with `SITEOPS_CONFIG_PATH`:

```bash
SITEOPS_MODE=live \
SITEOPS_CONFIG_PATH=/private/path/siteops-config.json \
SITEOPS_AGENT=codex \
npm start
```

See [`config.example.json`](config.example.json) and [`docs/configuration.md`](docs/configuration.md). WordPress must be a fixed HTTPS origin. GSC uses `webmasters.readonly`; GA4 uses `analytics.readonly`; WordPress writes use an application password.

On a fresh checkout, run `npm ci` and `npm run build` before the live startup command. Connection credentials remain on the server; the browser uses only its local workbench session.

Codex uses the installed, logged-in CLI with its default model. SiteOps does not provide a model override. Live mode requires `SITEOPS_AGENT=codex`.

## Safety boundary

Live sync reads WordPress with `context=edit`, then checks the base hash, stores a backup, takes the writer lock, and verifies authenticated and public read-back. Unknown write outcomes, drift, mismatches, and uncertain rollbacks stop in `review_required`.

Every post needs human approval. SiteOps does not publish automatically. A 28-day observation period is a future measurement design; results cannot be claimed in advance.

See [`docs/architecture.md`](docs/architecture.md), [`CONTRIBUTING.md`](CONTRIBUTING.md), and [`SECURITY.md`](SECURITY.md).

## Verification

```bash
npm run check
npm run test:e2e
npm run smoke:codex
npm run test:wordpress
```

`npm run test:e2e` uses local Chrome by default; `CI=1 npm run test:e2e` uses Playwright Chromium. Install Chromium with `npx playwright install chromium` before the CI-equivalent run. CI also runs the disposable WordPress fixture with the deterministic agent. These checks do not receive production credentials, deploy, publish, or mutate an external site. This repository does not auto-deploy or auto-release.
