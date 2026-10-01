'use client';

import { useEffect, useState } from 'react';
import { DemoBadge } from '@/app/components/DemoBadge';
import { Skeleton } from '@/app/components/CommandCharts';
import type { ConnectionReport } from '@/lib/connection-check';
import { FactorCloudConnection } from '@/app/components/FactorCloudConnection';

type Response = ConnectionReport & { demo?: boolean; error?: string };

const ICON = { ok: '✓', warn: '!', fail: '✕', skip: '–' } as const;
const WORD = { ok: 'OK', warn: 'Check', fail: 'Failed', skip: 'Skipped' } as const;

export default function ConnectionCheckPage() {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  async function run() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/connection-check', { cache: 'no-store' });
      const body = await res.json() as Response;
      if (!res.ok) throw new Error(body.error || 'The check could not run.');
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void run(); }, []);

  function copyReport() {
    if (!data) return;
    const lines = [
      `FactorCloud connection check · ${new Date(data.generatedAt).toLocaleString()}${data.demo ? ' · DEMO DATA' : ''}`,
      `Scope: ${data.scope === 'factor' ? 'whole factor' : 'this client'} · ${data.invoiceCount} invoices`,
      '',
      ...data.items.map((i) => `[${WORD[i.state]}] ${i.label}: ${i.detail}${i.ms != null ? ` (${i.ms} ms)` : ''}`),
      '',
      'Field coverage:',
      ...data.coverage.map((c) => `  ${c.label}: ${c.present}/${c.total} (${Math.round(c.share * 100)}%)`),
      '',
      ...data.values.map((v) => `${v.label}: ${v.values.map((x) => `${x.value} ×${x.count}`).join(', ') || '(none)'}`),
    ];
    void navigator.clipboard.writeText(lines.join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  const counts = data ? { fail: data.items.filter((i) => i.state === 'fail').length, warn: data.items.filter((i) => i.state === 'warn').length } : null;

  return <main className="connectionPage">
    <a className="portalBackLink" href="/">← Back to the portal</a>
    <header className="connectionHeader">
      <div>
        <div className="dashboardHeroMeta"><span className="eyebrow">FactorCloud</span><DemoBadge /></div>
        <h1>Connection check</h1>
        <p>Run this before a demo. A read-only check of everything the portal relies on: FactorCloud, document reading, sign-in and the review label, plus how much of your invoice data comes back filled in. Nothing is created or changed.</p>
      </div>
      <div className="connectionActions">
        <button className="secondaryLink" onClick={copyReport} disabled={!data}>{copied ? 'Copied' : 'Copy report'}</button>
        <button className="primaryLink" onClick={() => void run()} disabled={loading}>{loading ? 'Checking…' : 'Run again'}</button>
      </div>
    </header>

    <FactorCloudConnection onConnected={() => void run()} />

    {error && <div className="attentionSummary fail"><strong>The check could not run</strong><span>{error}</span></div>}
    {loading && !data && <Skeleton height={220} lines={4} />}

    {data && counts && <>
      <div className={`connectionVerdict ${counts.fail ? 'fail' : counts.warn ? 'warn' : 'ok'}`}>
        <b aria-hidden="true">{counts.fail ? '✕' : counts.warn ? '!' : '✓'}</b>
        <div>
          <strong>{counts.fail ? `${counts.fail} problem${counts.fail === 1 ? '' : 's'} to fix` : counts.warn ? `Working, with ${counts.warn} thing${counts.warn === 1 ? '' : 's'} to look at` : 'Everything checks out. Ready to demo.'}</strong>
          <span>{data.scope === 'factor' ? 'Whole factor' : 'This client'} · {data.invoiceCount} invoices · {new Date(data.generatedAt).toLocaleTimeString()}</span>
        </div>
      </div>

      <section className="connectionList">
        {data.items.map((item) => <div key={item.id} className={`connectionItem ${item.state}`}>
          <span className="connectionIcon" aria-hidden="true">{ICON[item.state]}</span>
          <div><strong>{item.label}</strong><span>{item.detail}</span></div>
          <em>{WORD[item.state]}{item.ms != null ? ` · ${item.ms} ms` : ''}</em>
        </div>)}
      </section>

      {data.invoiceCount > 0 && <section className="dashCard connectionCoverage">
        <div className="dashCardHeader"><div><span>Invoice data</span><h2>Which fields come back filled in</h2><p>Funding fields are measured on funded invoices, paid date on paid ones.</p></div></div>
        <div className="dashCardBody">
          {data.coverage.map((c) => <div className="coverageRow" key={c.field}>
            <div><strong>{c.label}</strong><small>{c.usedBy}</small></div>
            <div className="coverageBar"><span className={c.total === 0 ? '' : c.share >= 0.9 ? 'good' : c.share >= 0.5 ? 'mid' : 'low'} style={{ width: `${Math.round(c.share * 100)}%` }} /></div>
            <em>{c.total ? `${Math.round(c.share * 100)}%` : 'n/a'}<small>{c.present}/{c.total}</small></em>
          </div>)}
          <div className="coverageValues">
            {data.values.map((v) => <div key={v.field}><strong>{v.label}</strong><span>{v.values.slice(0, 8).map((x) => <code key={x.value}>{x.value} ×{x.count}</code>)}</span></div>)}
          </div>
        </div>
      </section>}
    </>}
  </main>;
}
