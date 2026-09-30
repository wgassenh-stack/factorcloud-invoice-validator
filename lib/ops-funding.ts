import 'server-only';
import {query} from './db';
export async function fundingSummary(factorId:string) {
  const timeZone=process.env.FACTOR_TIMEZONE||'America/Chicago';
  const [row]=await query<Record<string,string|number>>(
    "select count(*) filter(where state='APPROVED') as approved, coalesce(sum(amount) filter(where state='APPROVED'),0) as approved_amount, count(*) filter(where state='SUGGESTED') as suggested, count(*) filter(where state='FAILED') as failed, count(*) filter(where state='FUNDING') as uncertain, count(*) filter(where state='FUNDED') as funded, count(*) filter(where state='REVIEW') as review, count(*) filter(where state='FUNDED' and auto_funded and (funded_at at time zone $2)::date=(now() at time zone $2)::date) as auto_today, coalesce(sum(amount) filter(where state='FUNDED' and auto_funded and (funded_at at time zone $2)::date=(now() at time zone $2)::date),0) as auto_today_amount from engine_runs where factor_id=$1",
    [factorId,timeZone]);
  return {approved:Number(row.approved),approvedAmount:Number(row.approved_amount),suggested:Number(row.suggested),failed:Number(row.failed),uncertain:Number(row.uncertain),funded:Number(row.funded),review:Number(row.review),autoToday:Number(row.auto_today),autoTodayAmount:Number(row.auto_today_amount),timeZone};
}
