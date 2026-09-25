# FactorCloud Client Portal

Single-client portal template for FactorCloud clients. The first deployment is intentionally scoped to one FactorCloud client, with configuration and feature switches designed so the same codebase can be deployed for additional clients one at a time.

## Current portal modules

- Dashboard: invoice activity, recent statuses, concentration summary, alerts, and quick actions.
- Invoices: searchable invoice history using the FactorCloud invoice records currently available through the API.
- Submit invoice: AI extraction plus deterministic document validation before creating the invoice in FactorCloud.
- Batch upload: groups mixed invoice/support-document stacks into invoice packets and submits clean packets.
- Alerts: v1 debtor-concentration and invoice-volume signals.

## One client per deployment

For the first rollout phase, each deployment maps to exactly one FactorCloud client through `FACTORCLOUD_CLIENT_ID`. Display branding and module availability are configured separately with `NEXT_PUBLIC_PORTAL_*` and `NEXT_PUBLIC_FEATURE_*` variables.

This keeps client data isolated and makes it easy to sell/enable modules client by client without maintaining separate forks. If multi-tenant operation becomes useful later, the same module/config model can be moved behind authenticated tenant selection.

## Invoice verification flow

1. Upload an invoice and supporting PDF/image documents.
2. Gemini extracts structured fields only. It does not decide whether the packet passes.
3. FactorCloud debtor/client records are loaded server-side.
4. Deterministic TypeScript rules return PASS, REVIEW, or FAIL.
5. PASS can be submitted normally. REVIEW can be submitted into FactorCloud for manual review. FAIL remains blocked.
6. Before creation the server re-runs validation and checks FactorCloud for a duplicate invoice number.
7. The app creates the invoice, uploads the source files, and attaches them using the API sequence proven in the sandbox.

## Extraction model

The default is `gemini-3.1-flash-lite` with `minimal` thinking. The extractor is isolated in `lib/extract.ts`, so the model can be changed with `EXTRACTION_MODEL` if real paperwork shows quality problems.

AI is responsible for reading/classifying documents. Matching, comparisons, duplicate protection, and create gating are deterministic code.

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
- either `FACTORCLOUD_BEARER_TOKEN`, or username/password for the OTP flow

Portal display configuration:

- `NEXT_PUBLIC_PORTAL_CLIENT_NAME`
- `NEXT_PUBLIC_PORTAL_CLIENT_SHORT_NAME`
- `NEXT_PUBLIC_PORTAL_ENV_LABEL`

Per-client module switches:

- `NEXT_PUBLIC_FEATURE_INVOICES`
- `NEXT_PUBLIC_FEATURE_SUBMIT`
- `NEXT_PUBLIC_FEATURE_BATCH`
- `NEXT_PUBLIC_FEATURE_ALERTS`

V1 alert thresholds:

- `RISK_CONCENTRATION_REVIEW_PCT`
- `RISK_CONCENTRATION_HIGH_PCT`
- `RISK_VOLUME_SPIKE_RATIO`

For any deployed pilot, also set `APP_ACCESS_PASSWORD`.

## Important v1 limitations

- Debtor search is not yet proven, so candidate debtor IDs are configured in `FACTORCLOUD_DEBTOR_IDS`.
- Only the FactorCloud `INVOICE` document type has been manually proven. Other classified types currently fall back to `INVOICE` if FactorCloud rejects them with a 400.
- Duplicate checking currently scans the invoice list returned by `GET /invoices`. Before production, confirm pagination/filter semantics or add durable idempotency storage.
- The FactorCloud email OTP flow should be replaced with machine-to-machine integration credentials if FactorCloud provides them.
- Portal authentication is still pilot-grade. Production client users need proper per-user authentication and audit logging.
- Dashboard/alert calculations currently use the invoice records returned by the FactorCloud integration. True open A/R, NFE, reserve, funding, aging, and payment metrics should only be labeled as such after the corresponding FactorCloud fields/endpoints are mapped.

## Why amount/date rules are conservative

A rate confirmation and invoice can legitimately differ because of accessorials. Differences therefore produce REVIEW rather than FAIL. BOL/POD document dates are not compared to invoice dates because they represent different events.
