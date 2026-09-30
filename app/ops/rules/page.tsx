'use client';

import { useEffect, useState } from 'react';
import { RulePreview } from '@/app/components/RulePreview';
import { OpsSidebar } from '@/app/components/OpsSidebar';
import { Skeleton } from '@/app/components/CommandCharts';
import {OpsDialog,OpsNotice} from '@/app/components/OpsUI';
import { normalizeSettings, type EngineMode, type RuleSettings } from '@/lib/rules/settings';

const MODES: { value: EngineMode; title: string; detail: string }[] = [
  { value: 'off', title: 'Off', detail: 'The engine does nothing. Clean invoices wait in FactorCloud as before.' },
  { value: 'suggest', title: 'Suggest only', detail: 'The engine records what it would do. People approve and fund from the Funding page.' },
  { value: 'approve', title: 'Auto-approve', detail: 'Clean invoices are verified and approved for funding automatically. A person clicks Fund.' },
  { value: 'fund', title: 'Auto-fund', detail: 'Invoices that pass every rule and cap are funded automatically. Anything held waits for a click. This sends money.' },
];

type RuleKey = keyof RuleSettings['rules'];
const RULES: { key: RuleKey; title: string; detail: string; group: 'Debtor' | 'Client' }[] = [
  { key: 'creditLimit', group: 'Debtor', title: 'Credit limit', detail: "Hold if the debtor's balance plus this invoice is over the client–debtor credit limit, the limit isn't approved, or none is set." },
  { key: 'slowDebtor', group: 'Debtor', title: 'Debtor pays on time', detail: "Hold if too much of the debtor’s open balance exceeds the selected invoice age." },
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
  const [demo,setDemo]=useState(false);
  const [baseline,setBaseline]=useState<RuleSettings|null>(null);
  const [confirm,setConfirm]=useState(false);
  const [ack,setAck]=useState(false);

  useEffect(() => {
    void fetch('/api/ops/rules', { cache: 'no-store' }).then(async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not load the rules.');
      setSettings(body.settings); setBaseline(body.settings); setEditable(body.editable); setDemo(Boolean(body.demo)); setNote(body.note ?? '');
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
    if(demo){setBaseline(structuredClone(settings));setSaved('Applied to this demo tab only. Reload restores the defaults.');setConfirm(false);return;}
    setSaving(true); setError('');
    try {
      const res = await fetch('/api/ops/rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not save.');
      setSettings(body.settings); setBaseline(body.settings); setConfirm(false); setSaved('Saved. New decisions use these rules.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const s = settings;
  const disabled = (!editable&&!demo) || saving;
  const changes=baseline&&s?settingChanges(baseline,s):[];
  const numberField = (label: string, value: number, set: (n: number) => void, suffix = '') => <label className="rulesNumber"><span>{label}</span><span className="rulesInput"><input type="number" value={value} disabled={disabled} onChange={(e) => set(Number(e.target.value))} />{suffix && <em>{suffix}</em>}</span></label>;

  return <main className="opsShell">
    <OpsSidebar active="rules" />
    <section className="opsContent"><div className="oc-topbar"><span>Factor workspace / <strong>Automation Rules</strong></span></div>
      <header className="opsHeader">
        <div><span className="eyebrow">Factor defaults</span><h1>Automation Rules</h1><p>Change each financial rule independently. Paperwork and No Buy remain separate approval blockers.</p></div>
        <div className="fundingHeaderActions">
          <a className="secondaryLink" href="/ops/funding">Funding</a>
          {s && <button className="primaryLink" onClick={() => {setSettings(normalizeSettings(s));setAck(false);setConfirm(true);}} disabled={disabled||!changes.length}>{saving ? 'Saving…' : demo?'Apply to demo':'Review & save'}</button>}
        </div>
      </header>
      {note && <div className="attentionSummary review"><strong>{demo?'Editable demo example':'Read only'}</strong><span>{note} {demo?'These controls can be tried locally; no production setting is written.':''}</span></div>}
      {!editable && !note && s && <div className="attentionSummary review"><strong>Read only</strong><span>Only a factor admin can change the funding rules.</span></div>}
      {error && <div className="attentionSummary fail"><strong>Something went wrong</strong><span>{error}</span></div>}
      {saved && <div className="attentionSummary pass"><strong>Saved</strong><span>{saved}</span></div>}
      {!s && !error && <Skeleton height={200} lines={6} />}

      {s && <>
        <div className="oc-tabs" role="tablist" aria-label="Rule scope"><button className="oc-tab" role="tab" aria-selected="true">Factor defaults</button><button className="oc-tab" disabled>Client overrides · future</button><button className="oc-tab" disabled>Client / debtor overrides · future</button></div>
        <div className="oc-savebar"><span>{changes.length?changes.length+' unsaved changes':'No unsaved changes'}{demo?' · demo only':''}</span><button className="oc-button" disabled={disabled||!changes.length} onClick={()=>{setSettings(structuredClone(baseline!));setError('');}}>Discard changes</button></div>
        <section className="dashCard rulesCard">
          <div className="dashCardHeader"><div><h2>Automation mode</h2></div></div>
          <div className="rulesModes">
            {MODES.map((mode) => <label key={mode.value} className={`rulesMode ${s.mode === mode.value ? 'active' : ''} ${mode.value}`}>
              <input type="radio" name="mode" checked={s.mode === mode.value} disabled={disabled} onChange={() => change((n) => { n.mode = mode.value; })} />
              <strong>{mode.title}</strong><span>{mode.detail}</span>
            </label>)}
          </div>
          <label className="rulesToggle"><input type="checkbox" checked={s.markVerified} disabled={disabled} onChange={(e) => change((n) => { n.markVerified = e.target.checked; })} /><span><strong>Mark invoices verified before approving</strong><small>Sets verification to Verified (method "ONLINE PORTAL") in FactorCloud. This records the portal's document check, not a call to the debtor.</small></span></label>
        </section>

        {(['Debtor', 'Client'] as const).map((group) => <section key={group} className="dashCard rulesCard">
          <div className="dashCardHeader"><div><h2>{group} funding rules</h2><p>Individual switches and thresholds. A triggered or unavailable rule holds automatic funding for a person.</p></div></div>
          {RULES.filter((r) => r.group === group).map((rule) => {
            const cfg = s.rules[rule.key] as Record<string, number | boolean>;
            return <div key={rule.key} className={`rulesRow ${cfg.enabled ? '' : 'off'}`}>
              <label className="rulesToggle"><input type="checkbox" checked={Boolean(cfg.enabled)} disabled={disabled} onChange={(e) => change((n) => { (n.rules[rule.key] as { enabled: boolean }).enabled = e.target.checked; })} /><span><strong>{rule.title}</strong><small>{rule.detail}</small></span></label>
              <div className="rulesNumbers">
                {rule.key === 'slowDebtor' && <>{numberField('Maximum aged balance', s.rules.slowDebtor.maxPastDuePct, (v) => change((n) => { n.rules.slowDebtor.maxPastDuePct = v; }), '%')}{numberField('Invoice age', s.rules.slowDebtor.pastDueDays, (v) => change((n) => { n.rules.slowDebtor.pastDueDays = v; }), 'days')}</>}
                {rule.key === 'concentration' && numberField('Max share', s.rules.concentration.maxPct, (v) => change((n) => { n.rules.concentration.maxPct = v; }), '%')}
                {rule.key === 'volumeSpike' && numberField('Max vs usual', s.rules.volumeSpike.maxMultiple, (v) => change((n) => { n.rules.volumeSpike.maxMultiple = v; }), '×')}
                {rule.key === 'newClient' && <>{numberField('At least', s.rules.newClient.minInvoices, (v) => change((n) => { n.rules.newClient.minInvoices = v; }), 'invoices')}{numberField('And', s.rules.newClient.minDays, (v) => change((n) => { n.rules.newClient.minDays = v; }), 'days')}</>}
              </div>
            </div>;
          })}
        </section>)}

        <section className="dashCard rulesCard">
          <div className="dashCardHeader"><div><h2>Automatic funding limits</h2><p>Caps use invoice value. Over a cap, funding requires a person; zero prevents automatic funding of positive amounts.</p></div></div>
          <div className="rulesNumbers wide">
            {numberField('Per invoice', s.caps.perInvoice, (v) => change((n) => { n.caps.perInvoice = v; }), '$')}
            {numberField('Per client per day', s.caps.perClientPerDay, (v) => change((n) => { n.caps.perClientPerDay = v; }), '$')}
            {numberField('All clients per day', s.caps.perFactorPerDay, (v) => change((n) => { n.caps.perFactorPerDay = v; }), '$')}
          </div>
          <label className="rulesToggle"><input type="checkbox" checked={s.caps.businessHoursOnly} disabled={disabled} onChange={(e) => change((n) => { n.caps.businessHoursOnly = e.target.checked; })} /><span><strong>Only during business hours</strong><small>Weekdays 8am–6pm.</small></span></label>
          <label className="rulesToggle"><input type="checkbox" checked={s.caps.autoFundClients === 'all'} disabled={disabled} onChange={(e) => change((n) => { n.caps.autoFundClients = e.target.checked ? 'all' : []; })} /><span><strong>Every client may be auto-funded</strong><small>Untick to allow only the clients listed below.</small></span></label>
          {s.caps.autoFundClients !== 'all' && <label className="rulesList"><span>FactorCloud client IDs, one per line</span><textarea rows={3} disabled={disabled} value={(s.caps.autoFundClients as string[]).join('\n')} onChange={(e) => change((n) => { n.caps.autoFundClients = e.target.value.split(/\s+/).filter(Boolean); })} /></label>}
        </section>
        <OpsNotice>Financial-rule responses are currently fixed to a funding hold. Custom failure responses and inherited client/debtor overrides require additional support. Payment behavior currently uses invoice age, not due-date delinquency.</OpsNotice>
        {!demo&&<RulePreview settings={s}/>}
      </>}
      {confirm&&s&&<OpsDialog title={demo?'Apply demo changes':'Review rule changes'} onClose={()=>{if(!saving)setConfirm(false);}}><div className="oc-table-wrap"><table className="oc-table"><thead><tr><th>Setting</th><th>Before</th><th>After</th></tr></thead><tbody>{changes.map(c=><tr key={c.label}><td>{c.label}</td><td>{c.before}</td><td><strong>{c.after}</strong></td></tr>)}</tbody></table></div><OpsNotice tone={s.mode==='fund'?'warn':'info'}>{demo?'This changes the example in this tab only.':s.mode==='fund'?'Auto-fund can send money without a person clicking, within these rules and caps. Saving publishes these factor-wide settings.':'Saving publishes these factor-wide settings for new decisions.'}</OpsNotice>{s.mode==='fund'&&!demo&&<label className="oc-rule-toggle"><input type="checkbox" checked={ack} disabled={saving} onChange={e=>setAck(e.target.checked)}/>I reviewed the automation scope and financial limits.</label>}{error&&<OpsNotice tone="bad">{error}</OpsNotice>}<div className="oc-actions"><button className="oc-button" disabled={saving} onClick={()=>setConfirm(false)}>Cancel</button><button className="oc-button primary" disabled={saving||(!demo&&s.mode==='fund'&&!ack)} onClick={()=>void save()}>{saving?'Saving…':demo?'Apply demo changes':'Save rules'}</button></div></OpsDialog>}
    </section>
  </main>;
}
function settingChanges(before:RuleSettings,after:RuleSettings){const out:{label:string;before:string;after:string}[]=[];const labels:Record<string,string>={mode:'Automation mode',markVerified:'Mark invoices verified',creditLimit:'Debtor credit limit',clientCreditLimit:'Client credit limit',slowDebtor:'Debtor payment behavior',newDebtor:'Known debtor',concentration:'Debtor concentration',cashReserve:'Cash reserve',volumeSpike:'Unusual volume',newClient:'Established client',enabled:'Enabled',maxPastDuePct:'Maximum aged balance (%)',pastDueDays:'Invoice age (days)',maxPct:'Maximum share (%)',maxMultiple:'Maximum vs normal',minDays:'Minimum history (days)',minInvoices:'Minimum invoices',perInvoice:'Per-invoice cap',perClientPerDay:'Daily client cap',perFactorPerDay:'Daily factor cap',businessHoursOnly:'Business hours only',autoFundClients:'Automatic funding clients'};function walk(a:Record<string,unknown>,b:Record<string,unknown>,path:string[]=[]){for(const key of Object.keys(b)){const v=b[key],prior=a[key];if(v&&typeof v==='object'&&!Array.isArray(v))walk(prior as Record<string,unknown>,v as Record<string,unknown>,[...path,key]);else if(JSON.stringify(prior)!==JSON.stringify(v))out.push({label:[...path,key].filter(k=>k!=='rules'&&k!=='caps').map(k=>labels[k]||k).join(' · '),before:display(prior),after:display(v)});}}walk(before as unknown as Record<string,unknown>,after as unknown as Record<string,unknown>);return out;}
function display(value:unknown){return typeof value==='boolean'?value?'On':'Off':Array.isArray(value)?value.join(', ')||'None':String(value);}
