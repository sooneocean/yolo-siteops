# Architecture

YOLO SiteOps is a localhost application with a React/Vite web client and an Express server. The server owns the state machine and all credentials. The browser receives only session-scoped API access.

## Four screens

1. **Today** shows mode, connection health, pending approvals, and the live task activity strip.
2. **Demand radar** ranks observed search opportunities, keeps audience hypotheses separate from evidence, and creates bounded editorial tasks.
3. **Article review** shows a text diff and isolated preview, with separate approve/apply, reject, and approve/rollback actions.
4. **Outcomes and Skill** shows observation records, candidate/replay/activation history, baseline restoration, and the schedule switch (off by default).

## API and transport

The session bootstrap is `POST /api/session`; other API routes require the HttpOnly session cookie, and mutations also require the matching CSRF token and origin. The main routes are `/api/state`, `/api/connections/check`, `/api/sync`, `/api/tasks`, `/api/proposals/:id/*`, `/api/skills/*`, and `/api/settings`. Task progress is streamed by `GET /api/tasks/:id/events` using SSE and `Last-Event-ID`.

The Codex adapter starts the installed CLI app-server over stdio. Its preflight disables network search, apps, plugins, MCP, shell inheritance, and unrelated features; the adapter accepts only the structured proposal result. It uses the installed login and default model, with no model override.

## SQLite storage

SQLite is created under the configured data directory with mode `0700`, WAL journaling, a busy timeout, and one schema version. Records are JSON values keyed by kind and id. It stores snapshots, tasks, events, proposals, approvals, backups, receipts, settings, skills, and experiments. Live private WordPress snapshots stay in the local store and are never documentation fixtures.

## State machine

```text
queued -> running -> waiting_approval -> completed
                         |       \-> cancelled
                         \-> rejected/cancelled
waiting_approval -> approved -> applied -> observing
                         |                    \-> measured/insufficient/confounded
                         \-> review_required
applied -> rollback approved -> rolled_back
```

An interrupted task fails on restart rather than resuming implicitly. Consumed approvals without a durable receipt reconcile to `review_required`. Unknown WordPress outcomes, drift, or failed read-back stop the writer and require manual inspection.

## Evidence and writes

GSC and GA4 are read-only evidence sources. GSC uses a final complete window and page/query limits; GA4 is restricted to the configured hostname and marks measurement unknown when key-event, sampling, thresholding, or completeness checks fail. WordPress writes are body-only, bounded, backed up, locked, and verified through authenticated and public read-back. Human approval is required for every post.
