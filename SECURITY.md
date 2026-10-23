# Security policy

## Scope

Please report vulnerabilities in the local server, session bootstrap, configuration handling, Codex adapter, data readers, writer, or evidence/state handling.

## Reporting

Do not include credentials, cookies, service-account keys, private URLs, post bodies, or production identifiers in an issue. Use a private security channel maintained by the project when one is available; otherwise open a minimal issue asking for a private contact route and include only a redacted reproduction. The project has no guaranteed response or bounty SLA yet.

## Safe operation

Keep private JSON configuration, Google service-account files, and WordPress application passwords outside the repository. Runtime SQLite files and logs belong in ignored private directories such as `.siteops/` and `work/`; never include them or `.env*` in Git. The localhost bootstrap is one-time and should be treated as a credential. The read-only agent sandbox is an application-level control and does not protect OS secrets or a compromised host.

Live writes require a fresh authenticated snapshot, base hash, backup, writer lock, one-time approval, and authenticated/public read-back. Stop for unknown outcomes, drift, mismatch, or uncertain rollback and inspect the external system manually. Do not retry an unknown POST with a new topic, filename, or run identifier.

Public read-back compares normalized HTML text and canonical URLs. It does not evaluate computed CSS visibility; text hidden by a theme or stylesheet still requires browser inspection. Protected-state hashing covers the metadata exposed by the authenticated REST response, not unexposed WordPress metadata.
