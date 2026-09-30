import {NextResponse} from 'next/server';
import {randomBytes,createHash,randomUUID} from 'crypto';
import {requireFactorSession} from '@/lib/portal-auth';
import {databaseAuthEnabled} from '@/lib/session';
import {demoRequest} from '@/lib/demo-request';
import {query} from '@/lib/db';
import {apiErrorResponse} from '@/lib/api-errors';
import {queueInvitation} from '@/lib/notifications';
export async function GET(){try{const s=await requireFactorSession();if(await demoRequest()||!databaseAuthEnabled())return NextResponse.json({drivers:[],clients:[],editable:false});
  const [drivers,clients]=await Promise.all([query("select u.id,u.email,u.display_name,u.is_active,c.name as client from portal_users u join user_client_access a on a.user_id=u.id join portal_clients c on c.id=a.client_id where u.factor_id=$1 and u.role='DRIVER' order by u.email",[s.factorId]),query('select id,name from portal_clients where factor_id=$1 and is_active order by name',[s.factorId])]);return NextResponse.json({drivers,clients,editable:s.role==='FACTOR_ADMIN'});
}catch(e){return apiErrorResponse(e,'team');}}
export async function POST(req:Request){try{const s=await requireFactorSession();if(s.role!=='FACTOR_ADMIN'||await demoRequest()||!databaseAuthEnabled())return NextResponse.json({error:'Database admin required.'},{status:403});const b=await req.json();
  const email=typeof b.email==='string'?b.email.trim().toLowerCase():'';
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||typeof b.clientId!=='string')return NextResponse.json({error:'Provide an email and client.'},{status:400});
  if(!(await query('select id from portal_clients where id=$1 and factor_id=$2 and is_active',[b.clientId,s.factorId])).length)return NextResponse.json({error:'Client not found.'},{status:404});
  if((await query('select id from portal_users where factor_id=$1 and lower(email)=$2',[s.factorId,email])).length)return NextResponse.json({error:'An account already exists for this email.'},{status:409});
  const base=process.env.PORTAL_PUBLIC_URL;
  if(!base || new URL(base).protocol!=='https:')return NextResponse.json({error:'Set PORTAL_PUBLIC_URL to the HTTPS portal URL first.'},{status:503});
  const token=randomBytes(32).toString('base64url'),hash=createHash('sha256').update(token).digest('hex');
  await query("insert into driver_invites(token_hash,factor_id,client_id,email,created_by,expires_at) values($1,$2,$3,$4,$5,now()+interval '48 hours')",[hash,s.factorId,b.clientId,email,s.userId]);
  const url=new URL('/invite',base);url.hash=token;
  await queueInvitation(s.factorId,email,url.toString(),`invite:${hash}`);
  await query(`insert into audit_events(id,factor_id,actor_user_id,event_type,event_data) values($1,$2,$3,'DRIVER_INVITED',$4::jsonb)`,[`audit_${randomUUID()}`,s.factorId,s.userId,JSON.stringify({email,clientId:b.clientId})]);
  return NextResponse.json({ok:true,invitationUrl:url.toString(),note:'Queued. Email delivery requires a configured sender; you can also share this link yourself.'});
}catch(e){return apiErrorResponse(e,'team');}}
export async function PATCH(req:Request){try{const s=await requireFactorSession();if(s.role!=='FACTOR_ADMIN'||await demoRequest()||!databaseAuthEnabled())return NextResponse.json({error:'Database admin required.'},{status:403});const b=await req.json();if(typeof b.active!=='boolean'||typeof b.id!=='string')return NextResponse.json({error:'Invalid account update.'},{status:400});const rows=await query("update portal_users set is_active=$3,updated_at=now() where id=$1 and factor_id=$2 and role='DRIVER' returning id",[b.id,s.factorId,b.active]);return NextResponse.json({ok:rows.length>0});}catch(e){return apiErrorResponse(e,'team');}}
