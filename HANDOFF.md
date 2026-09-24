# FactorCloud Invoice Validator - Project Handoff

## Purpose

We are building an external invoice intake and validation app for FactorCloud.

Wallace Vaughan described the client need this way:

1. The app reads invoice paperwork and enters the invoice into FactorCloud for the user.
2. The app runs validation rules such as address match, phone match, and whether data is consistent across multiple uploaded documents.
3. The app should be external to FactorCloud and interact through the API so Wallace can change rules, logic, and UI quickly without waiting on FactorCloud product releases.

Wallace also mentioned a separate future app idea around risk alerts, concentration alerts, and volume spikes. That is not the current build.

## Intended product experience

FactorCloud remains the system of record. The new app acts as a smart intake layer in front of FactorCloud.

Proposed user flow:

1. User opens a separate branded web app, potentially later launched from a button or link inside FactorCloud.
2. User uploads an invoice PDF and optionally supporting documents such as BOL, POD, rate confirmation, or other paperwork.
3. App extracts structured fields from the documents.
4. App looks up known client/debtor data in FactorCloud.
5. App runs configurable validation rules against FactorCloud data and across all uploaded documents.
6. App shows PASS, REVIEW, or FAIL with exact reasons.
7. Human can review or override questionable items.
8. User clicks Create in FactorCloud.
9. App creates the invoice through the FactorCloud API, uploads the source PDF(s), and attaches them to the new invoice.
10. Normal FactorCloud workflow continues from there, including verification, approval, funding, payments, ledgers, and reserve release.

Longer term, this could remain a separate app, open from a FactorCloud button, or be hosted on FactorCloud infrastructure/domain. The code should stay portable and not be tied to the current developer's hosting account.

## FactorCloud environment and known sandbox identifiers

API base:

`https://api.int.factorcloud.com`

Factor ID:

`eff7fcec-b06a-4269-9f61-33b577f3b24f`

FactorCloud login username used during testing:

`wgassenh@gmail.com`

Password and bearer tokens were intentionally not copied into this handoff. They were visible during the original testing session and should be rotated before anything real is deployed.

Known sandbox client:

- Name: Will's Test Trucking LLC
- Company/client ID: `d9492b53-6545-48d6-87cf-c09ff1cdfc62`
- Address used in UI: 1234 testing lane, Dallas, TX 75205
- Phone used in UI: +13343770535
- Email used in UI: wgassenh@gmail.com
- Funding instructions used in test: Test ACH (ACH)

Known sandbox debtor:

- Name: Acme Manufacturing LLC
- Debtor/company ID: `a3429767-8107-4f1e-98f7-ecb910e930d4`
- Company code: ACME1
- Address: Fake address
- City: Dallas
- State: TX
- ZIP: 75205
- Country: US
- Phone: 3343770535
- Email: wgassenh@gmail.com
- EIN: 987654321
- Company type: Debtor
- noBuy: false

Known term:

- Term ID: `94f1337f-3dcd-4d97-ad41-eac3e544c7d9`
- Name: 15% Escrow 1% Fee
- Purchase fee: 1%
- Escrow reserve: 15%

## Authentication learned in Postman

The browser cannot simply GET the token endpoint. It must be called as POST.

The successful auth flow was:

1. POST `/authentications/generate-token`
   - JSON body with username and password
   - FactorCloud sends an OTP to email
   - Response includes an interim token

2. POST `/authentications/login`
   - JSON body includes username, password, and `otpCode`
   - Request includes FactorCloud factor ID and the interim authorization token in the format expected by the API
   - Successful response returns the final bearer token

3. All subsequent API requests use:
   - `factorId: eff7fcec-b06a-4269-9f61-33b577f3b24f`
   - `Authorization: Bearer <final token>`

Production auth is still an open design question. A server-side external app should not depend on a human entering an email OTP for every request. Need to ask FactorCloud whether there is a service account, API key, refresh token, long-lived integration token, or another intended machine-to-machine authentication flow. For a short prototype, a manually refreshed bearer token or a temporary OTP login flow can work.

## Proven read API calls

### List invoices

`GET /invoices`

This returned invoice records successfully when called with the factorId and bearer token.

### Get one invoice

`GET /invoices/{invoiceId}`

This returned the full invoice object, including:

- invoice number
- reference number
- client and debtor IDs/names
- term
- status
- verification status/method
- amount and balance
- dates
- fees
- reserves
- advance amount
- notes
- documents array
- payment transaction numbers
- applied payments
- labels

### Get a debtor/company master record

`GET /companies/{companyId}`

Successful example:

`GET /companies/a3429767-8107-4f1e-98f7-ecb910e930d4`

This returned the Acme Manufacturing LLC master record, including address, city, state, ZIP, phone, email, EIN, company type, and noBuy flag.

This proves the validator can compare document-extracted debtor information with FactorCloud's known master data.

### Get combined invoice documentation

A raw document download call to `/documents/{documentId}` returned 400 during testing, even though invoice metadata contained that URL.

The working route used by the FactorCloud web app was discovered in Chrome DevTools Network:

`GET /invoices/{invoiceId}/combined-documentation`

For Test002 this was:

`GET /invoices/60141dac-21dc-49c8-9087-59e203e69bb1/combined-documentation`

Response included:

- `downloadUrl`
- `expires`
- `lastGeneratedAt`

The `downloadUrl` was a temporary signed Amazon S3 URL. Direct GET to that signed S3 URL, with no FactorCloud headers, returned the actual PDF successfully in Postman.

The test URL had `X-Amz-Expires=604800`, meaning the signed link was valid for 7 days.

Important: `combined-documentation` was discovered by watching the FactorCloud web app. It may be an internal endpoint and should be confirmed with FactorCloud before depending on it in production.

## Proven write API calls

### Create an invoice externally

Successful request:

`POST /invoices`

Test body used:

```json
{
  "invoiceNumber": "Test003",
  "referenceNumber": "Load003",
  "companyClientId": "d9492b53-6545-48d6-87cf-c09ff1cdfc62",
  "companyDebtorId": "a3429767-8107-4f1e-98f7-ecb910e930d4",
  "invoiceAmount": 12500,
  "invoiceDate": "2026-09-24T00:00:00Z",
  "dueDate": null,
  "notes": "Created externally through API for validator prototype"
}
```

Response code was 201 SUCCESS.

FactorCloud automatically calculated:

- status: PENDING
- verificationStatus: NOT_VERIFIED
- invoice balance: 12500
- due date: 2026-10-24
- purchase fee: 125
- escrow reserve: 1875
- advance amount: 10500

This proves Wallace's Step 1 is feasible: an external app can take extracted document data and create the invoice without the user retyping it into FactorCloud.

### Upload a PDF externally

Working request:

`POST /documents`

Query parameters:

- `companyId=d9492b53-6545-48d6-87cf-c09ff1cdfc62`
- `type=INVOICE`
- `fileName=Test003_Sandbox_Invoice.pdf`

Body:

- multipart/form-data
- field name must be exactly lowercase `file`
- field type File
- value is the PDF

Important lesson: using `File` with a capital F caused 400 Bad Request. Changing the form-data key to lowercase `file` fixed it.

Do not manually set the multipart Content-Type header in Postman. Let Postman create the boundary automatically.

Successful uploaded document:

- Document ID: `6ee9c87d-8d83-4190-b70f-8744c43dc41d`
- Name: Test003_Sandbox_Invoice.pdf
- Type: INVOICE
- Content type: application/pdf
- Checksum: `1aa701bf5a94713398051805b5ffb39e`

### Attach uploaded document to invoice

Successful request:

`PUT /invoices/0a72f2aa-7161-4d05-8700-4160cb88166d`

Body:

```json
{
  "documents": [
    "6ee9c87d-8d83-4190-b70f-8744c43dc41d"
  ]
}
```

Response was 200 SUCCESS and the invoice returned `nDocuments: 1` plus the full document object.

There was a non-blocking warning:

- code: debtor-billing-email-not-found
- message: debtor does not have a billing email

The invoice still updated successfully.

This proves the full external intake write path:

PDF outside FactorCloud -> create invoice through API -> upload PDF -> attach PDF to invoice.

## Test invoice Test002 and what was learned from the normal FactorCloud lifecycle

Test002 was created manually in FactorCloud first and then taken through the normal lifecycle to understand the platform.

Key Test002 data:

- Invoice ID: `60141dac-21dc-49c8-9087-59e203e69bb1`
- Invoice number: Test002
- Reference: Load002
- Client: Will's Test Trucking LLC
- Debtor: Acme Manufacturing LLC
- Invoice amount: $10,000
- Invoice date: 09/23/2026
- Due date: 10/23/2026
- Term: 15% Escrow 1% Fee
- Escrow reserve: $1,500
- Purchase fee: $100
- Advance: $8,400
- Attached document count: 1
- Original document ID: `85d39f07-aae5-49d4-9a52-d28bb6b03865`
- Original document name: Test002_Sandbox_Invoice.pdf

Verification:

- verificationStatus became VERIFIED
- verificationMethod was EMAIL

The FactorCloud verification UI offered methods including EMAIL, MAIL, PHONE, ONLINE PORTAL, PortalDuct, Phone - Automated, LightHouz, and FactorGenie.

Funding:

- Invoice was approved for funding
- Payment batch: `DKWZLB-1001`
- ACH funding
- Advance paid: $8,400
- Funding CSV was successfully generated and downloaded
- Funded batch later appeared as ACH266 in the Funded screen

Payment/close:

A payment was created manually:

- Transaction ref: ACME-PAY-001
- Account: Bank Account
- Type: ACH
- Amount: $10,000
- FactorCloud noted ACH would post to GL Code 3004

The payment was applied in full to Test002. Invoice then became Closed/Paid with balance $0.

Ledger behavior observed:

AR ledger:

- FUNDED INVOICE: +$10,000, GL 3001
- PAID INVOICE: -$10,000, GL 3002

Escrow Reserve ledger:

- ESCROW RESERVE: +$1,500, GL 5002
- ESCROW RELEASE: -$1,500, GL 5001

AP Bank Account ledger:

- AP FUNDING: -$8,400, GL 3003

AR Bank Account ledger:

- AR PAYMENT: +$10,000, GL 3004

Fees/Cash Reserve behavior also showed collection/purchase fee activity, including GL 1001, 1014, and cash reserve GL 1008.

After payment, the client showed a current reserve balance of $1,400. A reserve release was created for $1,400, code DKW1000, approved for funding, then funded as payment batch DKWZLB-1002. This helped confirm the normal downstream lifecycle after invoice payoff.

The external validator does not need to replace any of those downstream FactorCloud workflows.

## Test invoice Test003 and current state

Test003 is the important proof that an external app can create an invoice and attach a PDF.

Invoice data:

- Invoice ID: `0a72f2aa-7161-4d05-8700-4160cb88166d`
- Invoice number: Test003
- Reference: Load003
- Client ID: `d9492b53-6545-48d6-87cf-c09ff1cdfc62`
- Debtor ID: `a3429767-8107-4f1e-98f7-ecb910e930d4`
- Invoice amount: $12,500
- Invoice date: 09/24/2026
- Due date: 10/24/2026
- Status: PENDING
- Verification: NOT_VERIFIED
- Purchase fee: $125
- Escrow reserve: $1,875
- Advance: $10,500
- nDocuments: 1
- Attached document ID: `6ee9c87d-8d83-4190-b70f-8744c43dc41d`
- Attached document name: Test003_Sandbox_Invoice.pdf

The Test003 PDF was generated specifically for the prototype and contains values matching the FactorCloud record.

## What Wallace means by validation

Based on his messages, validation is not just 'is the PDF readable.' The app should be able to check business data and consistency.

Core initial checks:

- Read invoice fields automatically
- Confirm debtor/company exists in FactorCloud
- Compare company/debtor name
- Compare address
- Compare phone number
- Potentially compare email/EIN
- If multiple docs are uploaded, confirm key values line up across all documents
- Compare invoice number/reference/load number across documents
- Compare amount across documents where applicable
- Compare dates across documents where applicable

Recommended result model:

- PASS: required rules passed with sufficient confidence
- REVIEW: mismatch, ambiguity, low OCR confidence, fuzzy match, or missing field that needs a human
- FAIL: deterministic blocking rule is violated

For real funding workflows, uncertain AI extraction should not silently pass. It should move to REVIEW.

## Configurable rules direction

Wallace specifically wants to be able to change rules quickly. This should become a configurable rules engine rather than hardcoding every client's logic.

Potential configuration examples:

- Require debtor address match: ON/OFF
- Require phone match: ON/OFF
- Require invoice/reference number across all docs: ON/OFF
- Require amount match across applicable docs: ON/OFF
- Allow fuzzy company-name match: ON/OFF
- Amount tolerance: $0, $1, percentage, etc.
- Require signed POD: ON/OFF
- Maximum invoice age: configurable
- Require PO/load number: ON/OFF
- Require specific supporting document types by client
- Blocking vs warning severity per rule
- Confidence threshold that forces REVIEW

For the first prototype, hardcoded rules are fine. A rule configuration screen can come later.

## Important unresolved technical questions

### Debtor lookup from extracted document data

We proved `GET /companies/{id}` when the company ID is already known.

We have NOT yet proved the best API route for taking an extracted name like 'Acme Manufacturing LLC' and finding the correct FactorCloud company/debtor ID.

For the first demo, Acme can be hardcoded.

Before making the app generic, test FactorCloud company list/search/filter endpoints and decide matching priority. Possible strong identifiers are EIN, exact normalized name, phone, address, or combinations.

### Production authentication

The current OTP login works manually but is not ideal for an unattended server app.

Need FactorCloud guidance on machine-to-machine auth.

### AI/document extraction model

No AI provider has been finalized yet.

The current repo uses a generic `AI_API_KEY` environment variable placeholder.

The extraction output should be structured JSON, not freeform prose.

Suggested initial schema:

```json
{
  "documentType": "invoice",
  "invoiceNumber": "",
  "referenceNumber": "",
  "clientName": "",
  "debtorName": "",
  "debtorAddress": "",
  "debtorCity": "",
  "debtorState": "",
  "debtorZip": "",
  "debtorPhone": "",
  "debtorEmail": "",
  "debtorEin": "",
  "invoiceAmount": null,
  "invoiceDate": "",
  "dueDate": "",
  "confidence": {}
}
```

### Multi-document classification

Need to identify whether each upload is an invoice, BOL, POD, rate confirmation, or other type. Extract common identifiers and compare them across documents.

### API stability

`/invoices/{id}/combined-documentation` works and is used by the web app, but it should be confirmed as supported for third-party integrations.

## Reliability issues to plan for

Real invoice intake will be harder than the clean sandbox PDFs.

Expect:

- scanned PDFs
- low resolution images
- crooked/rotated documents
- multi-page files
- handwritten fields
- unusual invoice layouts
- abbreviations in company names
- suite/unit/address formatting differences
- different phone formatting
- missing fields
- conflicting values across documents
- repeated/re-uploaded invoices
- duplicate invoices saved as different PDFs
- documents changed after validation
- invoice state changing during validation

The app should normalize values before comparing them. Examples:

- strip punctuation and spaces from phone numbers
- uppercase/normalize company names
- normalize street abbreviations
- parse money numerically
- parse dates into a canonical date format

AI should extract. Deterministic code should perform as many comparisons as possible after extraction.

## Recommended first prototype scope

Keep V1 deliberately narrow and impressive.

Flow:

1. Upload one invoice PDF
2. Extract:
   - invoice number
   - reference/load number
   - debtor name
   - debtor address
   - debtor phone
   - invoice amount
   - invoice date
   - due date
3. Look up debtor in FactorCloud
4. Show side-by-side values
5. Run rules:
   - debtor found
   - company name match
   - address match
   - phone match
6. Return PASS or REVIEW
7. Let user click Create in FactorCloud
8. Create invoice
9. Upload original PDF
10. Attach PDF to invoice
11. Show FactorCloud invoice ID/link/result

Then add a second supporting document and cross-document checks.

Also create a deliberately bad test PDF with a wrong phone/address/reference or amount so the demo visibly catches a mismatch.

## Current GitHub repo

GitHub account:

`wgassenh-stack`

Private repo:

`wgassenh-stack/factorcloud-invoice-validator`

Repo description:

External invoice intake and validation prototype for FactorCloud

Current technology:

- Next.js 15.5.4
- React 19.1.1
- TypeScript

Current files include:

- README.md
- .gitignore
- .env.example
- package.json
- tsconfig.json
- app/layout.tsx
- app/page.tsx
- app/globals.css

Current UI is a static prototype shell only. It has:

- FactorCloud Labs / Invoice Intake + Validation heading
- Step 1 Upload documents
- PDF upload control
- Analyze invoice button that currently has no backend behavior
- Step 2 Extracted invoice placeholder fields
- Step 3 Validation placeholder checks
- Step 4 Create in FactorCloud disabled action

The placeholder validation checks currently shown are:

- Debtor found in FactorCloud
- Company name match
- Address match
- Phone match
- Reference matches across documents
- Amount matches across documents

No live API routes, FactorCloud backend logic, AI extraction, or Vercel deployment have been completed yet.

Current `.env.example` contains:

```text
FACTORCLOUD_API_BASE=https://api.int.factorcloud.com
FACTORCLOUD_FACTOR_ID=
FACTORCLOUD_USERNAME=
FACTORCLOUD_PASSWORD=
AI_API_KEY=
```

Do not commit real credentials to GitHub. Use Vercel environment variables or local `.env.local`.

## Hosting plan

Short-term plan was GitHub + Vercel because it is fast for prototyping.

This does not lock the app to Vercel. The source code can later be moved to FactorCloud's GitHub organization or transferred. The app can later be deployed on FactorCloud's Vercel, AWS, Azure, or another Node-compatible host and served behind a FactorCloud subdomain such as `validator.factorcloud.com`.

Keep all environment-specific values in env vars so migration is easy.

## Immediate next steps

1. Connect the private GitHub repo to Vercel and get the current static shell deployed.
2. Add Vercel environment variables for API base, factor ID, username, password/auth strategy, and AI key.
3. Add server-only FactorCloud API helper code. Never call FactorCloud with secrets directly from the browser.
4. Decide temporary prototype auth strategy. Ideally ask FactorCloud for integration/service auth. If unavailable for the demo, manually provide a current bearer token or build a temporary OTP login screen.
5. Build an `/api/analyze` route that accepts PDF upload and returns structured extracted invoice fields.
6. Build FactorCloud company lookup/search. For the first demo, Acme can be hardcoded if necessary.
7. Build deterministic normalizers and comparison functions for name, address, phone, amount, and dates.
8. Wire the UI to show extracted value, FactorCloud value, pass/review result, and reason for each rule.
9. Build server routes/functions for the already-proven write flow:
   - POST /invoices
   - POST /documents with lowercase multipart field `file`
   - PUT /invoices/{id} with document IDs
10. Enable Create in FactorCloud only after analysis/review.
11. Add multi-document upload and cross-document consistency checks.
12. Make one clean demo packet and one intentionally bad packet.
13. Once the prototype works, ask Wallace which specific client rules should be configurable first.

## Suggested architecture

Browser:

- Next.js UI
- uploads PDFs to our own server route
- never receives FactorCloud credentials

Next.js server routes:

- AI document extraction
- FactorCloud authentication wrapper
- company/debtor lookup
- validation rules
- invoice creation
- document upload/attachment

FactorCloud:

- remains source of truth
- stores created invoice and documents
- continues normal approval/funding/accounting lifecycle

Optional later persistence:

- database for validation results, audit trails, overrides, and rule configuration

A database is not required for the first prototype.

## Separate future idea from Wallace

Wallace also mentioned a risk dashboard/alert system that could monitor:

- concentration exposure
- concentration limit alerts
- unusual invoice volume spikes
- rapid debtor/client exposure growth
- aging changes
- other risk patterns

That app would likely be easier from a document-processing perspective because it mostly reads FactorCloud data and calculates trends. Do not mix it into the current invoice validator prototype yet.

## Key conclusion

The core technical feasibility is already proven.

We successfully demonstrated:

- FactorCloud API authentication
- reading invoice data
- reading debtor/company master data
- finding/downloading invoice paperwork through the combined-documentation flow
- creating a new invoice through the API
- uploading a PDF through the API
- attaching the uploaded PDF to the invoice
- understanding the normal FactorCloud funding/payment/reserve lifecycle

The remaining work is product engineering rather than basic feasibility: document extraction, matching, rule logic, UI, auth hardening, and deployment.
