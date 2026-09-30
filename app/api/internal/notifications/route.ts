import {timingSafeEqual} from 'crypto';
import {NextResponse} from 'next/server';
import {processNotifications} from '@/lib/notifications';
import {databaseAuthEnabled} from '@/lib/session';
import {query} from '@/lib/db';
export const runtime='nodejs';
export const maxDuration=60;
export async function POST(req:Request){
  const secret=process.env.NOTIFICATION_WORKER_SECRET;
  const actual=Buffer.from(req.headers.get('authorization')??''),expected=Buffer.from(`Bearer ${secret}`);
  if(!secret||actual.length!==expected.length||!timingSafeEqual(actual,expected)||!databaseAuthEnabled())return NextResponse.json({error:'Unauthorized'},{status:401});
  const [factor]=await query<{id:string}>('select id from factors where factorcloud_factor_id=$1',[process.env.FACTORCLOUD_FACTOR_ID]);
  if(!factor)return NextResponse.json({error:'Factor not configured'},{status:503});
  return NextResponse.json(await processNotifications(factor.id));
}
