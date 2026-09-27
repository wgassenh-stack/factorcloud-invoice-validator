import { describe, expect, it } from 'vitest';
import { driverStatus, sortForDriver } from './driver-status';

const rec = (over: Record<string, unknown> = {}) => ({ status: 'PENDING', verificationStatus: 'NOT_VERIFIED', paymentStatus: 'OPEN', fundedDate: null, paidDate: null, ...over });

describe('driver status', () => {
  it('puts a fix request or a rejection above everything else', () => {
    expect(driverStatus({ record: rec({ status: 'FUNDED', fundedDate: '2026-09-01' }), openFix: 'Upload the signed POD.' })).toMatchObject({ key: 'FIX', detail: 'Upload the signed POD.', needsYou: true });
    expect(driverStatus({ record: rec({ status: 'REJECTED' }), rejectionNote: 'Wrong rate con.' })).toMatchObject({ key: 'REJECTED', detail: 'Wrong rate con.', needsYou: true });
    expect(driverStatus({ record: rec(), review: 'REJECTED' }).key).toBe('REJECTED');
  });

  it('walks sent, being checked, approved, funded and paid', () => {
    expect(driverStatus({ record: rec() }).key).toBe('SENT');
    expect(driverStatus({ record: rec(), review: 'OPEN' }).key).toBe('CHECKING');
    expect(driverStatus({ record: rec(), review: 'OPEN', fixAnswered: true }).detail).toMatch(/You sent the fix/);
    expect(driverStatus({ record: rec({ status: 'APPROVED', verificationStatus: 'VERIFIED' }) }).key).toBe('APPROVED');
    expect(driverStatus({ record: rec({ status: 'FUNDED', fundedDate: '2026-09-02' }) }).key).toBe('FUNDED');
    expect(driverStatus({ record: rec({ status: 'PAID', paidDate: '2026-09-20' }) }).key).toBe('PAID');
    expect(driverStatus({ record: rec({ status: 'CANCELED' }) }).needsYou).toBe(false);
  });

  it('sorts what needs the driver first, then newest', () => {
    const row = (id: string, key: 'FIX' | 'SENT', date: string) => ({ id, invoiceDate: date, status: { key, label: '', detail: '', needsYou: key === 'FIX' } });
    expect(sortForDriver([row('old', 'SENT', '2026-09-01'), row('fix', 'FIX', '2026-08-01'), row('new', 'SENT', '2026-09-20')]).map((r) => r.id)).toEqual(['fix', 'new', 'old']);
  });
});
