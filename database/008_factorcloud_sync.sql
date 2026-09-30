-- Invoices rejected or deleted in FactorCloud directly: the portal's check against FactorCloud
-- closes their funding decisions so they stop showing as waiting for someone.
alter table engine_runs drop constraint if exists engine_runs_state_check;
alter table engine_runs add constraint engine_runs_state_check
  check (state in ('SUGGESTED', 'REVIEW', 'APPROVED', 'FUNDING', 'FUNDED', 'FAILED', 'CLOSED'));
