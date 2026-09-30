import 'server-only';
import {query} from './db';
export async function fundingSummary(factorId:string) {
  const timeZone=process.env.FACTOR_TIMEZONE||'America/Chicago';
  const [row]=await query<Record<string,string|number>>(
    "select count(*) filter(where state='APPROVED') as approved, coalesce(sum(amount) filter(where state='APPROVED'),0) as approved_amount, count(*) filter(where state='SUGGESTED') as suggested, count(*) filter(where state='FAILED') as failed, count(*) filter(where state='FUNDING') as uncertain, count(*) filter(where state='FUNDED') as funded, count(*) filter(where state='REVIEW') as review, count(*) filter(where state='FUNDED' and auto_funded and (funded_at at time zone $2)::date=(now() at time zone $2)::date) as auto_today, coalesce(sum(amount) filter(where state='FUNDED' and auto_funded and (funded_at at time zone $2)::date=(now() at time zone $2)::date),0) as auto_today_amount from engine_runs where factor_id=$1",
    [factorId,timeZone]);
  const [day]=await query<Record<string,string|number|null>>(
    "select count(*) as received, count(*) filter(where state='FUNDED' and auto_funded) as auto_funded, coalesce(sum(amount) filter(where state='FUNDED' and auto_funded),0) as auto_amount, count(*) filter(where state in ('APPROVED','SUGGESTED')) as held, count(*) filter(where state='REVIEW') as review, count(*) filter(where state in ('FAILED','FUNDING')) as problems, avg(extract(epoch from funded_at-created_at)) filter(where state='FUNDED' and auto_funded) as seconds_to_fund from engine_runs where factor_id=$1 and (created_at at time zone $2)::date=(now() at time zone $2)::date",
    [factorId,timeZone]);
  const today={received:Number(day?.received??0),autoFunded:Number(day?.auto_funded??0),autoAmount:Number(day?.auto_amount??0),held:Number(day?.held??0),review:Number(day?.review??0),problems:Number(day?.problems??0),secondsToFund:day?.seconds_to_fund==null?null:Number(day.seconds_to_fund)};
  return {today,approved:Number(row.approved),approvedAmount:Number(row.approved_amount),suggested:Number(row.suggested),failed:Number(row.failed),uncertain:Number(row.uncertain),funded:Number(row.funded),review:Number(row.review),autoToday:Number(row.auto_today),autoTodayAmount:Number(row.auto_today_amount),timeZone};
}
