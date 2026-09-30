import {describe,it,expect} from 'vitest';
import {buildRiskMonitor,riskCsv} from './risk-monitor';
import {normalizeSettings,overrideFrom} from './rules/settings';
import type {RiskInvoiceRecord} from './risk';
import type {EngineRun} from './funding-engine';
const names={clients:{c:'Client'},debtors:{a:'Acme',b:'Beta'}};
const record=(id:string,patch:Partial<RiskInvoiceRecord>={}):RiskInvoiceRecord=>({id,invoiceNumber:id,companyClientId:'c',companyDebtorId:'a',invoiceAmount:100,invoiceDate:'2026-09-29',status:'PENDING',...patch});
const build=(records:RiskInvoiceRecord[],settings:ReturnType<typeof normalizeSettings>|null=null,runs:EngineRun[]|null=null)=>buildRiskMonitor(records,'2026-09-30',names,settings,runs);
describe('Risk Monitor evidence',()=>{
  it('keeps funded portfolio share separate from approved and funded client concentration and uses overrides',()=>{
    const settings=normalizeSettings({});settings.clientOverrides.c=overrideFrom(settings,'Client');settings.clientOverrides.c.rules.concentration.maxPct=70;
    const result=build([record('funded',{status:'FUNDED',invoiceBalance:100}),record('approved',{status:'APPROVED',companyDebtorId:'b',invoiceBalance:900}),record('pending',{invoiceAmount:99999})],settings);
    expect(result.signals.find(s=>s.id==='portfolio:a')?.current).toBe('100.0%');
    expect(result.signals.find(s=>s.id==='relationship:c:b')).toMatchObject({current:'90.0%',threshold:'70% · client override',exposure:900});
    expect(result.signals.some(s=>s.id==='relationship:c:a')).toBe(false);
  });
  it('does not treat a disabled concentration rule as a configured breach',()=>{
    const s=normalizeSettings({});s.rules.concentration.enabled=false;
    const out=build([record('f',{status:'FUNDED'})],s);
    expect(out.signals.some(x=>x.id.startsWith('relationship:'))).toBe(false);
    expect(out.signals.some(x=>x.id==='portfolio:a')).toBe(true);
  });
  it('requires baseline history and excludes the current seven days, future dates and closed invoices',()=>{
    const prior=Array.from({length:8},(_,i)=>record('p'+i,{invoiceDate:['2026-09-05','2026-09-10','2026-09-15','2026-09-20'][i%4]}));
    const recent=Array.from({length:6},(_,i)=>record('r'+i,{invoiceDate:'2026-09-30'}));
    const out=build([...prior,...recent,record('future',{invoiceDate:'2026-10-01'}),record('void',{status:'VOID',invoiceDate:'2026-09-30'})]);
    expect(out.signals.find(s=>s.kind==='volume')).toMatchObject({current:'6 invoices',comparison:'3.0× prior weekly pace',level:'High'});
    expect(out.baselineDaily).toBeCloseTo(8/28);
    expect(build([...prior.slice(0,3),...recent]).signals.some(s=>s.kind==='volume')).toBe(false);
  });
  it('never labels invoice-age balance as past-due or derives historical deterioration',()=>{
    const out=build([record('old',{status:'FUNDED',invoiceDate:'2026-06-01',invoiceBalance:70,dueDate:'2027-01-01'})]);
    const signal=out.signals.find(s=>s.kind==='payment');
    expect(signal).toMatchObject({current:'100.0% aged 90+',exposure:70,comparison:null});
    expect(signal?.basis).toContain('invoice date');
    expect(signal?.trigger).not.toContain('past due');
  });
  it('does not infer slow payment from a single paid invoice',()=>{
    const out=build([record('paid',{status:'PAID',invoiceDate:'2026-05-01',paidDate:'2026-09-01'})]);
    expect(out.signals.some(s=>s.kind==='payment')).toBe(false);
  });
  it('marks unavailable credit checks as unknown recorded evidence and excludes funded decisions',()=>{
    const r={id:'run',factorCloudInvoiceId:'i',factorCloudClientId:'c',clientName:'Client',invoiceNumber:'I-1',amount:100,state:'APPROVED',createdAt:'2026-09-01T10:00:00Z',rules:[{id:'credit-limit',label:'Credit',status:'UNKNOWN',detail:'Could not read the limit.'}]} as EngineRun;
    const signal=build([],null,[r]).signals[0];
    expect(signal).toMatchObject({kind:'credit',level:'Unknown',exposure:null,observedAt:r.createdAt});
    expect(signal.basis).toContain('not a fresh');
    expect(build([],null,[{...r,state:'FUNDED'}]).signals).toHaveLength(0);
  });
  it('reports missing balances, dates, and debtor identity rather than silently guaranteeing coverage',()=>{
    const out=build([record('f',{status:'FUNDED',invoiceDate:null,companyDebtorId:null})]);
    expect(out.coverage).toMatchObject({records:1,missingInvoiceDate:1,assumedBalances:1,missingDebtor:1});
    expect(out.aging.reduce((a,b)=>a+b,0)).toBe(0);
    expect(out.openFunded).toBe(100);
  });
  it('quotes exported evidence and neutralizes spreadsheet formulas from company names',()=>{
    const out=build([record('f',{status:'FUNDED',companyDebtorName:'=HYPERLINK("bad")'})]);
    const signals=out.signals.map(s=>({...s,name:'=HYPERLINK("bad")'}));
    const csv=riskCsv(signals);
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
    expect(csv).toContain('\r\n');
  });
});
