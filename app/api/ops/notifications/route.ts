import {NextResponse} from 'next/server';
import {requireFactorSession} from '@/lib/portal-auth';
import {databaseAuthEnabled} from '@/lib/session';
import {demoRequest} from '@/lib/demo-request';
import {apiErrorResponse} from '@/lib/api-errors';
import {query} from '@/lib/db';
import {processNotifications} from '@/lib/notifications';
export async function GET(){try{const s=await requireFactorSession();if(await demoRequest()||!databaseAuthEnabled())return NextResponse.json({items:[]});return NextResponse.json({items:await query('select id,recipient,subject,status,last_error,created_at,sent_at from notification_outbox where factor_id=$1 order by created_at desc limit 100',[s.factorId])});}catch(e){return apiErrorResponse(e,'notifications');}}
// Explicit operator action. A scheduler can instead invoke scripts/notification-worker.mjs.
export async function POST(){try{const s=await requireFactorSession();if(s.role!=='FACTOR_ADMIN'||await demoRequest()||!databaseAuthEnabled())return NextResponse.json({error:'Database admin required.'},{status:403});
  // Delivery processes this deployment's outbox. Each deployment is configured for one factor.
  return NextResponse.json(await processNotifications(s.factorId));}catch(e){return apiErrorResponse(e,'notifications');}}
