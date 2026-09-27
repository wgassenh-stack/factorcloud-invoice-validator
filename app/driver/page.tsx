'use client';

import { useEffect, useState } from 'react';
import { PortalNav } from '@/app/components/PortalNav';
import { DemoBadge } from '@/app/components/DemoBadge';
import { FixRequestPanel } from '@/app/components/FixRequests';
import { money } from '@/app/components/DashboardCharts';
import { setDemoViewInBrowser } from '@/lib/demo';
import type { DriverStatus, DriverStatusKey } from '@/lib/driver-status';

type Row = {
  id: string;
  invoiceNumber: string;
  referenceNumber: string;
  debtorName: string;
  invoiceAmount: number;
  invoiceDate: string;
  sentAt: string;
  status: DriverStatus;
  taskId: string | null;
};

// How far along each status is, on the four steps a driver cares about.
const STEPS = ['Sent', 'Checked', 'Funded', 'Paid'] as const;
const REACHED: Record<DriverStatusKey, number> = { SENT: 0, CHECKING: 0, FIX: 0, REJECTED: 0, CANCELED: 0, APPROVED: 1, FUNDED: 2, PAID: 3 };

export default function DriverHome() {
  const [data, setData] = useState<{ driver: string; invoices: Row[] } | null>(null);
  const [error, setError] = useState('');

  async function load() {
    try {
      const res = await fetch('/api/driver/invoices', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not load your invoices.');
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    setDemoViewInBrowser('driver');
    void load();
  }, []);

  const rows = data?.invoices ?? [];
  const needsYou = rows.filter((row) => row.status.needsYou);
  const rest = rows.filter((row) => !row.status.needsYou);
  const count = (keys: DriverStatusKey[]) => rows.filter((row) => keys.includes(row.status.key)).length;
  const firstName = data?.driver.split(' ')[0] ?? '';

  return (
    <main className="portalShell driverPage">
      <PortalNav active="driver" />

      <section className="driverHero">
        <div>
          <div className="driverHeroMeta"><span className="eyebrow">Driver view</span><DemoBadge /></div>
          <h1>{data ? `Hi ${firstName}` : 'Loading your invoices...'}</h1>
          <p>Send in paperwork from your phone and see where every load you've sent stands.</p>
        </div>
        <a className="driverSendButton" href="/submit"><span aria-hidden="true">📷</span>Send in paperwork</a>
      </section>

      {error && <div className="attentionSummary fail"><strong>Could not load your invoices</strong><span>{error}</span></div>}

      {data && <>
        <section className="driverCounts">
          <div className={needsYou.length ? 'bad' : 'good'}><strong>{needsYou.length}</strong><span>Need you</span></div>
          <div><strong>{count(['SENT', 'CHECKING'])}</strong><span>Waiting on the factor</span></div>
          <div className="good"><strong>{count(['APPROVED', 'FUNDED', 'PAID'])}</strong><span>Approved or paid</span></div>
        </section>

        {needsYou.length > 0 && <section className="driverSection">
          <h2>Needs you</h2>
          {needsYou.map((row) => <article className={`driverCard ${row.status.key.toLowerCase()}`} key={row.id}>
            <DriverRowHead row={row} />
            {row.status.key === 'FIX'
              ? <FixRequestPanel invoiceId={row.id} onDone={() => void load()} />
              : <div className="driverRejected">
                  <p><b>Why:</b> {row.status.detail}</p>
                  <a className="driverResend" href="/submit">Send it again</a>
                </div>}
          </article>)}
        </section>}

        <section className="driverSection">
          <h2>My invoices</h2>
          <p className="driverHint">The last 60 days of paperwork you sent in.</p>
          <div className="driverList">
            {rest.map((row) => <article className="driverCard" key={row.id}>
              <DriverRowHead row={row} />
              <p className="driverDetail">{row.status.detail}</p>
            </article>)}
            {!rest.length && <div className="portalEmpty"><strong>Nothing sent in yet</strong><span>Tap “Send in paperwork” after your next delivery.</span></div>}
          </div>
        </section>
      </>}
    </main>
  );
}

function DriverRowHead({ row }: { row: Row }) {
  const reached = REACHED[row.status.key];
  const blocked = row.status.needsYou || row.status.key === 'CANCELED';
  return <div className="driverRowHead">
    <div className="driverRowId">
      <strong>Load {row.referenceNumber || '-'}</strong>
      <span>Invoice {row.invoiceNumber} · {row.debtorName} · {row.invoiceDate}</span>
    </div>
    <div className="driverRowStatus">
      <span className={`driverPill ${row.status.key.toLowerCase()}`}>{row.status.label}</span>
      {!blocked && <span className="driverSteps" aria-label={`Step ${reached + 1} of 4: ${STEPS[reached]}`}>{STEPS.map((step, i) => <i key={step} className={i <= reached ? 'on' : ''} title={step} />)}</span>}
    </div>
    <strong className="driverAmount">{money(row.invoiceAmount)}</strong>
  </div>;
}
