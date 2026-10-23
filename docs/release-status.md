# Release status

The repository is a pre-release. A real Codex `0.163.0` proposal turn passed against an adversarial synthetic article snapshot with the default model, one bounded turn, no real external data requests, and no production reads or writes. Evidence: `work/codex-smoke-3ce7e5a4-83f2-4310-918d-f90f49675898.json`.

The real Skill lifecycle smoke also passed: one reflection, three replays, activation, and restoration of the original baseline, with four model calls and zero production reads or writes. Evidence: `work/skill-lifecycle-smoke-789909df-7aa0-4df1-a85e-2ac1a2f34be1.json`.

The current readonly snapshot contains 10 unique WordPress posts. Real Codex generated one pending production-data proposal; it has not been approved or written to production. Existing WordPress, GSC, and GA4 service-account access is readonly for inspection.

The disposable real WordPress apply/public-readback/rollback fixture passed with both the deterministic agent and real Codex. Both runs restored the original body and cleaned up their containers and volumes, with zero production writes. Evidence: `work/siteops-test-c6fca5a7/result.json` and `work/siteops-test-176f8bdd/result.json`.

A fresh installation passed the documented checks. After the final automatic-table-of-contents compatibility change, lint, build, typecheck, all 116 tests, and the CI-equivalent Chromium browser journey passed again. Independent verification confirmed the table-of-contents fixture and 38 security/writer checks. The source inventory scan passed for 73 files; this is a heuristic check, not a guarantee that all secrets or security issues have been detected.

The production read-only preflight passed: the pending proposal still matches the authenticated original, and public REST plus the public page pass read-back. Release gates remain open: reviewed single-article production acceptance and GitHub publication. Production writes still require concrete human approval.

The following claims require later evidence and must not be inferred from this repository:

- live WordPress E2E success;
- production readiness or unattended operation;
- ranking, traffic, CTR, GEO, or ROI improvement;
- a successful 28-day observation result.

The intended verification commands are `npm run check`, `npm run smoke:codex`, `npm run test:wordpress`, and (with local Chromium available) `npm run test:e2e`. The Codex smoke uses a local fake snapshot; the WordPress test uses a disposable local Docker fixture and no production credentials. CI includes the deterministic real WordPress fixture; real model calls require a local operator login. CI does not receive production credentials, deploy, publish, or mutate an external site.
