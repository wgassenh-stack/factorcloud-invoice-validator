import { describe, expect, it } from 'vitest';
import { actOnDemoRun, demoFundingData, demoFundingSettings, runDemoFundingEngine } from './demo-funding';
import { addDemoInvoice } from './demo-store';

describe('demo funding engine', () => {
  it('has a real example in every lane', () => {
    const { runs, summary } = demoFundingData(null);
    const states = new Set(runs.map((r) => r.state));
    for (const state of ['FUNDED', 'APPROVED', 'REVIEW', 'SUGGESTED', 'FAILED']) expect(states, state).toContain(state);
    const reasons = runs.filter((r) => r.state === 'APPROVED').flatMap((r) => r.reasons).join(' | ');
    expect(reasons).toMatch(/auto-funding cap/);
    expect(reasons).toMatch(/Cash reserve is negative/);
    expect(reasons).toMatch(/Over the credit limit/);
    expect(summary?.today?.autoFunded).toBeGreaterThanOrEqual(5);
    expect(runs.every((r) => r.debtorName)).toBe(true);
  });

  it('uses per-client rules: a bigger cap for one client, suggest only for another', () => {
    const { clientOverrides } = demoFundingSettings();
    expect(Object.values(clientOverrides).map((o) => o.mode).sort()).toEqual(['fund', 'suggest']);
    const runs = demoFundingData(null).runs;
    expect(runs.some((r) => r.factorCloudClientId === 'demo-client-02' && r.amount > 5_000 && r.state === 'FUNDED')).toBe(true);
    expect(runs.find((r) => r.factorCloudClientId === 'demo-client-20')?.state).toBe('SUGGESTED');
  });

  it('a new submission is decided by the rules, and a held invoice can be funded with a click', () => {
    const small = addDemoInvoice({ invoiceNumber: 'DEMO-T-1', referenceNumber: null, companyClientId: 'demo-client-03', companyDebtorId: 'demo-debtor-05', invoiceAmount: 1200, invoiceDate: new Date().toISOString().slice(0, 10), notes: null });
    const run = runDemoFundingEngine(small, 'PASS')!;
    expect(['FUNDED', 'APPROVED']).toContain(run.state);
    const held = demoFundingData('decision').runs[0];
    expect(actOnDemoRun(held.id, 'fund', 'Demo Admin')).toMatchObject({ ok: true });
    expect(actOnDemoRun(held.id, 'fund', 'Demo Admin')).toMatchObject({ ok: false });
    const failed = demoFundingData('exceptions').runs[0];
    expect(actOnDemoRun(failed.id, 'approve', 'Demo Admin').ok).toBe(true);
  });
});
