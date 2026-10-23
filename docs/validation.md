# Validation record — v0.1.1

Recorded on 2026-10-23. Credentials, production post identifiers and bodies, analytics data, session material, SQLite files, and raw model output are excluded from this repository.

## v0.1.0 baseline

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
| Remote CI | [GitHub run 39904345214](https://github.com/sooneocean/yolo-siteops/actions/runs/39904345214) passed checks, Chromium, and disposable WordPress on the release implementation. |

The production result is `verified_transformed`, not a relabelled exact `applied` result. Public REST uses a server-generated cache nonce; the public page retains its canonical URL and refuses redirects. Stale content still fails verification.

A restart of the live workbench preserved proposal, task, experiment, backup, and receipt records without changes.

An observation has started. No complete 28-day result or causal ranking, traffic, CTR, GEO, or ROI result exists yet. HTML text read-back does not evaluate computed CSS visibility. Hashing covers metadata exposed by authenticated REST.

Real Codex checks require a local operator login. Production acceptance requires human approval. Neither runs in pull-request CI.

## v0.1.1 proposal-generation repair

The repair passed local lint, typecheck, build, 194 tests across 15 files, the guarded browser journey, and the source inventory check. Synthetic 67-block cases cover bounded paragraph editing, malformed input, unsafe input, immutable surrounding markup and one-call execution. A native service regression verifies the 180-second editorial deadline while explicit shorter callers retain their limits.

Two real editorial tasks produced new pending proposals without approval or WordPress writes. The block article retained every delimiter and all content outside the selected text span. Historical failed records were preserved because their original exception categories were not stored; current reproduction results do not establish those historical causes.

An initial operator verification recorded `review_required` after an incomplete read-back. That record remains unchanged. Subsequent separate read-only checks verified all three guarded WordPress hashes and unchanged existing proposals, backups and receipts. No model or mutation was replayed to complete those checks. This validates the recorded proposal-only workflow, not production publication or traffic impact.

Independent outcome verification confirmed the local artifacts, SQLite state, byte-preservation contract and new-path regressions, rerunning 63 targeted tests and typecheck without network, model calls or WordPress writes. It did not independently repeat the remote read-backs or the complete browser journey.
