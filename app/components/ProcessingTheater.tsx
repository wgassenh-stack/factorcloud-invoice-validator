'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalyzeResponse, CheckResult, CreateResponse, ValidationReport } from '@/lib/types';

export type TheaterPhase = 'idle' | 'analyzing' | 'analyzed' | 'submitting' | 'submitted';

const READ_STEPS = ['Reading documents', 'Extracting invoice fields', 'Matching the debtor in FactorCloud', 'Cross-checking the packet'];
const SUBMIT_STEPS = ['Creating the invoice in FactorCloud', 'Uploading documents', 'Attaching paperwork'];

/**
 * The visible story of a submission: documents being read, fields appearing, checks ticking off,
 * then the invoice landing in FactorCloud. Purely presentational; the page drives the phase.
 */
export function ProcessingTheater({ files, phase, analysis, validation, createResult }: {
  files: File[];
  phase: TheaterPhase;
  analysis: AnalyzeResponse | null;
  validation: ValidationReport | null;
  createResult: CreateResponse | null;
}) {
  const previews = useFilePreviews(files);
  const [tick, setTick] = useState(0);
  const ref = useRef<HTMLElement>(null);

  // Keep the story on screen as it moves along (the submit button sits far below).
  useEffect(() => {
    if (phase === 'idle') return;
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [phase]);

  useEffect(() => {
    setTick(0);
    if (phase !== 'analyzing' && phase !== 'submitting') return;
    const timer = setInterval(() => setTick((t) => t + 1), 650);
    return () => clearInterval(timer);
  }, [phase]);

  if (phase === 'idle' || !files.length) return null;
  const primary = analysis?.documents[analysis.primaryIndex]?.fields;
  const checks = validation?.checks.filter((c) => c.status !== 'SKIP') ?? [];
  const counts = { pass: checks.filter((c) => c.status === 'PASS').length, review: checks.filter((c) => c.status === 'REVIEW').length, fail: checks.filter((c) => c.status === 'FAIL').length };

  return <section ref={ref} className={`theater ${phase}`} aria-live="polite">
    <div className="theaterDocs">
      {files.slice(0, 4).map((file, i) => {
        const doc = analysis?.documents.find((d) => d.sourceIndex === i) ?? analysis?.documents[i];
        return <div className="theaterDoc" key={`${file.name}-${i}`} style={{ animationDelay: `${i * 120}ms` }}>
          <div className="theaterPage">
            {previews[i] ? <img src={previews[i]!} alt="" /> : <PagePlaceholder />}
            {phase === 'analyzing' && <span className="theaterBeam" style={{ animationDelay: `${i * 300}ms` }} />}
            {doc && <span className="theaterDocType">{doc.fields.documentType.replace('_', ' ')}</span>}
          </div>
          <small title={file.name}>{file.name}</small>
        </div>;
      })}
      {files.length > 4 && <div className="theaterMore">+{files.length - 4}</div>}
    </div>

    <div className="theaterStage">
      {phase === 'analyzing' && <Steps steps={READ_STEPS} active={Math.min(READ_STEPS.length - 1, Math.floor(tick / 2))} title="Verifying your packet" />}

      {(phase === 'analyzed' || phase === 'submitting' || phase === 'submitted') && primary && <>
        <div className="theaterFields">
          {[
            ['Invoice #', primary.invoiceNumber],
            ['Load / reference', primary.referenceNumber],
            ['Debtor', analysis?.debtor?.companyName ?? primary.debtorName],
            ['Amount', primary.invoiceAmount == null ? null : money(primary.invoiceAmount)],
            ['Invoice date', primary.invoiceDate],
          ].map(([label, value], i) => <div className="theaterField" key={label} style={{ animationDelay: `${i * 140}ms` }}>
            <span>{label}</span><strong>{value || '—'}</strong>
          </div>)}
        </div>
        {phase === 'analyzed' && <div className="theaterChecks">
          <div className="theaterScore">
            <ScoreRing pass={counts.pass} total={checks.length} status={validation?.status ?? 'PASS'} />
            <div>
              <strong>{validation?.status === 'PASS' ? 'Ready to submit' : validation?.status === 'REVIEW' ? 'Ready, with items for your factor to review' : 'Needs fixes before submitting'}</strong>
              <span>{counts.pass} passed{counts.review ? ` · ${counts.review} to review` : ''}{counts.fail ? ` · ${counts.fail} failed` : ''}</span>
            </div>
          </div>
          <ul>
            {checks.slice().sort(byStatus).map((check, i) => <CheckLine key={check.id} check={check} delay={700 + i * 110} />)}
          </ul>
        </div>}
      </>}

      {phase === 'submitting' && <Steps steps={SUBMIT_STEPS} active={Math.min(SUBMIT_STEPS.length - 1, Math.floor(tick / 2))} title="Sending to FactorCloud" />}

      {phase === 'submitted' && createResult?.ok && <div className="theaterDone">
        <div className="theaterBurst" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ transform: `rotate(${i * 30}deg)` }}><b /></i>)}</div>
        <div className="theaterCheckmark" aria-hidden="true"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24" /><path d="M15 27l7 7 15-16" /></svg></div>
        <strong>In FactorCloud</strong>
        <span>Invoice {createResult.invoiceId} · {createResult.steps.filter((s) => s.ok).length} steps completed</span>
      </div>}
    </div>
  </section>;
}

function Steps({ steps, active, title }: { steps: string[]; active: number; title: string }) {
  return <div className="theaterSteps">
    <strong>{title}<span className="theaterDots"><i /><i /><i /></span></strong>
    <ol>
      {steps.map((step, i) => <li key={step} className={i < active ? 'done' : i === active ? 'active' : ''}>
        <span aria-hidden="true">{i < active ? '✓' : ''}</span>{step}
      </li>)}
    </ol>
  </div>;
}

function CheckLine({ check, delay }: { check: CheckResult; delay: number }) {
  const icon = check.status === 'PASS' ? '✓' : check.status === 'REVIEW' ? '!' : '✕';
  const label = check.status === 'PASS' ? 'Pass' : check.status === 'REVIEW' ? 'Review' : 'Fail';
  return <li className={`theaterCheck ${check.status.toLowerCase()}`} style={{ animationDelay: `${delay}ms` }}>
    <span className="theaterCheckIcon" aria-hidden="true">{icon}</span>
    <div><strong>{check.label}</strong><small>{check.message}</small></div>
    <em>{label}</em>
  </li>;
}

function ScoreRing({ pass, total, status }: { pass: number; total: number; status: string }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const share = total ? pass / total : 0;
  const color = status === 'PASS' ? '#0ca30c' : status === 'REVIEW' ? '#fab219' : '#d03b3b';
  return <svg className="theaterRing" viewBox="0 0 56 56" aria-label={`${pass} of ${total} checks passed`}>
    <circle cx="28" cy="28" r={r} fill="none" stroke="#e6e8eb" strokeWidth="6" />
    <circle cx="28" cy="28" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${c * share} ${c}`} transform="rotate(-90 28 28)" style={{ '--len': `${c * share}` } as React.CSSProperties} />
    <text x="28" y="32" textAnchor="middle">{pass}/{total}</text>
  </svg>;
}

function PagePlaceholder() {
  return <svg viewBox="0 0 80 100" className="theaterPlaceholder" aria-hidden="true">
    <rect x="10" y="10" width="34" height="7" rx="2" /><rect x="52" y="10" width="18" height="7" rx="2" />
    {[26, 34, 42, 50, 58, 66].map((y, i) => <rect key={y} x="10" y={y} width={i % 2 ? 48 : 60} height="4" rx="2" />)}
    <rect x="44" y="80" width="26" height="8" rx="2" />
  </svg>;
}

function useFilePreviews(files: File[]): (string | null)[] {
  const urls = useMemo(() => files.map((file) => file.type.startsWith('image/') ? URL.createObjectURL(file) : null), [files]);
  useEffect(() => () => urls.forEach((url) => url && URL.revokeObjectURL(url)), [urls]);
  return urls;
}

function byStatus(a: CheckResult, b: CheckResult): number {
  const rank = (s: string) => (s === 'FAIL' ? 0 : s === 'REVIEW' ? 1 : 2);
  return rank(a.status) - rank(b.status);
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}
