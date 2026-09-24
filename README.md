# FactorCloud Invoice Validator

External freight invoice intake and validation prototype for FactorCloud.

## Pilot flow

1. Upload an invoice and supporting PDF/image documents.
2. Gemini extracts structured fields only. It does not decide whether the packet passes.
3. FactorCloud debtor/client records are loaded server-side.
4. Deterministic TypeScript rules return PASS, REVIEW, or FAIL.
5. A REVIEW requires a human override reason. A FAIL cannot be created.
6. Before creation the server re-runs validation and checks FactorCloud for a duplicate invoice number.
7. The app creates the invoice, uploads the files, and attaches them using the API sequence already proven in the sandbox.

## Extraction model

The default is `gemini-3.1-flash-lite` with `minimal` thinking. It is intentionally the cheapest reasonable starting point. The extractor is isolated in `lib/extract.ts`, so the model can be changed with `EXTRACTION_MODEL` if real paperwork shows quality problems.

The AI is only responsible for reading/classifying documents. Matching, comparisons, duplicate protection, and create gating are deterministic code.

Current standard API pricing for Gemini 3.1 Flash-Lite is $0.25 per 1M text/image/video input tokens and $1.50 per 1M output tokens, including thinking tokens. Using the earlier rough packet assumption of 20k input and 4.5k output would be about $0.012 per packet. Actual usage must be measured with real freight paperwork.

For real client documents, use a paid Gemini API project rather than relying on the free tier. Google's pricing documentation currently indicates paid-tier submitted data is not used to improve Google's products, while the free tier is marked differently.

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

For any deployed pilot, also set `APP_ACCESS_PASSWORD`.

## Important pilot limitations

- Debtor search is not yet proven, so candidate debtor IDs are configured in `FACTORCLOUD_DEBTOR_IDS`.
- Only the FactorCloud `INVOICE` document type has been proven. Other classified types fall back to `INVOICE` if FactorCloud rejects them with a 400.
- Duplicate checking currently scans the invoice list returned by `GET /invoices`. Before production, confirm pagination/filter semantics or add durable idempotency storage.
- The FactorCloud email OTP flow should be replaced with machine-to-machine integration credentials if FactorCloud provides them.
- There is no per-user audit log yet. REVIEW override reasons are appended to invoice notes as a temporary pilot trail.
- Shared HTTP Basic authentication is suitable only for a small trusted pilot, not for a multi-client production rollout.

## Why amount/date rules are conservative

A rate confirmation and invoice can legitimately differ because of accessorials. Differences therefore produce REVIEW rather than FAIL. BOL/POD document dates are not compared to invoice dates because they represent different events.
