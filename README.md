# FactorCloud Client Portal

A FactorCloud add-on platform with two views:

- Client portal: one factor client sees only its own dashboard, invoices, submissions, and alerts.
- Factor operations: factor staff can work across clients, review exceptions, and drill into client accounts.

FactorCloud remains the system of record for factoring/accounting records. The portal database stores identity, workflow state, file integrity metadata, review decisions, idempotency, and audit history.

## Current portal modules

- Dashboard: invoice activity, recent statuses, concentration summary, alerts, and quick actions.
- Invoices: searchable invoice history from FactorCloud.
- Submit invoice: AI extraction plus deterministic validation before creating the invoice in FactorCloud.
- Batch upload: cautious grouping of mixed invoice/support-document stacks.
- Alerts: V1 debtor-concentration and invoice-volume signals.
- Factor operations: factor-wide client overview, client drill-down, and review queue.

## Security model

Client paperwork is treated as untrusted input.

- Uploaded files are SHA-256 fingerprinted when analyzed.
- The server signs the original AI extraction and file metadata.
- Submit requires the exact files that were analyzed.
- Client edits do not replace the original evidence and force REVIEW.
- Client-facing FactorCloud data requires an exact client ID match.
- Database authentication supports `CLIENT_USER`, `FACTOR_REVIEWER`, and `FACTOR_ADMIN` roles.
- REVIEW decisions and submission events can be stored in the portal database audit trail.
- Verification receipts are signed with the dedicated `PORTAL_SIGNING_SECRET` (required, no fallback) and expire after 24 hours.
- Factor operations (`/ops`, `/api/ops`) exist only with database authentication. In pilot mode they return 404.
- Every protected API re-checks the signed session against the database, so deactivating a user or changing their role or client assignment takes effect on their next request.
- Sign-in is throttled per email (5 failures per 15 minutes) and per client IP (25 per 15 minutes), each with a 15-minute lock.
- Unexpected server errors are logged with a reference and never returned to the browser.
- A submission can be retried only when FactorCloud definitively refused the create (a 4xx response, so no invoice exists). Uncertain failures stay blocked until the factor checks FactorCloud.

## Development database

The app uses ordinary PostgreSQL. A free hosted Postgres database such as Neon is convenient during development. Production can point the same `DATABASE_URL` at FactorCloud's PostgreSQL/RDS instance without changing the schema.

After creating a development Postgres database:

```bash
npm install
DATABASE_URL='postgresql://...' DATABASE_SSL=true npm run db:migrate
DATABASE_URL='postgresql://...' DATABASE_SSL=true FACTORCLOUD_FACTOR_ID='...' FACTORCLOUD_CLIENT_ID='...' npm run db:bootstrap
```

`db:bootstrap` creates or updates:

- the sandbox factor record
- the configured client portal record
- one factor admin user
- one client user mapped to that client

If `DEV_FACTOR_ADMIN_PASSWORD` and `DEV_CLIENT_USER_PASSWORD` are omitted, strong random passwords are generated and printed once.

Then set these application environment variables:

```text
PORTAL_AUTH_MODE=database
DATABASE_URL=postgresql://...
DATABASE_SSL=true
AUTH_SESSION_SECRET=<long random value>
PORTAL_SIGNING_SECRET=<a different long random value>
```

The security objects from `003_security_hardening.sql` (the `auth_throttle` table and `submissions.idempotency_released_at`) are created by the app itself on first use, so no manual step is needed on deploy. This needs a database user with CREATE/ALTER rights. If the app's user is restricted, run `npm run db:migrate` once with an admin user instead; the app then only checks that the objects exist. Migrations are idempotent and safe to re-run.

## Local setup

```bash
cp .env.example .env.local
npm install
npm run dev
```

Required for document extraction:

- `GEMINI_API_KEY`

Required for live FactorCloud comparisons/create:

- `FACTORCLOUD_FACTOR_ID`
- `FACTORCLOUD_CLIENT_ID`
- `FACTORCLOUD_DEBTOR_IDS`
- `FACTORCLOUD_BEARER_TOKEN` for the server-side integration

Interactive FactorCloud staff OTP login should remain disabled for client deployments.

## Demo mode

For sales demos, click **Load demo data** in the sidebar. That browser then sees a synthetic portfolio built in `lib/demo-data.ts` (20 clients, 60 debtors, about 15 months of invoices) until you click it again; everyone else keeps seeing the real portal. While it is on, a **Client | Staff** switch at the top of the sidebar moves between the client portal and the factor view. The same switch appears for signed-in factor staff outside demo mode.

- `NEXT_PUBLIC_DEMO_TOGGLE=false` hides the switch and makes the server ignore it. Set this on client-facing sites.
- `NEXT_PUBLIC_DEMO_MODE=true` puts the whole site in demo mode, for a dedicated demo deployment. FactorCloud credentials, the database and `GEMINI_API_KEY` are then all optional.
- The switch is a browser cookie that only swaps real data for fake data. It never signs anyone in: with database sign-in you still sign in first, and with the shared password the password still applies. Without database sign-in the factor pages open only while demo data is on.

- Nothing is sent to FactorCloud and nothing is written to the database. Creates, uploads and review decisions are kept in memory until the server restarts.
- Every screen shows a "Demo data" badge.
- With `NEXT_PUBLIC_DEMO_MODE=true`, the factor pages (`/ops`) are open without sign-in. `APP_ACCESS_PASSWORD` still puts the whole site behind a shared password.
- Without `GEMINI_API_KEY`, document reading returns canned fields for Acme Manufacturing LLC. Files in one packet share the load number in their file names (for example `invoice-LD448213.png`), so a matching packet passes. Give one file a different number to show a mismatch being caught.
- Planted stories: Acme Manufacturing holds about 42% of the portal client's volume, the portal client had a volume spike this week, it has open invoices past 90 days, Lone Star Haulers holds about 20% of the factor's open A/R, and days to collect improve over the year.

Changing either `NEXT_PUBLIC_` setting needs a rebuild, because Next.js inlines those values into the browser bundle. The switch itself needs no rebuild.

## Fix requests

In the review queue, **Request fix…** sends the client a message (for example "Signed POD is missing") instead of rejecting. The client sees it on their dashboard and on the invoice, uploads the corrected paperwork, and it is attached to the same FactorCloud invoice through FactorCloud's add-documents endpoint. The item stays in the queue, marked "Waiting on client" and then "Client responded", until someone approves or rejects it. Fix requests need database sign-in; their tables are created automatically (or by `database/004_client_tasks.sql`). There are no email notifications yet; clients see requests when they open the portal.

## Debtor credit check

When a packet is verified, the portal reads the client–debtor credit terms from FactorCloud (`GET /clients/{client}/debtors/{debtor}`: `creditLimit`, `creditLimitApproved`) and adds up what that debtor still owes on the client's unpaid invoices. The submit page shows how much of the limit is in use and where this invoice lands. The invoice goes to review, not blocked, when it would pass the limit, when the limit isn't approved, or when FactorCloud marks the debtor as not approved for purchase. The check runs again with fresh balances at submit time. If FactorCloud can't be reached, the check is skipped rather than blocking.

## Connection check

`/connection` runs a read-only tour of every FactorCloud call the portal uses. It covers:

- sign-in and the client record;
- the invoice list (every page) and one invoice in detail;
- credit terms for the busiest debtor;
- the matchable debtors.

It also shows how much of the invoice data comes back filled in, and which statuses FactorCloud actually sends. **Copy report** gives a plain-text summary that contains no secrets. Nothing is created or changed. Creating invoices and attaching documents are deliberately not exercised; submit one test invoice to confirm those. With database sign-in it is for factor staff; with the shared password, the link sits at the bottom of the client sidebar.

## Debtors view

`/ops/debtors` ranks debtors across all clients by open balance. Each debtor shows:

- how old its open balance is;
- how much is past 90 days;
- its amount-weighted days to pay over the last 180 days;
- how many clients it owes;
- flags for concentration, 90+ day balances, slow payers and disputes.

## Extraction model

The current default is `gemini-3.5-flash-lite` with minimal thinking. The extractor is isolated in `lib/extract.ts`, so the model can be changed with `EXTRACTION_MODEL` if real paperwork shows quality problems.

AI reads and classifies documents. Matching, comparisons, duplicate protection, and create gating are deterministic code.

## Deployment portability

The repository includes a `Dockerfile`, so the app can be run outside Vercel:

```bash
docker build -t factorcloud-portal .
docker run -p 3000:3000 --env-file .env factorcloud-portal
```

A likely production target is AWS ECS/Fargate with PostgreSQL on RDS, secrets in AWS Secrets Manager, and object storage in S3 if the portal later needs retained file storage.

## Important V1 limitations

- Invoice lists are read page by page (FactorCloud's `X-PAGINATION-NUM` / `X-PAGINATION-LIMIT` headers; there is no total count) until the last page, filtered by `client` where only one client's data is shown. If the list can't be read to the end, dashboards say their totals may be incomplete, and the duplicate check puts the submission into REVIEW instead of passing it silently.
- True open A/R, NFE, reserve, funding, aging, and payment metrics should only be labeled as such after the corresponding FactorCloud fields/endpoints are mapped.
- Debtor search is not yet proven, so candidate debtor IDs can still be configured with `FACTORCLOUD_DEBTOR_IDS`.
- Only the FactorCloud `INVOICE` document type has been manually proven. Other classified types currently fall back to `INVOICE` if FactorCloud rejects them with a 400.
- A proper FactorCloud machine-to-machine or service credential is still preferred before a real client pilot.
- Feature switches are packaging/UI controls, not authorization controls.

## Why amount/date rules are conservative

A rate confirmation and invoice can legitimately differ because of accessorials. Differences therefore produce REVIEW rather than FAIL. BOL/POD document dates are not compared with invoice dates because they represent different events.
