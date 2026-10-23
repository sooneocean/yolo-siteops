# Changelog

## 0.1.3 — 2026-10-23

- Reconcile the exact WordPress bare-paragraph removal plus doubled-LF format without another content write; retain the original transformation unchanged.
- Reject unsupported markup, whitespace-sensitive content, malformed nesting, and any byte changes outside the selected versioned transformation.
- Bind the displayed transformation and actual state hash through review, acceptance, atomic receipt persistence, replay and restart repair.
- Preserve immutable apply receipts, backups and completed legacy paragraph-format acceptances; reject cross-transform tampering and stale review state.
- Show the precise formatting change in the workbench and verify both recovery journeys without an apply request.
- Verify 239 tests, two browser journeys, independent security review and a single operator-approved production reconciliation. The remaining two proposals stay pending; production writes still require individual approval.

## 0.1.2 — 2026-10-23

- Add source-owned read-only pipeline inspection and bounded weekly Skill candidate/replay commands, without private helper imports or production path defaults.
- Reserve the weekly claim, four model calls, and cooldown atomically; serialize article creation against running weekly work across processes.
- Enforce a shared daily hard cap of ten for article and Skill calls, rejecting malformed persisted limits and counters.
- Block new weekly runs behind unresolved running or malformed claims from any week; preserve failed and unknown outcomes without automatic retry or refunds.
- Enforce a ten-minute lifecycle deadline and two-minute call deadline, discard late results, and retain human approval for articles and Skill activation.
- Project private state through a closed report schema with bounded observed queries, explicit audience hypotheses, independent live page totals, and unknown measurement states.
- Verify the complete synthetic proposal-only pipeline, two-process contention, failure cases, private-data canaries, and unchanged live records. The first scheduled live weekly Skill run remains pending its future eligibility gates.

## 0.1.1 — 2026-10-23

- Add closed, safe proposal failure codes and actionable task messages without exposing raw model output or exception details.
- Derive canonical output guidance from the existing HTML policy without relaxing validation.
- Edit one eligible Gutenberg paragraph while preserving every block delimiter and all surrounding content exactly; reject malformed, unsafe, or unsupported input.
- Extend the native editorial deadline to 180 seconds while preserving explicit shorter limits, cancellation, and single-call execution.
- Expand coverage to 194 tests, including synthetic 67-block preservation cases and deadline regressions.
- Verify two new real editorial proposals remain pending approval, with no additional WordPress writes. Historical failures remain unchanged because their original exception categories were not recorded.

## 0.1.0 — 2026-10-23

- Local React operations workbench with task progress, demand review, article approval, and outcome tracking.
- WordPress, Search Console, and GA4 adapters with bounded snapshots and explicit evidence coverage.
- Codex app-server proposal generation using the operator's local login and default model.
- Human-approved body edits, protected-state checks, backups, shared writer locks, read-back, and separately approved rollback.
- Skill reflection, three synthetic replay cases, manual activation, and baseline restoration.
- Optional local daily and weekly schedules with durable execution records and daily model-call limits.
- Synthetic browser E2E, disposable real WordPress tests, and release source inventory checks.
- Explicit no-write acceptance of verified WordPress paragraph formatting, with immutable receipts, atomic persistence, restart repair, and rollback from the reviewed actual hash.
- Fresh public REST verification and strict, heading-validated automatic table-of-contents compatibility.

See `docs/validation.md` and `docs/release-status.md` for evidence and boundaries. This version does not establish traffic or ranking improvement.
