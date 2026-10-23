# Changelog

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
