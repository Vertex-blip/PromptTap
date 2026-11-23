# Security

PromptTap treats imported text as untrusted data. Archive instructions do not grant permissions to the application. The browser displays text safely, and Gemini receives selected excerpts as reference data.

## Deployment boundaries

GitHub Pages publishes only the static `public/` directory. Its configuration contains public URLs. The bot token, AI key, catalog, database, application secret, and webhook secret are not part of that artifact.

The Supabase Edge Function handles authenticated requests and Telegram webhooks. Postgres stores private application data in `prompttap_private`, with table privileges revoked from public client roles and row-level security enabled. Store operations pass through a constrained RPC that checks the application secret against its stored SHA-256 hash. Its `SECURITY DEFINER` execution has an empty search path, fixed operations, and validated inputs.

Backend settings are loaded through `prompttap_bootstrap`, callable only by the service role. These settings contain credentials and must be treated as secrets in database backups and administrative access. Supabase's service-role credential stays inside the Edge runtime. A publishable project key alone does not authorize catalog or application-data access.

## Request controls

- Protected Mini App endpoints verify Telegram HMAC data, reject duplicate or malformed parameters, and accept signatures for at most one hour, with 30 seconds of future clock tolerance. Signed session data can be reused within that window; it is a bearer credential and must remain private.
- Public `/health` and `/api/meta` reveal availability and catalog metadata only. Unsigned website visitors are directed to Telegram. Search, adaptation, original text, and downloads require a verified Telegram user.
- Browser CORS permits the configured Pages origin. CORS is separate from authentication and does not authorize clients by itself.
- Webhooks require a constant-time comparison of Telegram's secret header. Database leases claim update IDs and serialize work per user; completed updates are acknowledged without processing again. A crash after sending a Telegram message but before recording completion can still cause a repeated message on retry.
- Authentication precedes user-based limits. Request bodies and query lengths are bounded, and AI calls have timeouts, per-runtime concurrency limits, and a shared persistent quota.
- Telegram callbacks check the original search owner. Search sessions expire after seven days; favorites are scoped to the verified user. Mini App bookmarks use account-scoped browser storage.
- Catalog administration requires the separate application secret and rejects requests carrying a browser Origin header. Uploads have bounded bodies and record counts.

## Content and credential handling

- Browser rendering uses text content; Telegram HTML is escaped. Downloads use generated filenames. Retrieved archive content is never executed.
- Imports use bounded streaming, nesting and expansion limits, duplicate detection, and an import lock. Review-held records are excluded from normal retrieval.
- Git excludes local `.env`, database files, archives, and imported catalogs. The release scanner detects known credential formats and exact local secret values in tracked text files. It reports filenames only. Explicit fixture and placeholder values are excluded from exact-value matching; test source files are still scanned.
- Requests to Gemini include the task and a bounded source excerpt. Provider data handling follows the selected account's terms. Raw provider errors and incoming credentials are excluded from application error messages.
- API responses disable caching and content sniffing. The static page declares a content security policy that restricts scripts and API connections, plus a referrer policy. The Node hosting alternative also applies Helmet headers. GitHub Pages controls static response headers; the Node server's headers do not apply to Pages.

## Operating requirements

Restrict repository, Supabase project, database, and AI account administration. Use independent random application and webhook secrets. Keep local environment files and database backups readable only by trusted operators. After rotating backend settings, redeploy the Edge Function to refresh cached configuration and update the Telegram webhook secret where applicable.

Do not start local polling for the deployed bot while its webhook is active. For the Node/Docker alternative, set `NODE_ENV=production`, terminate HTTPS at a reverse proxy, configure its exact trusted address, and use one polling process per token. Keep the private catalog and database outside public file hosting. Back up SQLite consistently when using local storage.

The bot stores Telegram user IDs, language preferences, favorites, short-lived searches, quota counters, and webhook processing state. Keep only necessary operational logs. Review provider quotas, database backups, dependency updates, and access permissions regularly. Free hosting does not guarantee continuous availability.

Content review and task checks are heuristic and may produce false positives or false negatives. Passing tests, a secret scan, and a dependency audit describe checks at a particular revision; they cannot guarantee the absence of every vulnerability or misuse.

## Reporting

Use the repository's private vulnerability reporting feature if available. Include reproduction steps, the affected revision, and expected behavior. Remove credentials, personal data, and production prompt contents. Rotate any credential exposed outside its intended access scope.
