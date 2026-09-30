import {NextResponse} from 'next/server';
import {apiErrorResponse} from '@/lib/api-errors';
import {requireFactorSession} from '@/lib/portal-auth';
import {demoRequest} from '@/lib/demo-request';
import {databaseAuthEnabled} from '@/lib/session';
import {listInvoices,getCompany} from '@/lib/factorcloud';
import {collectRiskInvoiceRecords} from '@/lib/risk';
import {buildRiskMonitor} from '@/lib/risk-monitor';
import {loadSettings,listRuns} from '@/lib/funding-engine';
import {demoFundingData,demoFundingSettings} from '@/lib/demo-funding';

export const runtime='nodejs';
export const maxDuration=120;

/** Portfolio risk is read-only; saved engine checks are identified as recorded evidence. */
export async function GET() {
  try {
    const session=await requireFactorSession(),demo=await demoRequest();
    const [invoiceResult,engineResult]=await Promise.allSettled([
      listInvoices(),
      demo?Promise.resolve({settings:demoFundingSettings(),runs:demoFundingData(null).runs}):databaseAuthEnabled()?Promise.all([loadSettings(session.factorId),listRuns(session.factorId,{states:['APPROVED','SUGGESTED','FAILED','REVIEW','FUNDING'],limit:500})]).then(([settings,runs])=>({settings,runs})):Promise.reject(new Error('Funding evidence requires database sign-in.'))
    ]);
    if(invoiceResult.status==='rejected')throw invoiceResult.reason;
    const list=invoiceResult.value,records=collectRiskInvoiceRecords(list.raw);
    const ids=[...new Set(records.flatMap(r=>[r.companyClientId,r.companyDebtorId]).filter((id):id is string=>Boolean(id)))];
    const entries=await Promise.all(ids.slice(0,150).map(async id=>{try{const c=await getCompany(id);return [id,c.companyName||c.compCode||id] as const;}catch{return [id,id] as const;}}));
    const names=Object.fromEntries(entries),today=new Date().toISOString().slice(0,10);
    const engine=engineResult.status==='fulfilled'?engineResult.value:null;
    return NextResponse.json({...buildRiskMonitor(records,today,{clients:names,debtors:names},engine?.settings||null,engine?.runs||null),today,fetchedAt:new Date().toISOString(),demo,
      source:{complete:list.complete,incompleteReason:list.incompleteReason||null,engineAvailable:Boolean(engine),engineLimited:Boolean(engine&&engine.runs.length>=500),namesLimited:ids.length>150,creditCoverage:'Recorded checks on unresolved invoice decisions; current credit headroom and reserve balances are not queried.'}});
  }catch(err){return apiErrorResponse(err,'ops-risk',502);}
}
