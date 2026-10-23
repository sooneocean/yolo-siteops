# Configuration

Demo mode is the default:

```bash
npm run demo
```

Live mode requires `SITEOPS_MODE=live`, `SITEOPS_CONFIG_PATH` pointing to a private JSON file outside the repository, and `SITEOPS_AGENT=codex`. The config shape is shown in [`../config.example.json`](../config.example.json). Never copy real values into that example.

The WordPress `siteUrl` must be an exact HTTPS origin without credentials, port, path, query, fragment, or redirect. `username` and `appPassword` are used only server-side. `googleServiceAccountKeyPath` points to a private key file. The reader requests only `https://www.googleapis.com/auth/webmasters.readonly` and `https://www.googleapis.com/auth/analytics.readonly`; grant the service account access to the specific GSC property and GA4 property.

`SITEOPS_CONFIG_PATH` and `SITEOPS_MODE` select the runtime. `SITEOPS_DATA_DIR` selects local SQLite state. `SITEOPS_PORT` defaults to `4317`. `SITEOPS_BOOTSTRAP` is useful for tests/demo only; live bootstrap remains process-local and one-time. Keep `.env*` out of version control.

Scheduling is disabled in initial settings. Enabling it changes local state only; a local SiteOps process must remain running for schedules to execute. There is no hosted scheduler or automatic deployment.

`SITEOPS_CODEX_COMMAND` optionally selects an absolute Codex executable path from the server environment. It is never accepted through the browser or the connection JSON. Validate the CLI with `npm run smoke:codex` before using live mode. The currently verified CLI is `0.163.0`; older clients may be incompatible with the account's selected model. Updating the executable does not change the selected model or login, and this variable cannot override the model.

`npm run smoke:codex` uses a local adversarial synthetic article snapshot and writes redacted evidence under `work/`; it does not use production credentials or request real external data. `npm run test:wordpress` uses a disposable local Docker WordPress fixture with synthetic data and temporary state. It must not be pointed at production, and a fixture failure does not establish live E2E failure or success.

The fixture defaults to the local `desktop-linux` Docker context. On a local Linux engine, use `SITEOPS_DOCKER_CONTEXT=default`. Remote Docker endpoints and `DOCKER_HOST` are rejected. `SITEOPS_TEST_AGENT=codex` enables one real model turn against the synthetic fixture; the default `demo` mode requires no model login. Each run uses its own Compose project and removes only that project's containers and volumes. Model calls are never part of CI.

The Google key must be an absolute path to a regular private file (POSIX permissions such as `0600`). Symlinks and files accessible to group/other users are rejected. SiteOps never changes permissions on existing credential files.

Run one SiteOps server per data directory. Use separate data directories for development, E2E, and live operation. A failed or interrupted scheduled run is durably recorded and is not automatically retried. Each tick catches up only the latest due daily/weekly job.
