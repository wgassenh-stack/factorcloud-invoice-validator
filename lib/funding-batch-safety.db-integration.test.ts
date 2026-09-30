import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const FACTOR = 'batch-safety-factor';
const PORTAL_CLIENT = 'batch-safety-portal-client';
const FC_CLIENT = 'batch-safety-fc-client';

describe.skipIf(!enabled)('funding batch safety (real SQL)', () => {
  let query: typeof import('./db').query;
  let settings: import('./rules/settings').RuleSettings;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    ({ query } = await import('./db'));
    const { DEFAULT_SETTINGS, normalizeSettings } = await import('./rules/settings');
    settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      mode: 'fund',
      caps: { ...DEFAULT_SETTINGS.caps, perInvoice: 10_000, perClientPerDay: 50_000, perFactorPerDay: 100_000, businessHoursOnly: false, autoFundClients: 'all' },
    });

    await query(`insert into factors (id,factorcloud_factor_id,name) values ($1,$2,$3) on conflict (id) do nothing`, [FACTOR, 'batch-safety-fc-factor', 'Batch safety test']);
    await query(`insert into portal_clients (id,factor_id,factorcloud_client_id,name) values ($1,$2,$3,$4) on conflict (id) do nothing`, [PORTAL_CLIENT, FACTOR, FC_CLIENT, 'Batch safety client']);
    await query(`insert into rule_settings (factor_id,settings) values ($1,$2::jsonb) on conflict (factor_id) do update set settings=excluded.settings`, [FACTOR, JSON.stringify(settings)]);
  });

  afterAll(async () => {
    if (!query) return;
    await query('delete from funding_reservations where factor_id=$1', [FACTOR]);
    await query('delete from engine_runs where factor_id=$1', [FACTOR]);
    await query('delete from rule_settings where factor_id=$1', [FACTOR]);
    await query('delete from portal_clients where factor_id=$1', [FACTOR]);
    await query('delete from factors where id=$1', [FACTOR]);
  });

  it('does not auto-fund a FactorCloud batch that also contains a held invoice', async () => {
    await query('delete from funding_reservations where factor_id=$1', [FACTOR]);
    await query('delete from engine_runs where factor_id=$1', [FACTOR]);

    const base = [FACTOR, PORTAL_CLIENT, FC_CLIENT, 'shared-group-1'];
    await query(`insert into engine_runs
      (id,factor_id,client_id,factorcloud_invoice_id,factorcloud_client_id,invoice_number,amount,mode,outcome,state,rules,reasons,invoice_group_id,payment_type,approval_status)
      values
      ('held-run',$1,$2,'held-invoice',$3,'HELD-1',145,'fund','HOLD','APPROVED','[]'::jsonb,'["Over the auto-funding cap"]'::jsonb,$4,'ACH','COMPLETE'),
      ('safe-run',$1,$2,'safe-invoice',$3,'SAFE-1',90,'fund','FUND','APPROVED','[]'::jsonb,'[]'::jsonb,$4,'ACH','COMPLETE')`, base);

    const { claimFunding } = await import('./funding-safety');
    expect(await claimFunding('safe-run', true, settings)).toBe(false);

    const [safe] = await query<{ state: string; auto_funded: boolean; detail: string | null }>('select state,auto_funded,detail from engine_runs where id=$1', ['safe-run']);
    const [held] = await query<{ state: string; auto_funded: boolean }>('select state,auto_funded from engine_runs where id=$1', ['held-run']);
    expect(safe).toMatchObject({ state: 'APPROVED', auto_funded: false });
    expect(safe.detail).toMatch(/grouped this invoice with another invoice that requires a person/i);
    expect(held).toMatchObject({ state: 'APPROVED', auto_funded: false });
    expect(await query('select 1 from funding_reservations where run_id=$1', ['safe-run'])).toHaveLength(0);
  });
});
