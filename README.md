# factorcloud-invoice-validator

An external intake app for FactorCloud. It reads invoice paperwork, validates it against FactorCloud and across documents, then creates the invoice through the FactorCloud API. See `HANDOFF.md` for the background and the API calls that were proven by hand.

## What works

1. **Upload** an invoice plus supporting documents (BOL, POD, rate confirmation). PDF and image files are accepted.
2. **Extract.** Claude reads each document into structured fields and classifies its type (`lib/extract.ts`). Fields it can't read confidently are flagged.
3. **Look up FactorCloud.** The app matches the debtor by EIN, normalized name, or phone plus a similar name (`lib/matching.ts`), and loads the client record.
4. **Validate.** Deterministic rules return PASS / REVIEW / FAIL with the document value and the FactorCloud value side by side (`lib/rules.ts`). The reviewer can correct fields, and validation re-runs as they type.
5. **Create in FactorCloud.** The app runs the sequence proven with Test003: `POST /invoices`, then `POST /documents` for each file, then `PUT /invoices/{id}` to attach them (`app/api/create/route.ts`). A FAIL blocks creation. A REVIEW needs an explicit "I reviewed this" tick.

The AI only extracts. Every comparison and every PASS/REVIEW/FAIL decision is plain code.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in the blanks
npm run dev                  # http://localhost:3000
```

Environment variables are documented in `.env.example`. You need at least:

- `APP_ACCESS_PASSWORD`: a shared password for the whole app (browser login prompt, any username). **Production refuses to serve without it.** Anyone with the URL could otherwise create invoices with your FactorCloud token.
- `ANTHROPIC_API_KEY`: for reading documents.
- `FACTORCLOUD_FACTOR_ID`, `FACTORCLOUD_CLIENT_ID`, `FACTORCLOUD_DEBTOR_IDS`.
- FactorCloud credentials. There are two options:
  - `FACTORCLOUD_USERNAME` + `FACTORCLOUD_PASSWORD`: click **Sign in to FactorCloud** in the app and enter the emailed code. The token lives in an httpOnly cookie for 8 hours.
  - `FACTORCLOUD_BEARER_TOKEN`: paste a token from Postman. It's used when nobody has signed in.

### Deploying to Vercel

1. In Vercel, import `wgassenh-stack/factorcloud-invoice-validator`. The framework preset is Next.js, and no build settings are needed.
2. Add the environment variables above under Settings → Environment Variables, then redeploy.
3. Uploads are limited to about 4 MB per request (Vercel's body limit), and the UI warns before that. Analysis can take up to a minute for large packets. The route allows 300 s, which needs Fluid Compute (on by default for new projects).

## Changing the rules

All switches are in `RULES` at the top of `lib/rules.ts`: address/phone/name matching, fuzzy name threshold, amount tolerance, maximum invoice age, signed-POD requirement and so on. A disabled rule shows as SKIP. Normalization for phones, money, dates, company names (with abbreviations like Mfg → Manufacturing) and USPS street abbreviations is in `lib/normalize.ts`.

## Demo packets

`npm run demo:pdfs` regenerates the two packets in `demo/`:

- `demo/clean/`: Test004 invoice, BOL and rate confirmation. They match the Acme sandbox record and each other, so the result is **PASS**.
- `demo/review/`: Test005 invoice, POD and rate confirmation. Street and phone differ from FactorCloud, and the rate con says $10,000 against the invoice's $12,000, so the result is **REVIEW**.

Bump the invoice numbers before each live demo in case FactorCloud rejects duplicates. You can also edit the invoice # in the UI before creating.

## Tests

```bash
npm test          # normalizers, rules engine, debtor matching, response parsing
npm run typecheck
```

## Known gaps / open questions for FactorCloud

- **Machine-to-machine auth.** Email OTP works for a demo but not unattended use. Ask for a service account, API key or refresh token.
- **Login request shape.** The OTP login sends the interim token as `Authorization: Bearer <interim>` with the `factorId` header. The handoff doesn't record the exact format, so confirm it on the first live sign-in. The token field in responses is found by scanning common names (`token`, `accessToken`, …) in `lib/fc-response.ts`.
- **Response envelopes.** Invoice and document IDs are read from `id`, `data.id`, `invoice.id` and similar. Check the first live create.
- **Debtor search.** There's no proven company search endpoint yet, so debtors are matched against `FACTORCLOUD_DEBTOR_IDS`. Replace `findDebtor` in `lib/factorcloud.ts` once search is confirmed.
- **Document types.** Only `INVOICE` is proven. The app tries `BOL`, `POD`, `RATE_CONFIRMATION` and `OTHER` first, and on a 400 falls back to `INVOICE`. The create log shows which type was used.
- **Duplicate-invoice check** isn't implemented yet. It needs an invoice search or filter endpoint.
