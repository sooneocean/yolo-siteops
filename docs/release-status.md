# Release status

The v0.1.1 patch adds safe proposal diagnostics, policy-derived output guidance, bounded Gutenberg paragraph editing, and a 180-second native editorial deadline. Local lint, typecheck, build, 194 tests across 15 files, the Chromium journey, source inventory, independent security review and outcome verification passed. Two real editorial proposals remain pending human approval; this patch performed no additional production WordPress writes. Historical failed records remain unchanged. See [validation.md](validation.md) for the read-only reconciliation evidence and its limits.

## v0.1.0 baseline

The v0.1.0 MVP has completed local engineering and one operator-approved production article acceptance. Source is public at [sooneocean/yolo-siteops](https://github.com/sooneocean/yolo-siteops). [GitHub CI](https://github.com/sooneocean/yolo-siteops/actions/runs/39904345214) passed checks, Chromium, and the disposable WordPress job on the release implementation.

Validation covers fresh installation, lint, typecheck, build, 140 unit/integration tests, the Chromium journey, real Codex generation, disposable real WordPress apply/public-readback/rollback, and Skill reflection/replay/activation/baseline restoration. See [validation.md](validation.md).

The production acceptance required exactly one WordPress apply request. WordPress removed bare paragraph wrappers, so the exact authenticated hash gate correctly recorded `review_required`. The operator separately accepted the reviewed actual hash through the browser. An immutable `reconcile/verified_transformed` receipt records that no-write acceptance; the original apply receipt remains unchanged. Fresh authenticated and public read-back passed, a backup remains available, the task is complete, and the observation uses the actual state hash.

These results do not establish unattended production readiness, whole-site optimization, ranking/traffic/CTR/GEO/ROI improvement, or a successful 28-day measurement. Scheduling starts disabled. Future production changes and rollback still require separate operator approval.

CI receives no production credentials or model login. It runs checks, the synthetic Chromium journey, and a disposable WordPress fixture with the deterministic agent. It does not deploy, publish articles, or mutate an external website.
