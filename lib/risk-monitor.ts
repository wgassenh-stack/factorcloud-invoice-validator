import {buildAging, buildExposure, lifecycleStage, openBalance, openArBalance, isClosedOut} from './analytics';
import {buildDebtorSummaries} from './debtors';
import {settingsForClient, type RuleSettings} from './rules/settings';
import type {EngineRun} from './funding-engine';
import type {RiskInvoiceRecord} from './risk';

export type RiskKind = 'volume' | 'concentration' | 'credit' | 'payment';
export type RiskLevel = 'High' | 'Medium' | 'Unknown';
export interface RiskSignal {
  id: string; kind: RiskKind; level: RiskLevel; name: string; scope: string;
  trigger: string; current: string; threshold: string; exposure: number | null;
  exposureLabel: string; comparison: string | null; observedAt: string | null;
  basis: string; nextAction: string; evidence: {label:string; value:string}[];
  links: {label:string; href:string}[]; daily?: number[];
}
const DAY = 86400000;
const money = (n:number) => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
const pct = (n:number) => (n*100).toFixed(1)+'%';
const day = (s:string|null|undefined) => s ? Date.parse(s.slice(0,10)+'T00:00:00Z') : NaN;
export const WATCH_POLICY = {volumeRatio:1.5, volumeHighRatio:3, concentrationReview:.15, concentrationHigh:.25, paymentDays:55, minimumPaid:2, minimumBaseline:8};

/** Read-only signals. Invoice dates, current balances, and recorded decisions are distinct evidence. */
export function buildRiskMonitor(records:RiskInvoiceRecord[], today:string, names:{clients:Record<string,string>;debtors:Record<string,string>}, settings:RuleSettings|null, runs:EngineRun[]|null) {
  const now=day(today), signals:RiskSignal[]=[];
  const clientName=(id:string)=>names.clients[id]||records.find(r=>r.companyClientId===id)?.companyClientName||id;
  const debtorName=(id:string)=>names.debtors[id]||records.find(r=>r.companyDebtorId===id)?.companyDebtorName||id;
  const active=records.filter(r=>!isClosedOut(r));
  const funded=active.filter(r=>lifecycleStage(r)==='FUNDED');
  const exposure=buildExposure(records,names.debtors,'debtor', {review:WATCH_POLICY.concentrationReview,high:WATCH_POLICY.concentrationHigh});
  const clients=new Map<string,RiskInvoiceRecord[]>();
  for(const r of active) if(r.companyClientId) clients.set(r.companyClientId,[...(clients.get(r.companyClientId)||[]),r]);
  const dates=Array.from({length:35},(_,i)=>new Date(now-(34-i)*DAY).toISOString().slice(0,10));
  const daily=dates.map(date=>({date,count:active.filter(r=>r.invoiceDate?.slice(0,10)===date).length}));
  const baselineDaily=daily.slice(0,28).reduce((s,d)=>s+d.count,0)/28;
  let insufficientClients=0;
  for(const [id,rows] of clients) {
    const recent=rows.filter(r=>{const age=(now-day(r.invoiceDate))/DAY;return age>=0&&age<=6;});
    const prior=rows.filter(r=>{const age=(now-day(r.invoiceDate))/DAY;return age>=7&&age<=34;});
    const distinct=new Set(prior.map(r=>r.invoiceDate));
    if(prior.length<WATCH_POLICY.minimumBaseline||distinct.size<4) {insufficientClients++;continue;}
    const normal=prior.length/4, ratio=recent.length/normal;
    if(ratio>=WATCH_POLICY.volumeRatio) signals.push({
      id:'volume:'+id,kind:'volume',level:ratio>=WATCH_POLICY.volumeHighRatio?'High':'Medium',name:clientName(id),scope:'Client · invoice-date volume',
      trigger:recent.length+' invoices in 7 days vs '+normal.toFixed(1)+' per week in the prior 28 days.',current:recent.length+' invoices',threshold:'Watch ≥1.5× baseline; high ≥3×',
      exposure:rows.filter(r=>lifecycleStage(r)==='FUNDED').reduce((s,r)=>s+openBalance(r),0),exposureLabel:'Current open funded A/R',comparison:ratio.toFixed(1)+'× prior weekly pace',observedAt:null,
      basis:'Count by invoice date; prior 28 days exclude the current 7 days. Minimum 8 baseline invoices on 4 distinct dates. Watch thresholds are separate from funding rules.',
      nextAction:'Review the invoice mix and source documents with the client before interpreting the increased pace.',evidence:[{label:'Prior 28-day count',value:String(prior.length)},{label:'Current 7-day invoice value',value:money(recent.reduce((s,r)=>s+(r.invoiceAmount||0),0))}],
      links:[{label:'Open client',href:'/ops/clients/'+encodeURIComponent(id)}],daily:dates.slice(-7).map(date=>recent.filter(r=>r.invoiceDate?.slice(0,10)===date).length)
    });
  }
  for(const d of exposure.filter(d=>d.share>=WATCH_POLICY.concentrationReview)) signals.push({
    id:'portfolio:'+d.id,kind:'concentration',level:d.share>=WATCH_POLICY.concentrationHigh?'High':'Medium',name:debtorName(d.id),scope:'Debtor · portfolio funded exposure',trigger:pct(d.share)+' of portfolio open funded A/R is with this debtor.',current:pct(d.share),threshold:'Watch ≥15%; high ≥25%',exposure:d.value,exposureLabel:'Current open funded A/R',comparison:null,observedAt:null,
    basis:'Denominator: all open funded A/R in the loaded portfolio. This portfolio watch threshold is separate from client-specific funding concentration limits.',nextAction:'Review the debtor and the clients contributing to this exposure.',evidence:[{label:'Open funded invoices',value:String(d.invoiceCount)}],links:[{label:'Open debtor',href:'/ops/debtors?debtor='+encodeURIComponent(d.id)}]
  });
  if(settings) for(const [clientId,rows] of clients) {
    const cfg=settingsForClient(settings,clientId).rules.concentration;
    if(!cfg.enabled) continue;
    const total=rows.reduce((s,r)=>s+openArBalance(r),0);
    if(total<=0)continue;
    const pairs=new Map<string,number>();
    for(const r of rows) if(r.companyDebtorId) pairs.set(r.companyDebtorId,(pairs.get(r.companyDebtorId)||0)+openArBalance(r));
    for(const [debtorId,amount] of pairs) if(amount/total*100>cfg.maxPct) signals.push({
      id:'relationship:'+clientId+':'+debtorId,kind:'concentration',level:'High',name:clientName(clientId)+' → '+debtorName(debtorId),scope:'Client / debtor · approved and funded A/R',trigger:pct(amount/total)+' of this client’s open A/R exceeds the '+cfg.maxPct+'% configured concentration limit.',current:pct(amount/total),threshold:cfg.maxPct+'% · '+(settings.clientOverrides[clientId]?'client override':'factor default'),exposure:amount,exposureLabel:'Approved and funded open A/R',comparison:null,observedAt:null,
      basis:'Current approved and funded balances, matching the funding rule’s A/R basis. This view does not include a hypothetical next invoice or reevaluate a financial action.',nextAction:'Review this relationship and its applicable concentration rule.',evidence:[{label:'Client open A/R denominator',value:money(total)},{label:'Rule enabled',value:'Yes'}],links:[{label:'Open client',href:'/ops/clients/'+encodeURIComponent(clientId)},{label:'Open debtor',href:'/ops/debtors?debtor='+encodeURIComponent(debtorId)},{label:'Automation Rules',href:'/ops/rules'}]
    });
  }
  for(const d of buildDebtorSummaries(records,today,names)) {
    const aged=d.buckets[3]>0, slow=d.paidCount>=WATCH_POLICY.minimumPaid&&d.daysToPay!=null&&d.daysToPay>WATCH_POLICY.paymentDays;
    if(!aged&&!slow)continue;
    const reasons=[aged?money(d.buckets[3])+' of open funded balance is aged over 90 days.':'',slow?d.daysToPay!.toFixed(1)+' average days to pay across '+d.paidCount+' paid invoices.':''].filter(Boolean);
    signals.push({id:'payment:'+d.debtorId,kind:'payment',level:aged?'High':'Medium',name:d.name,scope:'Debtor · payment and invoice age',trigger:reasons.join(' '),current:aged?pct(d.openBalance?d.buckets[3]/d.openBalance:0)+' aged 90+':d.daysToPay!.toFixed(1)+' days',threshold:aged?'Any balance aged >90 days':'Avg >55 days; at least 2 paid invoices',exposure:d.openBalance,exposureLabel:'Current open funded A/R',comparison:null,observedAt: null,
      basis:'Aging is days from invoice date. Average payment time is amount-weighted over the last 180 days’ paid cohort; it does not establish deterioration over time.',nextAction:'Review the debtor’s aging, disputed invoices, and collection status.',evidence:[{label:'90+ invoice-age balance',value:money(d.buckets[3])},{label:'Average days to pay',value:d.daysToPay==null?'Unavailable':d.daysToPay.toFixed(1)+' days'},{label:'Paid cohort size',value:String(d.paidCount)},{label:'Disputed open invoices',value:String(d.disputedCount)}],links:[{label:'Open debtor',href:'/ops/debtors?debtor='+encodeURIComponent(d.debtorId)}]
    });
  }
  const latest=new Map<string,EngineRun>();
  for(const run of runs||[]) if(!latest.has(run.factorCloudInvoiceId)) latest.set(run.factorCloudInvoiceId,run);
  for(const run of latest.values()) {
    if(run.state==='FUNDED')continue;
    const holds=run.rules.filter(r=>['credit-limit','client-credit','cash-reserve'].includes(r.id)&&['HOLD','UNKNOWN'].includes(r.status));
    if(!holds.length)continue;
    const unknown=holds.every(r=>r.status==='UNKNOWN');
    signals.push({id:'credit:'+run.id,kind:'credit',level:unknown?'Unknown':'High',name:(run.clientName||clientName(run.factorCloudClientId))+' · '+(run.invoiceNumber||run.factorCloudInvoiceId),scope:'Invoice decision · recorded credit / reserve checks',trigger:holds.map(r=>r.detail).join(' '),current:unknown?'Check unavailable':'Funding held',threshold:'Recorded rule results',exposure:null,exposureLabel:'Relationship exposure not supplied',comparison:null,observedAt:run.createdAt,
      basis:'Saved decision evidence from the latest loaded unresolved run for this invoice. It is not a fresh credit-limit or reserve check.',nextAction:'Review the recorded funding decision and verify current credit or reserve information in FactorCloud.',evidence:[{label:'Invoice face value',value:money(run.amount)},...holds.map(r=>({label:r.label+' · '+r.status,value:r.detail}))],links:[{label:'Review funding decision',href:'/ops/funding?run='+encodeURIComponent(run.id)},{label:'Open client',href:'/ops/clients/'+encodeURIComponent(run.factorCloudClientId)}]
    });
  }
  const priority:Record<RiskLevel,number>={High:0,Medium:1,Unknown:2};
  signals.sort((a,b)=>priority[a.level]-priority[b.level]||(b.exposure||0)-(a.exposure||0)||a.name.localeCompare(b.name));
  return {signals,daily,baselineDaily,exposure:exposure.slice(0,5),aging:buildAging(records,names.debtors,today,'debtor').totals,openFunded:funded.reduce((s,r)=>s+openBalance(r),0),insufficientClients,
    coverage:{records:records.length,missingInvoiceDate:records.filter(r=>!Number.isFinite(day(r.invoiceDate))).length,assumedBalances:funded.filter(r=>r.invoiceBalance==null).length,missingDebtor:funded.filter(r=>!r.companyDebtorId).length},policy:WATCH_POLICY};
}

export function riskCsv(signals:RiskSignal[]):string {
  const cell=(value:unknown)=>{let s=String(value??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
  const rows=[['Severity','Type','Relationship','Scope','Trigger','Current','Threshold','Exposure','Exposure basis','Comparison','Recorded at'],...signals.map(s=>[s.level,s.kind,s.name,s.scope,s.trigger,s.current,s.threshold,s.exposure,s.exposureLabel,s.comparison,s.observedAt])];
  return rows.map(row=>row.map(cell).join(',')).join('\r\n');
}
