# Security

PromptTap treats imported text as untrusted data. The application displays text safely and sends selected excerpts to an AI provider as reference data. The catalog is kept outside the static web directory.

## Implemented controls

- Production API access requires verified Telegram Mini App HMAC data with a one-hour validity window. Modified, repeated, malformed, and future-dated parameters are rejected.
- Authentication precedes user-based request limits. Telegram callbacks verify the original search owner, and each user's updates retain their order.
- Queries and request bodies have size limits. Expensive operations have per-user limits, a global generation budget, timeouts, and bounded concurrency.
- SQLite statements use bound parameters. Search sessions expire after seven days. Telegram favorites are scoped to user IDs and Mini App favorites to the verified account identity.
- Archive text is rendered as text in the browser and escaped for Telegram HTML. Downloads use generated filenames.
- Archive traversal uses bounded streaming, nesting and expansion limits, duplicate detection, and an import lock.
- Credentials live in environment variables. Git excludes `.env`, database files, archives, and the imported catalog. A tracked-file scan checks for credentials before release.
- Production sets security headers and content policy. Docker runs without root privileges and with a read-only application filesystem.

## Operating requirements

Set `NODE_ENV=production` for public hosting. Keep `.env` readable only by the service owner. Terminate HTTPS at the reverse proxy and configure its exact trusted address. Keep the private catalog and database off public file hosting. Use one polling process per token and keep dependencies updated.

The bot stores Telegram user IDs, interface language, favorites, and short-lived searches. Mini App bookmarks remain in account-scoped browser storage. AI adaptation sends the task and a bounded source excerpt to the configured provider. API keys, complete incoming requests, and raw provider exceptions are excluded from application logs.

Content triage and local task checks use heuristics. They can produce false positives and false negatives. A passing test suite and dependency audit describe the checks performed at that revision. They provide no guarantee against every vulnerability or misuse.

## Reporting

Use the repository's private vulnerability reporting feature if available. Include reproduction steps, the affected revision, and the expected behavior. Remove credentials, personal data, and production prompt contents from reports. Rotate any credential that has been exposed outside its intended access scope.
