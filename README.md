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

Run `npm run db:migrate` again whenever a new file appears in `database/`. Migrations are idempotent, and sign-in depends on the `auth_throttle` table from `003_security_hardening.sql`.

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

- FactorCloud invoice pagination/filter semantics still need to be confirmed before dashboard totals are treated as complete account figures.
- True open A/R, NFE, reserve, funding, aging, and payment metrics should only be labeled as such after the corresponding FactorCloud fields/endpoints are mapped.
- Debtor search is not yet proven, so candidate debtor IDs can still be configured with `FACTORCLOUD_DEBTOR_IDS`.
- Only the FactorCloud `INVOICE` document type has been manually proven. Other classified types currently fall back to `INVOICE` if FactorCloud rejects them with a 400.
- A proper FactorCloud machine-to-machine or service credential is still preferred before a real client pilot.
- Feature switches are packaging/UI controls, not authorization controls.

## Why amount/date rules are conservative

A rate confirmation and invoice can legitimately differ because of accessorials. Differences therefore produce REVIEW rather than FAIL. BOL/POD document dates are not compared with invoice dates because they represent different events.
