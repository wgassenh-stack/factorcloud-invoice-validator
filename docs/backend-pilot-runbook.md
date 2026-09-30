# Backend pilot operations

This branch is a draft. No live FactorCloud writes, email delivery, scheduler, deployment, or production migration has been verified by these changes. The factor UI is owned by the separate redesign branch; this pass changes no UI files.

## Deployment order

1. Back up the database and test restoration. Apply all seven SQL files with `npm run db:migrate` using a migration account, first on a disposable staging database. The runner reapplies the idempotent files; retain the output. Migration 007 adds approval claims, invitation revocation, and an outbox index. No data is deleted.
2. Deploy the backend only after migrations succeed. Do not depend on runtime schema provisioning for migrations 006/007. Keep automatic funding off and notifications disabled for the initial smoke test.
3. Run `npm ci`, `npm test`, `npm run typecheck`, and `npm run build`. Run `npm run test:db` only with `TEST_DATABASE_URL` pointing to a disposable migrated database: these tests truncate its data. CI also runs the database suite on PostgreSQL 16.
4. Verify two separate client accounts and an invited driver cannot see each other's invoices/tasks or factor operations. Verify revoking an account invalidates its existing session. Confirm invitation replace/revoke and acceptance, then check audit records.
5. With explicit pilot authorization and a designated FactorCloud test invoice, verify approval, batch identity, funding, and timeout recovery. Verify ledger response shapes and totals against FactorCloud. Local mocks cannot certify those contracts.
6. Configure a verified email sender and a controlled recipient. Verify actual provider acceptance and delivery, then enable scheduling. Increase pilot scope only after operator sign-off on these checks.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Portal PostgreSQL connection; never point integration tests at this production database. |
| `PORTAL_AUTH_MODE=database` | Required for driver accounts, recovery, and notification administration. |
| `AUTH_SESSION_SECRET` | Strong persistent session signing secret. |
| `PORTAL_PUBLIC_URL` | Canonical HTTPS URL used in invitation links and the scheduler script. |
| `FACTORCLOUD_FACTOR_ID` | FactorCloud tenant served by this deployment. |
| `FACTORCLOUD_BEARER_TOKEN` | Server-side FactorCloud credential when using service-token authentication. |
| `FACTOR_TIMEZONE` | IANA timezone for business hours and daily funding limits; defaults to `America/Chicago`. |
| `NOTIFICATIONS_ENABLED` | Only literal `true` enables sending. Leave disabled until sender testing is complete. |
| `RESEND_API_KEY` | Server-side email provider credential. |
| `NOTIFICATION_FROM` | Sender address on a verified provider domain. |
| `NOTIFICATION_WORKER_SECRET` | Strong random secret shared only with the scheduler; rotate in both places. |

Existing extraction, receipt-signing, FactorCloud authentication and deployment configuration still applies; this table covers the backend pilot features rather than replacing the project's full configuration.

## Worker scheduling and delivery recovery

Configure your scheduler to run `node scripts/notification-worker.mjs` once per minute with the canonical URL and worker secret in its secret environment. It POSTs to `/api/internal/notifications` with bearer authentication. No scheduler is installed automatically. Avoid overlapping schedules; row claims also prevent concurrent workers from sending the same pending row.

Each invocation claims at most three messages, one at a time, with a 10-second provider deadline per send. It rechecks active user/client access, driver ownership, task status, and invitation expiry/revocation. A reminder is queued only 24 hours after the initial message was accepted by the provider. `SENT` means provider acceptance, not inbox delivery; bounce/webhook integration remains outside this implementation.

HTTP 429 is retried after five minutes, up to five attempts, using the same idempotency key. Other failures, timeouts, and interrupted sends are held as `FAILED`; inspect provider records before retrying. Stale `SENDING` rows become failed after ten minutes. Never directly reset uncertain rows in SQL.

Admin API: `PATCH /api/ops/notifications` with `{id, outcome: "sent" | "not-sent", evidence}`. Evidence must be 15–2000 characters. `not-sent` schedules another attempt; `sent` records provider acceptance. The update and audit event commit together, and eligibility is checked again before any resend. The existing GET/POST responses are unchanged.

## Approval and funding recovery

Approval claims are persisted before refreshing facts. Only the owner can cross into the remote-write stage; claims carry a token so a stale request cannot start another approval after reconciliation. Unknown responses block automatic and manual approval retries. FactorCloud requests have a 30-second deadline; writes are never retried automatically.

The existing public funding states are unchanged. Internal approval statuses are `IDLE`, `CHECKING`, `SENDING`, `UNKNOWN`, and `COMPLETE`. The recovery queue includes stale approval claims after five minutes, plus explicit uncertain outcomes. Before reconciling a stale operation, confirm its request/worker has stopped and inspect the current FactorCloud invoice and funding batch. An operator's evidence is an attestation; the portal cannot independently prove the absence of a remote approval or payment.

`POST /api/ops/recovery` retains `{id, outcome, evidence}` and adds these outcomes:

| Kind | Outcome / extra fields | Effect |
| --- | --- | --- |
| `APPROVAL_UNKNOWN` | `approved`, `invoiceGroupId`, `paymentType` | Record the verified batch and hold in APPROVED; does not fund. |
| `APPROVAL_UNKNOWN` | `not-approved` | Allow a fresh rule check and approval attempt. |
| `CREATE_UNKNOWN` | `created`, `invoiceId` | Fetch and verify invoice number/client ownership, preserve the retry block, and open document repair. |
| `CREATE_UNKNOWN` | `not-created` | Release the submission retry key only if no invoice ID is already known. |
| `FUNDING_UNKNOWN` | Existing `funded` / `not-funded` | Confirm or release the funding reservation based on operator evidence. |
| Document failure | Existing `repaired` | Close after manual document verification/repair in FactorCloud. |

Creation uncertainty can no longer be closed with generic `repaired`: that would leave its idempotency key unresolved. The redesigned UI can add these controls using the additive API fields; until then an authenticated admin can call the API. No original document files are retained server-side, and this flow does not silently rerun uploads or funding.

## Driver lifecycle

`POST /api/ops/team` with the same email issues a replacement invitation and invalidates older unused tokens. Invite creation, outbox insertion, and audit write are atomic. Acceptance is serialized by factor/email, single use, client-scoped, and throttled by hashed token and proxy-provided IP. Deploy behind a proxy that overwrites forwarding headers.

`GET /api/ops/team` includes an additive `invitations` list for admins, exposing token hashes as IDs, never raw tokens. `PATCH /api/ops/team` accepts `{invitationId}` to revoke an unused invite. Existing `{id, active}` account updates still work and now produce audit events. Invitation links are credentials: do not log or copy them into tickets.

## Rollback and pilot checks

Disable automatic funding and notifications before rollback. Drain/stop old request workers before reconciling in-flight actions. Keep migrations 006/007 and their data; do not roll back to backend code that ignores approval claims while uncertain operations exist. Inspect open recovery, stale claims, failed outbox rows, duplicate invoice numbers, daily reservation totals, and operator audit events each pilot day.

Production release remains gated on real FactorCloud contract testing, delivered email verification, browser onboarding checks, migration/backup rehearsal, and integrating the new recovery controls into the separately owned UI. Local tests do not authorize a production deployment or financial transaction.
