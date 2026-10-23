# Contributing

## Development

Use Node.js `22.13+` or `24+` and run:

```bash
npm ci
npm run check
npx playwright install chromium
npm run test:e2e
```

Keep changes focused. Do not add private paths, real metrics, post IDs, credentials, service-account material, or production configuration to source, fixtures, screenshots, logs, or documentation.

## Runtime boundaries

Demo data is synthetic and must be labelled as such. A successful demo or unit test does not prove live E2E. Scheduling remains off by default. Any live write must remain human-approved, one post at a time, with rollback evidence.

Do not claim traffic, ranking, CTR, GEO, ROI, or a 28-day result before a complete measurement window exists. This repository does not auto-deploy or auto-release.

## Pull requests

Describe the user-visible behaviour, safety boundary, tests run, and any unverified live boundary. Do not commit generated `dist/`, `.siteops/`, SQLite, reports, or environment files.

## Versioned releases

Record user-visible changes in `CHANGELOG.md`. Keep the version in `package.json` and `package-lock.json` aligned, run the documented checks from a fresh install, and review the release inventory before creating a version tag. Real Codex checks require an operator's local login; production acceptance requires a separate, concrete human approval and must never run in pull-request CI.

Use GitHub issues and pull requests for the next bounded change. Publish a release only after its stated gates pass; keep unverified integrations and measurement results explicit in the release notes.
