'use client';
import {useEffect,useState} from 'react';
import {OpsSidebar} from '@/app/components/OpsSidebar';
import {OpsHeader,OpsPanel,OpsMetric,OpsNotice,OpsStatus,OpsEmpty,OpsIcon,opsFetch,opsMoney,opsTime} from '@/app/components/OpsUI';
import {DashboardSkeleton} from '@/app/components/CommandCharts';
import {modeLabels,runLabel,waitsOnClient,oldestFirst,waitLabel,type FundingData,type ReviewData} from '@/lib/operations-view';
import type {EngineRun} from '@/lib/funding-engine';
import styles from './Overview.module.css';
type RecoveryData={items:{id:string;kind:string;invoice_number:string|null;detail:string;created_at:string}[];editable:boolean;note?:string};
export default function Overview() {
  const [funding,setFunding]=useState<FundingData|null>(null),[activity,setActivity]=useState<FundingData|null>(null),[reviews,setReviews]=useState<ReviewData|null>(null),[recovery,setRecovery]=useState<RecoveryData|null>(null);
  const [loading,setLoading]=useState(true),[errors,setErrors]=useState<string[]>([]);
  async function load(){setLoading(true);const results=await Promise.allSettled([opsFetch<FundingData>('/api/ops/funding?lane=decision'),opsFetch<FundingData>('/api/ops/funding'),opsFetch<ReviewData>('/api/ops/reviews'),opsFetch<RecoveryData>('/api/ops/recovery')]);const notes:string[]=[];results.forEach((r,i)=>{if(r.status==='fulfilled'){if(i===0)setFunding(r.value as FundingData);if(i===1)setActivity(r.value as FundingData);if(i===2)setReviews(r.value as ReviewData);if(i===3)setRecovery(r.value as RecoveryData);}else{notes.push(['Funding','Recent activity','Paperwork review','Recovery'][i]+': '+String(r.reason?.message||r.reason));if(i===0)setFunding(null);if(i===1)setActivity(null);if(i===2)setReviews(null);if(i===3)setRecovery(null);}});setErrors(notes);setLoading(false);}
  useEffect(()=>{void load();},[]);
  const ready=funding?.available?funding.runs:[],summary=funding?.available?funding.summary:null;
  const rows=oldestFirst(reviews?.records||[]),factorRows=rows.filter(r=>!waitsOnClient(r)),clientCount=rows.length-factorRows.length;
  const recoveryAvailable=Boolean(recovery&&!recovery.note),recoveryCount=recoveryAvailable?recovery!.items.length:null;
  return <main className="opsShell"><OpsSidebar active="overview"/><section className="opsContent">
    <OpsHeader title="Overview" description="Invoices are checked, approved and funded automatically. You handle the exceptions." actions={<><button className="oc-button" onClick={()=>void load()} disabled={loading}>{loading?'Refreshing…':'Refresh'}</button><a className="oc-button primary" href="/ops/funding">Review funding <OpsIcon name="arrow"/></a></>}/>
    {errors.map(error=><OpsNotice tone="bad" key={error}>{error}</OpsNotice>)}
    {recoveryCount!=null&&recoveryCount>0&&<div className="oc-alert"><div><strong>{recoveryCount} operation{recoveryCount===1?'':'s'} need reconciliation</strong><p>Verify the remote result before another approval or funding attempt.</p></div><a className="oc-button" href="/ops/recovery">Open Recovery</a></div>}
    {loading&&!reviews&&!funding?<DashboardSkeleton metrics={4}/>:<>
      {activity?.available&&activity.summary?.today&&<AutomationToday data={activity}/>}
      <div className="oc-metrics">
        <OpsMetric label="Paperwork exceptions" value={reviews?rows.length:'—'} detail={reviews?factorRows.length+' with factor · '+clientCount+' with client':'Review data unavailable'} href="/ops/reviews"/>
        <OpsMetric label="Needs a click" value={summary?.approved??'—'} detail={summary?opsMoney(summary.approvedAmount)+' invoice value':'Funding data unavailable'} href="/ops/funding"/>
        <OpsMetric label="Auto-funded today" value={summary?.autoToday??'—'} detail={summary?opsMoney(summary.autoTodayAmount)+' invoice value · '+summary.timeZone:'Funding data unavailable'} href="/ops/funding?lane=funded"/>
        <OpsMetric label="Open reconciliation" value={recoveryCount??'—'} detail={recoveryCount==null?'Recovery data unavailable':'Verify uncertain or incomplete operations'} href="/ops/recovery" critical={Boolean(recoveryCount)}/>
      </div>
      <div className="oc-grid"><div className="oc-stack">
        {activity?.available&&activity.runs.length>0&&<OpsPanel title="What the automation decided" description="Every invoice sent in, and why it was or wasn't funded." action={<a className="oc-link" href="/ops/funding">Funding Center →</a>}><div className={styles.feed}>{activity.runs.filter(run=>run.state!=='CLOSED').slice(0,8).map(run=><Decision key={run.id} run={run}/>)}</div></OpsPanel>}
        {(!funding?.available||!ready.length)&&<Paperwork rows={factorRows} data={reviews}/>}
        <OpsPanel title="Funding queue" description="Approved invoices first. Review the decision before moving money." action={<a className="oc-link" href="/ops/funding">All funding →</a>}>
          {!funding?.available?<OpsEmpty><strong>Funding automation unavailable</strong><p>{funding?.note||'Could not load the funding engine.'}</p></OpsEmpty>:!ready.length?<OpsEmpty>No approved invoices are waiting for a funding decision.</OpsEmpty>:<div className="oc-table-wrap"><table className="oc-table"><thead><tr><th>Invoice / client</th><th>Decision & next step</th><th className="num">Invoice value</th><th>Action</th></tr></thead><tbody>{ready.slice(0,5).map(run=><tr key={run.id}><td className="oc-identity"><strong>{run.invoiceNumber||run.factorCloudInvoiceId.slice(0,8)}</strong><small>{run.clientName||'Client not named'}</small></td><td><OpsStatus tone="info">{runLabel(run)}</OpsStatus><div className="oc-reason">{run.reasons[0]||run.detail||'Funding requires a person.'}</div></td><td className="num"><strong>{opsMoney(run.amount)}</strong></td><td><a className="oc-button" href={'/ops/funding?run='+encodeURIComponent(run.id)}>Review funding</a></td></tr>)}</tbody></table></div>}
        </OpsPanel>
        {funding?.available&&ready.length>0&&<Paperwork rows={factorRows} data={reviews}/>}
      </div><aside className="oc-stack">
        <OpsPanel title="Automation control"><div className="oc-body"><h3><OpsIcon name="rules"/> {funding?.available?modeLabels[funding.mode]:'Unavailable'}</h3><p className="oc-small oc-muted">{funding?.available?(funding.mode==='approve'?'Approvals automated. Funding requires a person.':funding.mode==='fund'?'Approval and funding may run within configured rules and caps.':funding.mode==='suggest'?'Suggestions only. People control the financial steps.':'The engine is off.'):funding?.note||'Engine data could not be read.'}</p><dl className="oc-facts"><div><dt>Approval gate</dt><dd>{!funding?.available?'Unavailable':funding.mode==='approve'||funding.mode==='fund'?'Automatic':'Human decision'}</dd></div><div><dt>Funding gate</dt><dd>{!funding?.available?'Unavailable':funding.mode==='fund'?'Automatic within limits':'Human decision'}</dd></div><div><dt>Approval failures</dt><dd>{summary?.failed??'—'}</dd></div><div><dt>Clients with their own rules</dt><dd><a className="oc-link" href="/ops/rules?tab=clients">Set per client →</a></dd></div></dl><p><a className="oc-link" href="/ops/rules">View automation rules →</a></p></div></OpsPanel>
      </aside></div><div className="oc-toolbar" style={{marginTop:16}}><span className="oc-note">Amounts are invoice value.</span><a className="oc-link" href="/ops/reports">Portfolio reports →</a></div>
    </>}
  </section></main>;
}
function Paperwork({rows,data}:{rows:ReviewData['records'];data:ReviewData|null}) {return <OpsPanel title="Paperwork review" description="Oldest work with the factor first." action={<a className="oc-link" href="/ops/reviews">All exceptions →</a>}>{!data?<OpsEmpty>Review data unavailable.</OpsEmpty>:!rows.length?<OpsEmpty>No paperwork exceptions currently require the factor.</OpsEmpty>:<div className="oc-table-wrap"><table className="oc-table"><thead><tr><th>Invoice / client</th><th>Exception</th><th>Next actor</th><th>Waiting</th></tr></thead><tbody>{rows.slice(0,4).map(row=><tr key={row.reviewId||row.id}><td className="oc-identity"><a className="oc-link" href={'/ops/reviews?review='+encodeURIComponent(row.reviewId||row.id)}>{row.invoiceNumber||row.id.slice(0,8)}</a><small>{row.companyClientId?data.clientNames[row.companyClientId]||'Client not named':'Client not named'}</small></td><td>{row.reason||'Paperwork requires review'}</td><td>Factor operations</td><td>{waitLabel(row.createdAt)}</td></tr>)}</tbody></table></div>}</OpsPanel>;}

const kind=(run:EngineRun)=>run.state==='FUNDED'?'funded':run.state==='REVIEW'?'review':run.state==='FAILED'||run.state==='FUNDING'?'problem':'held';
const lane:Record<string,string>={funded:'funded',held:'decision',review:'review',problem:'exceptions'};
function AutomationToday({data}:{data:FundingData}) {
  const t=data.summary!.today!,parts=[{key:'funded',label:'Funded automatically',n:t.autoFunded,href:'/ops/funding?lane=funded'},{key:'held',label:'Waiting for one click',n:t.held,href:'/ops/funding?lane=decision'},{key:'review',label:'Paperwork needs a person',n:t.review,href:'/ops/reviews'},{key:'problem',label:'Needs attention',n:t.problems,href:'/ops/funding?lane=exceptions'}];
  const speed=t.secondsToFund==null?null:t.secondsToFund<90?Math.max(1,Math.round(t.secondsToFund))+' seconds':Math.round(t.secondsToFund/60)+' minutes';
  return <section className={styles.hero} aria-label="Automation today"><div><span className={styles.eyebrow}><i className={styles.live} aria-hidden="true"/>Automation today · {modeLabels[data.mode]}</span>
    <p className={styles.headline}>{t.received?<><em>{t.autoFunded} of {t.received}</em> invoices funded with no one touching them</>:'No invoices sent in yet today'}</p>
    <p className={styles.sub}>{t.autoFunded>0&&<><strong>{opsMoney(t.autoAmount)}</strong> funded automatically{speed&&<>, on average <strong>{speed}</strong> after the client sent it</>}. </>}The rest are waiting for you below, each with the reason.</p></div>
    <div><div className={styles.bar} role="img" aria-label={parts.map(p=>p.n+' '+p.label.toLowerCase()).join(', ')}>{parts.filter(p=>p.n>0).map(p=><span key={p.key} className={styles[p.key]} style={{flexGrow:p.n}}/>)}</div>
      <div className={styles.legend}>{parts.map(p=><a key={p.key} href={p.href}><i className={styles[p.key]} aria-hidden="true"/><span>{p.label}</span><b>{p.n}</b></a>)}</div></div></section>;
}
function Decision({run}:{run:EngineRun}) {
  const k=kind(run),mark={funded:'✓',held:'!',review:'?',problem:'×'}[k];
  const what=run.state==='FUNDED'?(run.autoFunded?'Funded automatically':'Funded'):run.state==='APPROVED'?'Approved, waiting to fund':run.state==='SUGGESTED'?(run.mode==='fund'?'Held for one click':'Suggested for approval'):run.state==='REVIEW'?'Sent to paperwork review':run.state==='FAILED'?"Couldn't be approved":runLabel(run);
  const why=run.state==='FUNDED'&&run.autoFunded?'Every rule and limit passed.':run.reasons[0]||run.detail||'';
  return <a className={styles.item} href={k==='review'?'/ops/reviews':'/ops/funding?lane='+(run.state==='SUGGESTED'&&run.mode!=='fund'?'suggestions':lane[k])+'&run='+encodeURIComponent(run.id)}><span className={styles.icon+' '+styles[k]} aria-hidden="true">{mark}</span><span className={styles.what}><strong>{run.invoiceNumber||run.factorCloudInvoiceId.slice(0,8)}</strong> · {what}<span className={styles.why}>{run.clientName||'Client'}{run.debtorName?' → '+run.debtorName:''}{why?' · '+why:''}</span></span><span className={styles.meta}><b>{opsMoney(run.amount)}</b>{opsTime(run.fundedAt||run.createdAt)}</span></a>;
}
