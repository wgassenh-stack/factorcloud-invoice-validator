'use client';

import { useEffect, useState } from 'react';
import { RulePreview } from '@/app/components/RulePreview';
import { OpsSidebar } from '@/app/components/OpsSidebar';
import { Skeleton } from '@/app/components/CommandCharts';
import {OpsDialog,OpsNotice} from '@/app/components/OpsUI';
import { normalizeSettings, overrideFrom, settingsForClient, type ClientOverride, type EngineMode, type RuleSettings } from '@/lib/rules/settings';
import styles from './Rules.module.css';

const MODES: { value: EngineMode; title: string; detail: string }[] = [
  { value: 'off', title: 'Off', detail: 'The engine does nothing. Clean invoices wait in FactorCloud as before.' },
  { value: 'suggest', title: 'Suggest only', detail: 'The engine records what it would do. People approve and fund from the Funding page.' },
  { value: 'approve', title: 'Auto-approve', detail: 'Clean invoices are verified and approved for funding automatically. A person clicks Fund.' },
  { value: 'fund', title: 'Auto-fund', detail: 'Invoices that pass every rule and cap are approved and funded automatically. Anything held waits, unapproved, for one click. This sends money.' },
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
  const [clients,setClients]=useState<{id:string;name:string}[]>([]);
  const [tab,setTab]=useState<'factor'|'clients'>('factor');
  const [clientId,setClientId]=useState('');
  const [clientQuery,setClientQuery]=useState('');

  useEffect(() => {
    void fetch('/api/ops/rules', { cache: 'no-store' }).then(async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not load the rules.');
      setSettings(body.settings); setBaseline(body.settings); setEditable(body.editable); setDemo(Boolean(body.demo)); setNote(body.note ?? ''); setClients(body.clients ?? []); setClientId((body.clients ?? [])[0]?.id ?? '');
      const params = new URLSearchParams(window.location.search);
      if (params.get('tab') === 'clients' || params.get('client')) setTab('clients');
      const wanted = params.get('client');
      if (wanted && (body.clients ?? []).some((c: { id: string }) => c.id === wanted)) setClientId(wanted);
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
    setSaving(true); setError('');
    try {
      const res = await fetch('/api/ops/rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not save.');
      setSettings(body.settings); setBaseline(body.settings); setConfirm(false); setSaved(demo ? 'Applied to the demo. New demo invoices use these rules.' : 'Saved. New decisions use these rules.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const s = settings;
  const disabled = (!editable&&!demo) || saving;
  const changes=baseline&&s?settingChanges(baseline,s):[];
  // Effective automation per client, before and after this change (client rules and pause included).
  const effects=baseline&&s?clients.map(c=>({id:c.id,name:c.name,before:settingsForClient(baseline,c.id).mode,after:settingsForClient(s,c.id).mode})).filter(e=>e.before!==e.after):[];
  const numberField = (label: string, value: number, set: (n: number) => void, suffix = '') => <label className="rulesNumber"><span>{label}</span><span className="rulesInput"><input type="number" value={value} disabled={disabled} onChange={(e) => set(Number(e.target.value))} />{suffix && <em>{suffix}</em>}</span></label>;

  type Editable = { mode: EngineMode; rules: RuleSettings['rules']; caps: { perInvoice: number; perClientPerDay: number } };
  /** The rule editor, shared by the factor defaults and each client's own rules. */
  function editor<T extends Editable>(t: T, edit: (fn: (target: T) => void) => void, factor: boolean) {
    const f = t as unknown as RuleSettings;
    return <>
      <section className="dashCard rulesCard">
        <div className="dashCardHeader"><div><h2>Automation mode</h2></div></div>
        <div className="rulesModes">
          {MODES.map((mode) => <label key={mode.value} className={`rulesMode ${t.mode === mode.value ? 'active' : ''} ${mode.value}`}>
            <input type="radio" name={factor ? 'mode' : 'client-mode'} checked={t.mode === mode.value} disabled={disabled} onChange={() => edit((n) => { n.mode = mode.value; })} />
            <strong>{mode.title}</strong><span>{mode.detail}</span>
          </label>)}
        </div>
        {factor && <label className="rulesToggle"><input type="checkbox" checked={f.markVerified} disabled={disabled} onChange={(e) => edit((n) => { (n as unknown as RuleSettings).markVerified = e.target.checked; })} /><span><strong>Mark invoices verified before approving</strong><small>Sets verification to Verified (method "ONLINE PORTAL") in FactorCloud, recording the portal's document check.</small></span></label>}
      </section>

      {(['Debtor', 'Client'] as const).map((group) => <section key={group} className="dashCard rulesCard">
        <div className="dashCardHeader"><div><h2>{group} rules</h2><p>Switch each rule on or off and set its threshold. When a rule trips, the invoice waits for one click instead of being funded automatically.</p></div></div>
        {RULES.filter((r) => r.group === group).map((rule) => {
          const cfg = t.rules[rule.key] as Record<string, number | boolean>;
          return <div key={rule.key} className={`rulesRow ${cfg.enabled ? '' : 'off'}`}>
            <label className="rulesToggle"><input type="checkbox" checked={Boolean(cfg.enabled)} disabled={disabled} onChange={(e) => edit((n) => { (n.rules[rule.key] as { enabled: boolean }).enabled = e.target.checked; })} /><span><strong>{rule.title}</strong><small>{rule.detail}</small></span></label>
            <div className="rulesNumbers">
              {rule.key === 'slowDebtor' && <>{numberField('Maximum aged balance', t.rules.slowDebtor.maxPastDuePct, (v) => edit((n) => { n.rules.slowDebtor.maxPastDuePct = v; }), '%')}{numberField('Invoice age', t.rules.slowDebtor.pastDueDays, (v) => edit((n) => { n.rules.slowDebtor.pastDueDays = v; }), 'days')}</>}
              {rule.key === 'concentration' && numberField('Max share', t.rules.concentration.maxPct, (v) => edit((n) => { n.rules.concentration.maxPct = v; }), '%')}
              {rule.key === 'volumeSpike' && numberField('Max vs usual', t.rules.volumeSpike.maxMultiple, (v) => edit((n) => { n.rules.volumeSpike.maxMultiple = v; }), '×')}
              {rule.key === 'newClient' && <>{numberField('At least', t.rules.newClient.minInvoices, (v) => edit((n) => { n.rules.newClient.minInvoices = v; }), 'invoices')}{numberField('And', t.rules.newClient.minDays, (v) => edit((n) => { n.rules.newClient.minDays = v; }), 'days')}</>}
            </div>
          </div>;
        })}
      </section>)}

      <section className="dashCard rulesCard">
        <div className="dashCardHeader"><div><h2>Automatic funding limits</h2><p>Anything over a limit isn't funded automatically; it waits for one click.</p></div></div>
        <div className="rulesNumbers wide">
          {numberField('Per invoice', t.caps.perInvoice, (v) => edit((n) => { n.caps.perInvoice = v; }), '$')}
          {numberField(factor ? 'Per client per day' : 'This client per day', t.caps.perClientPerDay, (v) => edit((n) => { n.caps.perClientPerDay = v; }), '$')}
          {factor && numberField('All clients per day', f.caps.perFactorPerDay, (v) => edit((n) => { (n as unknown as RuleSettings).caps.perFactorPerDay = v; }), '$')}
        </div>
        {factor && <>
          <label className="rulesToggle"><input type="checkbox" checked={f.caps.businessHoursOnly} disabled={disabled} onChange={(e) => edit((n) => { (n as unknown as RuleSettings).caps.businessHoursOnly = e.target.checked; })} /><span><strong>Only during business hours</strong><small>Weekdays 8am–6pm.</small></span></label>
          <label className="rulesToggle"><input type="checkbox" checked={f.caps.autoFundClients === 'all'} disabled={disabled} onChange={(e) => edit((n) => { (n as unknown as RuleSettings).caps.autoFundClients = e.target.checked ? 'all' : []; })} /><span><strong>Every client may be auto-funded</strong><small>Untick to allow only the clients listed below.</small></span></label>
          {f.caps.autoFundClients !== 'all' && <label className="rulesList"><span>FactorCloud client IDs, one per line</span><textarea rows={3} disabled={disabled} value={(f.caps.autoFundClients as string[]).join('\n')} onChange={(e) => edit((n) => { (n as unknown as RuleSettings).caps.autoFundClients = e.target.value.split(/\s+/).filter(Boolean); })} /></label>}
        </>}
      </section>
    </>;
  }

  return <main className="opsShell">
    <OpsSidebar active="rules" />
    <section className="opsContent"><div className="oc-topbar"><span>Factor workspace / <strong>Automation Rules</strong></span></div>
      <header className="opsHeader">
        <div><span className="eyebrow">Automation</span><h1>Automation Rules</h1><p>Decide which invoices fund themselves, for every client or client by client. Paperwork issues and No Buy debtors always go to a person.</p></div>
        <div className="fundingHeaderActions">
          <a className="secondaryLink" href="/ops/funding">Funding</a>
          {s && <button className="primaryLink" onClick={() => {setSettings(normalizeSettings(s));setAck(false);setConfirm(true);}} disabled={disabled||!changes.length}>{saving ? 'Saving…' : 'Review & save'}</button>}
        </div>
      </header>
      {note && <div className="attentionSummary review"><strong>Read only</strong><span>{note}</span></div>}
      {!editable && !note && !demo && s && <div className="attentionSummary review"><strong>Read only</strong><span>Only a factor admin can change the funding rules.</span></div>}
      {error && <div className="attentionSummary fail"><strong>Something went wrong</strong><span>{error}</span></div>}
      {saved && <div className="attentionSummary pass"><strong>Saved</strong><span>{saved}</span></div>}
      {!s && !error && <Skeleton height={200} lines={6} />}

      {s && <>
        <div className="oc-tabs" role="tablist" aria-label="Rule scope"><button className="oc-tab" role="tab" aria-selected={tab==='factor'} onClick={()=>setTab('factor')}>Factor defaults</button><button className="oc-tab" role="tab" aria-selected={tab==='clients'} onClick={()=>setTab('clients')}>Client rules<span>{Object.keys(s.clientOverrides).length}</span></button></div>
        <div className="oc-savebar"><span>{changes.length?changes.length+' unsaved changes':'No unsaved changes'}{demo?' · demo':''}</span><button className="oc-button" disabled={disabled||!changes.length} onClick={()=>{setSettings(structuredClone(baseline!));setError('');}}>Discard changes</button></div>
        <section className={styles.pause+' '+(s.paused?styles.paused:'')}>
          <div><strong>{s.paused?'All automation is paused':'Pause all automation'}</strong><span>{s.paused?'Nothing is approved or funded automatically for any client, whatever its own rules say. People can still approve and fund by hand.':'One switch that stops every automatic approval and funding, for all clients, including clients with their own rules.'}</span></div>
          <button type="button" className={s.paused?'primaryLink':'oc-button'} disabled={disabled} onClick={()=>change((n)=>{n.paused=!n.paused;})}>{s.paused?'Resume automation':'Pause all'}</button>
        </section>
        {tab==='factor'&&editor(s,(fn)=>change((n)=>fn(n)),true)}
        {tab==='clients'&&<div className={styles.clients}>
          <nav className={styles.clientList} aria-label="Clients">
            <p className={styles.listNote}>Each client uses the factor defaults unless you give it its own rules.</p>
            {clients.length>8&&<input className={styles.search} type="search" placeholder="Search clients" aria-label="Search clients" value={clientQuery} onChange={(e)=>setClientQuery(e.target.value)}/>}
            {clients.filter((c)=>c.name.toLowerCase().includes(clientQuery.trim().toLowerCase())).map((c)=>{const o=s.clientOverrides[c.id];return <button key={c.id} className={styles.client+' '+(clientId===c.id?styles.selected:'')} onClick={()=>setClientId(c.id)} aria-current={clientId===c.id?'true':undefined}><strong>{c.name}</strong><small>{o?summary(o):'Factor defaults'}</small>{o&&<span className={styles.custom}>Custom</span>}</button>;})}
            {!clients.length&&<p className={styles.listNote}>No clients yet.</p>}
          </nav>
          <div className={styles.clientEditor}>{(()=>{
            const c=clients.find((x)=>x.id===clientId);if(!c)return null;const o=s.clientOverrides[c.id];
            if(!o)return <section className="dashCard rulesCard"><div className="dashCardHeader"><div><h2>{c.name}</h2><p>Uses the factor defaults: {summary(overrideFrom(s,c.name))}.</p></div></div><p className={styles.pitch}>Give this client its own automation: a bigger cap for a long-standing client, suggestions only for a new one, a stricter concentration limit for a client with one big customer.</p><div className={styles.actions}><button className="primaryLink" disabled={disabled} onClick={()=>change((n)=>{n.clientOverrides[c.id]=overrideFrom(n,c.name);})}>Customize rules for {c.name}</button></div></section>;
            return <><section className="dashCard rulesCard"><div className="dashCardHeader"><div><h2>{c.name} · custom rules</h2><p>These replace the factor defaults for this client. The all-clients daily cap, business hours and the auto-fund list still apply.</p></div><button className="oc-button" disabled={disabled} onClick={()=>change((n)=>{delete n.clientOverrides[c.id];})}>Use factor defaults</button></div>{differences(s,o).length>0&&<div className={styles.diffs}>{differences(s,o).map((d)=><span key={d}>{d}</span>)}</div>}</section>
              {editor(o,(fn)=>change((n)=>fn(n.clientOverrides[c.id])),false)}</>;
          })()}</div>
        </div>}
        {!demo&&<RulePreview settings={s}/>}
      </>}
      {confirm&&s&&<OpsDialog title='Review rule changes' onClose={()=>{if(!saving)setConfirm(false);}}><div className="oc-table-wrap"><table className="oc-table"><thead><tr><th>Setting</th><th>Before</th><th>After</th></tr></thead><tbody>{changes.map(c=><tr key={c.label}><td>{c.label}</td><td>{c.before}</td><td><strong>{c.after}</strong></td></tr>)}</tbody></table></div>{effects.length>0&&<><div className="oc-section-label">What changes for each client</div><div className="oc-table-wrap"><table className="oc-table"><thead><tr><th>Client</th><th>Before</th><th>After</th></tr></thead><tbody>{effects.map(e=><tr key={e.id}><td>{e.name}</td><td>{MODE_NAME[e.before]}</td><td><strong>{MODE_NAME[e.after]}</strong>{e.after==='fund'&&<> · <span className={styles.startsFunding}>starts funding automatically</span></>}</td></tr>)}</tbody></table></div></>}
      <OpsNotice tone={effects.some(e=>e.after==='fund')||s.mode==='fund'?'warn':'info'}>{demo?'This changes the demo rules. New demo invoices use them.':s.mode==='fund'?'Auto-fund can send money without a person clicking, within these rules and caps. Saving publishes these factor-wide settings.':'Saving publishes these factor-wide settings for new decisions.'}</OpsNotice>{s.mode==='fund'&&!demo&&<label className="oc-rule-toggle"><input type="checkbox" checked={ack} disabled={saving} onChange={e=>setAck(e.target.checked)}/>I reviewed the automation scope and financial limits.</label>}{error&&<OpsNotice tone="bad">{error}</OpsNotice>}<div className="oc-actions"><button className="oc-button" disabled={saving} onClick={()=>setConfirm(false)}>Cancel</button><button className="oc-button primary" disabled={saving||(!demo&&s.mode==='fund'&&!ack)} onClick={()=>void save()}>{saving?'Saving…':'Save rules'}</button></div></OpsDialog>}
    </section>
  </main>;
}
function settingChanges(before:RuleSettings,after:RuleSettings){const out:{label:string;before:string;after:string}[]=[];const labels:Record<string,string>={paused:'Pause all automation',mode:'Automation mode',markVerified:'Mark invoices verified',creditLimit:'Debtor credit limit',clientCreditLimit:'Client credit limit',slowDebtor:'Debtor payment behavior',newDebtor:'Known debtor',concentration:'Debtor concentration',cashReserve:'Cash reserve',volumeSpike:'Unusual volume',newClient:'Established client',enabled:'Enabled',maxPastDuePct:'Maximum aged balance (%)',pastDueDays:'Invoice age (days)',maxPct:'Maximum share (%)',maxMultiple:'Maximum vs normal',minDays:'Minimum history (days)',minInvoices:'Minimum invoices',perInvoice:'Per-invoice cap',perClientPerDay:'Daily client cap',perFactorPerDay:'Daily factor cap',businessHoursOnly:'Business hours only',autoFundClients:'Automatic funding clients'};function walk(a:Record<string,unknown>|undefined,b:Record<string,unknown>,path:string[],prefix=''){a=a||{};for(const key of Object.keys(b)){if(key==='clientOverrides'||key==='name')continue;const v=b[key],prior=a[key];if(v&&typeof v==='object'&&!Array.isArray(v))walk(prior as Record<string,unknown>,v as Record<string,unknown>,[...path,key],prefix);else if(JSON.stringify(prior)!==JSON.stringify(v))out.push({label:prefix+[...path,key].filter(k=>k!=='rules'&&k!=='caps').map(k=>labels[k]||k).join(' · '),before:display(prior),after:display(v)});}}
walk(before as unknown as Record<string,unknown>,after as unknown as Record<string,unknown>,[]);
for(const id of new Set([...Object.keys(before.clientOverrides||{}),...Object.keys(after.clientOverrides||{})])){const was=before.clientOverrides?.[id],now=after.clientOverrides?.[id],name=(now||was)!.name;
  if(!was)out.push({label:name,before:'Factor defaults',after:'Custom rules'});else if(!now)out.push({label:name,before:'Custom rules',after:'Factor defaults'});
  if(now)walk((was||overrideFrom(before,name)) as unknown as Record<string,unknown>,now as unknown as Record<string,unknown>,[],name+' · ');}
return out;}
/** One line describing a client's rules. */
function summary(o:ClientOverride){const mode=MODES.find(m=>m.value===o.mode)?.title||o.mode;return o.mode==='fund'?`${mode} up to ${money(o.caps.perInvoice)} an invoice, ${money(o.caps.perClientPerDay)} a day`:mode;}
/** How a client's rules differ from the factor defaults. */
function differences(s:RuleSettings,o:ClientOverride){const out:string[]=[];if(o.mode!==s.mode)out.push((MODES.find(m=>m.value===o.mode)?.title||o.mode)+' (default: '+(MODES.find(m=>m.value===s.mode)?.title||s.mode)+')');if(o.caps.perInvoice!==s.caps.perInvoice)out.push(money(o.caps.perInvoice)+' per invoice (default '+money(s.caps.perInvoice)+')');if(o.caps.perClientPerDay!==s.caps.perClientPerDay)out.push(money(o.caps.perClientPerDay)+' a day (default '+money(s.caps.perClientPerDay)+')');for(const r of RULES){const a=o.rules[r.key] as Record<string,unknown>,b=s.rules[r.key] as Record<string,unknown>;if(a.enabled!==b.enabled)out.push(r.title+(a.enabled?' on':' off'));else if(JSON.stringify(a)!==JSON.stringify(b))out.push(r.title+' threshold changed');}return out.length?out:['Same as the factor defaults so far'];}
const money=(n:number)=>'$'+Math.round(n).toLocaleString('en-US');
const MODE_NAME:Record<EngineMode,string>={off:'Off',suggest:'Suggest only',approve:'Auto-approve',fund:'Auto-fund'};
function display(value:unknown){return typeof value==='boolean'?value?'On':'Off':Array.isArray(value)?value.join(', ')||'None':String(value);}
