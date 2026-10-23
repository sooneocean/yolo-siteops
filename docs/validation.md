# Validation record — v0.1.0 MVP

Recorded on 2026-10-23. Credentials, production post identifiers and bodies, analytics data, session material, SQLite files, and raw model output are excluded from this repository.

| Layer | Evidence and scope |
| --- | --- |
| Installation | Fresh `npm ci --ignore-scripts --no-audit --no-fund` succeeded with the committed lockfile. |
| Static and unit checks | `npm run check` passed lint, typecheck, build, and 140 tests across 12 files. |
| Browser | `CI=1 npm run test:e2e` passed the guarded demo journey. The recovery UI portion uses synthetic route responses; backend recovery is separately covered by integration tests. |
| Recovery | 19 tests cover exact formatting, session/CSRF, drift, immutable receipts, atomic faults, restart repair, observation hashes, successful rollback, and stale-apply replay. |
| Real agent | Codex CLI 0.163.0 completed an adversarial synthetic article turn using its default model and no tools. Raw prompts and outputs were not retained. |
| WordPress fixture | Disposable WordPress 7.1.3/MariaDB 11.4 passed apply/public-readback/restore with deterministic and real Codex agents. Fixtures cleaned up their containers and volumes. The final deterministic fixture passed after cache and recovery changes. |
| Skill | One real reflection, three synthetic replays, candidate activation, and baseline restoration passed with four model calls and no production access. |
| Production | One operator-approved article write, exact formatting review, explicit browser acceptance, and fresh authenticated/public read-back passed. Reconciliation performed no additional WordPress write. Backup and original apply receipt remain. |
| Review | Independent security review and outcome verification passed; stale-apply replay was fixed and independently rechecked. |
| Inventory | `npm run check:release` passed. This heuristic check does not guarantee detection of all secrets or security issues. |

The production result is `verified_transformed`, not a relabelled exact `applied` result. Public REST uses a server-generated cache nonce; the public page retains its canonical URL and refuses redirects. Stale content still fails verification.

An observation has started. No complete 28-day result or causal ranking, traffic, CTR, GEO, or ROI result exists yet. HTML text read-back does not evaluate computed CSS visibility. Hashing covers metadata exposed by authenticated REST.

Real Codex checks require a local operator login. Production acceptance requires human approval. Neither runs in pull-request CI.
