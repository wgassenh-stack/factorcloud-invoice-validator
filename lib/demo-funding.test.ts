import { describe, expect, it, vi } from 'vitest';
import { actOnDemoRun, demoFundingData, demoFundingSettings, runDemoFundingEngine } from './demo-funding';
import { addDemoInvoice } from './demo-store';

describe('demo funding engine', () => {
  it('has a real example in every lane', () => {
    const { runs, summary } = demoFundingData(null);
    const states = new Set(runs.map((r) => r.state));
    for (const state of ['FUNDED', 'REVIEW', 'SUGGESTED', 'FAILED']) expect(states, state).toContain(state);
    // Held invoices wait for one click and are not approved in FactorCloud yet.
    const held = demoFundingData('decision').runs;
    expect(held.length).toBeGreaterThanOrEqual(4);
    expect(held.every((r) => r.state === 'SUGGESTED' && r.mode === 'fund')).toBe(true);
    const reasons = held.flatMap((r) => r.reasons).join(' | ');
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
    expect(['FUNDED', 'SUGGESTED']).toContain(run.state);
    const held = demoFundingData('decision').runs[0];
    expect(actOnDemoRun(held.id, 'fund', 'Demo Admin')).toMatchObject({ ok: true });
    expect(actOnDemoRun(held.id, 'fund', 'Demo Admin')).toMatchObject({ ok: false });
    const failed = demoFundingData('exceptions').runs[0];
    expect(actOnDemoRun(failed.id, 'approve', 'Demo Admin').ok).toBe(true);
  });

  it('has every example whatever the date and time of day, weekends included', async () => {
    const missing: string[] = [];
    for (let day = 0; day < 14; day++) for (const hour of [2, 14, 22]) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 1 + day, hour, 37)));
      vi.resetModules();
      const g = globalThis as Record<string, unknown>;
      delete g.__fcDemoState; delete g.__fcDemoFunding;
      const fresh = await import('./demo-funding');
      const { runs, summary } = fresh.demoFundingData(null);
      const held = fresh.demoFundingData('decision').runs;
      const states = new Set(runs.map((r) => r.state));
      const reasons = held.flatMap((r) => r.reasons).join(' | ');
      const gaps = [
        ...['FUNDED', 'REVIEW', 'SUGGESTED', 'FAILED'].filter((x) => !states.has(x as never)),
        held.length < 4 && 'four held', !/auto-funding cap/.test(reasons) && 'cap hold', !/Cash reserve is negative/.test(reasons) && 'reserve hold',
        !/Over the credit limit/.test(reasons) && 'credit hold', (summary?.today?.autoFunded ?? 0) < 5 && 'five auto-funded',
        runs.find((r) => r.factorCloudClientId === 'demo-client-20')?.state !== 'SUGGESTED' && 'suggest-only',
      ].filter(Boolean);
      if (gaps.length) missing.push(`Oct ${1 + day} ${hour}:37 UTC: ${gaps.join(', ')}`);
      vi.useRealTimers();
    }
    expect(missing).toEqual([]);
  }, 120_000);
});
