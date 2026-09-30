import type {EngineRun} from './funding-engine';
import type {EngineMode} from './rules/settings';
import type {CheckResult} from './types';
export type TodaySummary={received:number;autoFunded:number;autoAmount:number;held:number;review:number;problems:number;secondsToFund:number|null};
export type FundingSummary={today?:TodaySummary;approved:number;approvedAmount:number;suggested:number;failed:number;uncertain:number;funded:number;review:number;autoToday:number;autoTodayAmount:number;timeZone:string};
export type SyncInfo={checked:number;failed:number;total:number;changed:number;at:string;skipped?:boolean;error?:string};
export type AutomationInfo={paused:boolean;defaultMode:EngineMode;clients:Record<EngineMode,number>};
export type FundingData={automation?:AutomationInfo;sync?:SyncInfo;available:boolean;mode:EngineMode;runs:EngineRun[];summary?:FundingSummary;next?:{createdAt:string;id:string}|null;canAct:boolean;note?:string};
export type ReviewRecord={id:string;reviewId?:string;submissionId?:string;invoiceNumber:string|null;companyClientId:string|null;companyDebtorId:string|null;invoiceAmount:number|null;invoiceDate:string|null;status:string|null;reviewStatus?:string;reason?:string;notes?:string|null;createdAt?:string;checks?:CheckResult[];fix?:{status:'OPEN'|'DONE';message:string;requestedAt:string;answeredAt:string|null;responseNote:string|null;fileCount:number|null}|null};
export type ReviewData={sync?:SyncInfo;records:ReviewRecord[];clientNames:Record<string,string>;debtorNames:Record<string,string>;source?:{note:string};demo?:boolean};
export const modeLabels:Record<EngineMode,string>={off:'Off',suggest:'Suggest only',approve:'Auto-approve',fund:'Auto-fund'};
export function runLabel(run:EngineRun){if(run.state==='FUNDING')return 'Funding outcome unresolved';if(run.state==='FUNDED')return run.autoFunded?'Auto-funded':'Funded by a person';if(run.state==='APPROVED')return 'Approved · ready to fund';if(run.state==='FAILED')return 'Approval failed';if(run.state==='CLOSED')return 'Closed in FactorCloud';if(run.state==='REVIEW')return 'Approval blocked';return run.mode==='fund'?'Held for one click':'Suggestion';}
export function waitsOnClient(record:ReviewRecord){return record.fix?.status==='OPEN';}
export function oldestFirst(rows:ReviewRecord[]){return rows.slice().sort((a,b)=>Date.parse(a.createdAt||'9999-01-01')-Date.parse(b.createdAt||'9999-01-01'));}
export function waitLabel(date:string|undefined,now=Date.now()){if(!date||!Number.isFinite(Date.parse(date)))return '—';const hours=Math.max(0,(now-Date.parse(date))/3600000);return hours<1?Math.max(1,Math.floor(hours*60))+'m':hours<24?Math.floor(hours)+'h':Math.floor(hours/24)+'d '+Math.floor(hours%24)+'h';}
