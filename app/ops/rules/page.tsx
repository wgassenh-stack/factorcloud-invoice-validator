'use client';

import { useEffect, useState } from 'react';
import { OpsSidebar } from '@/app/components/OpsSidebar';
import { Skeleton } from '@/app/components/CommandCharts';
import type { EngineMode, RuleSettings } from '@/lib/rules/settings';

const MODES: { value: EngineMode; title: string; detail: string }[] = [
  { value: 'off', title: 'Off', detail: 'The engine does nothing. Clean invoices wait in FactorCloud as before.' },
  { value: 'suggest', title: 'Suggest only', detail: 'The engine records what it would do. People approve and fund from the Funding page.' },
  { value: 'approve', title: 'Auto-approve', detail: 'Clean invoices are verified and approved for funding automatically. A person clicks Fund.' },
  { value: 'fund', title: 'Auto-fund', detail: 'Invoices that pass every rule and cap are funded automatically. Anything held waits for a click. This sends money.' },
];

type RuleKey = keyof RuleSettings['rules'];
const RULES: { key: RuleKey; title: string; detail: string; group: 'Debtor' | 'Client' }[] = [
  { key: 'creditLimit', group: 'Debtor', title: 'Credit limit', detail: "Hold if the debtor's balance plus this invoice is over the client–debtor credit limit, the limit isn't approved, or none is set." },
  { key: 'slowDebtor', group: 'Debtor', title: 'Debtor pays on time', detail: "Hold if too much of what the debtor owes is past due." },
  { key: 'newDebtor', group: 'Debtor', title: 'Known debtor', detail: "Hold the client's first invoice with a debtor." },
  { key: 'concentration', group: 'Debtor', title: 'Concentration', detail: "Hold if this debtor would be too big a share of the client's open A/R." },
  { key: 'cashReserve', group: 'Client', title: 'Cash reserve', detail: "Hold if the client's cash reserve is negative." },
  { key: 'volumeSpike', group: 'Client', title: 'Volume spike', detail: 'Hold if the client is sending far more invoices than usual.' },
  { key: 'newClient', group: 'Client', title: 'Established client', detail: "Don't auto-fund new clients." },
  { key: 'clientCreditLimit', group: 'Client', title: 'Client credit limit', detail: "Hold if the client's total open A/R would go over the client's own credit limit (when one is set)." },
];

export default function RulesPage() {
  const [settings, setSettings] = useState<RuleSettings | null>(null);
  const [editable, setEditable] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch('/api/ops/rules', { cache: 'no-store' }).then(async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not load the rules.');
      setSettings(body.settings); setEditable(body.editable); setNote(body.note ?? '');
    }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  function change(update: (s: RuleSettings) => void) {
    if (!settings) return;
    const next = structuredClone(settings);
    update(next);
    setSettings(next);
    setSaved('');
  }

  async function save() {
    if (!settings) return;
    if (settings.mode === 'fund' && !window.confirm('Auto-fund sends money from FactorCloud without a person clicking, within your caps. Turn it on?')) return;
    setSaving(true); setError('');
    try {
      const res = await fetch('/api/ops/rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not save.');
      setSettings(body.settings); setSaved('Saved. New invoices use these rules.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const s = settings;
  const disabled = !editable || saving;
  const numberField = (label: string, value: number, set: (n: number) => void, suffix = '') => <label className="rulesNumber"><span>{label}</span><span className="rulesInput"><input type="number" value={value} disabled={disabled} onChange={(e) => set(Number(e.target.value))} />{suffix && <em>{suffix}</em>}</span></label>;

  return <main className="opsShell">
    <OpsSidebar active="rules" />
    <section className="opsContent">
      <header className="opsHeader">
        <div><span className="eyebrow">Funding engine</span><h1>Funding rules</h1><p>Decide what the portal may do on its own. Paperwork problems always go to the review queue; these rules decide what happens to clean invoices.</p></div>
        <div className="fundingHeaderActions">
          <a className="secondaryLink" href="/ops/funding">Funding</a>
          {s && <button className="primaryLink" onClick={() => void save()} disabled={disabled}>{saving ? 'Saving…' : 'Save rules'}</button>}
        </div>
      </header>
      {note && <div className="attentionSummary review"><strong>Read only</strong><span>{note}</span></div>}
      {!editable && !note && s && <div className="attentionSummary review"><strong>Read only</strong><span>Only a factor admin can change the funding rules.</span></div>}
      {error && <div className="attentionSummary fail"><strong>Something went wrong</strong><span>{error}</span></div>}
      {saved && <div className="attentionSummary pass"><strong>Saved</strong><span>{saved}</span></div>}
      {!s && !error && <Skeleton height={200} lines={6} />}

      {s && <>
        <section className="dashCard rulesCard">
          <div className="dashCardHeader"><div><span>Step 1</span><h2>How far the engine may go</h2></div></div>
          <div className="rulesModes">
            {MODES.map((mode) => <label key={mode.value} className={`rulesMode ${s.mode === mode.value ? 'active' : ''} ${mode.value}`}>
              <input type="radio" name="mode" checked={s.mode === mode.value} disabled={disabled} onChange={() => change((n) => { n.mode = mode.value; })} />
              <strong>{mode.title}</strong><span>{mode.detail}</span>
            </label>)}
          </div>
          <label className="rulesToggle"><input type="checkbox" checked={s.markVerified} disabled={disabled} onChange={(e) => change((n) => { n.markVerified = e.target.checked; })} /><span><strong>Mark invoices verified before approving</strong><small>Sets verification to Verified (method "ONLINE PORTAL") in FactorCloud. This records the portal's document check, not a call to the debtor.</small></span></label>
        </section>

        {(['Debtor', 'Client'] as const).map((group) => <section key={group} className="dashCard rulesCard">
          <div className="dashCardHeader"><div><span>{group === 'Debtor' ? 'Step 2' : 'Step 3'}</span><h2>{group} rules</h2><p>A rule that trips holds the invoice for a person: approved for funding, not funded. A rule that can't be checked holds it too.</p></div></div>
          {RULES.filter((r) => r.group === group).map((rule) => {
            const cfg = s.rules[rule.key] as Record<string, number | boolean>;
            return <div key={rule.key} className={`rulesRow ${cfg.enabled ? '' : 'off'}`}>
              <label className="rulesToggle"><input type="checkbox" checked={Boolean(cfg.enabled)} disabled={disabled} onChange={(e) => change((n) => { (n.rules[rule.key] as { enabled: boolean }).enabled = e.target.checked; })} /><span><strong>{rule.title}</strong><small>{rule.detail}</small></span></label>
              <div className="rulesNumbers">
                {rule.key === 'slowDebtor' && <>{numberField('Max past due', s.rules.slowDebtor.maxPastDuePct, (v) => change((n) => { n.rules.slowDebtor.maxPastDuePct = v; }), '%')}{numberField('Past due after', s.rules.slowDebtor.pastDueDays, (v) => change((n) => { n.rules.slowDebtor.pastDueDays = v; }), 'days')}</>}
                {rule.key === 'concentration' && numberField('Max share', s.rules.concentration.maxPct, (v) => change((n) => { n.rules.concentration.maxPct = v; }), '%')}
                {rule.key === 'volumeSpike' && numberField('Max vs usual', s.rules.volumeSpike.maxMultiple, (v) => change((n) => { n.rules.volumeSpike.maxMultiple = v; }), '×')}
                {rule.key === 'newClient' && <>{numberField('At least', s.rules.newClient.minInvoices, (v) => change((n) => { n.rules.newClient.minInvoices = v; }), 'invoices')}{numberField('And', s.rules.newClient.minDays, (v) => change((n) => { n.rules.newClient.minDays = v; }), 'days')}</>}
              </div>
            </div>;
          })}
        </section>)}

        <section className="dashCard rulesCard">
          <div className="dashCardHeader"><div><span>Step 4</span><h2>Auto-funding caps</h2><p>Only apply in Auto-fund mode. Over a cap, the invoice is approved and waits for a click.</p></div></div>
          <div className="rulesNumbers wide">
            {numberField('Per invoice', s.caps.perInvoice, (v) => change((n) => { n.caps.perInvoice = v; }), '$')}
            {numberField('Per client per day', s.caps.perClientPerDay, (v) => change((n) => { n.caps.perClientPerDay = v; }), '$')}
            {numberField('All clients per day', s.caps.perFactorPerDay, (v) => change((n) => { n.caps.perFactorPerDay = v; }), '$')}
          </div>
          <label className="rulesToggle"><input type="checkbox" checked={s.caps.businessHoursOnly} disabled={disabled} onChange={(e) => change((n) => { n.caps.businessHoursOnly = e.target.checked; })} /><span><strong>Only during business hours</strong><small>Weekdays 8am–6pm.</small></span></label>
          <label className="rulesToggle"><input type="checkbox" checked={s.caps.autoFundClients === 'all'} disabled={disabled} onChange={(e) => change((n) => { n.caps.autoFundClients = e.target.checked ? 'all' : []; })} /><span><strong>Every client may be auto-funded</strong><small>Untick to allow only the clients listed below.</small></span></label>
          {s.caps.autoFundClients !== 'all' && <label className="rulesList"><span>FactorCloud client IDs, one per line</span><textarea rows={3} disabled={disabled} value={(s.caps.autoFundClients as string[]).join('\n')} onChange={(e) => change((n) => { n.caps.autoFundClients = e.target.value.split(/\s+/).filter(Boolean); })} /></label>}
        </section>
      </>}
    </section>
  </main>;
}
