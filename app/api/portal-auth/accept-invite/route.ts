import {NextResponse} from 'next/server';
import {createHash,randomUUID} from 'crypto';
import {hash} from 'bcryptjs';
import {pool} from '@/lib/db';
import {databaseAuthEnabled} from '@/lib/session';
import {apiErrorResponse} from '@/lib/api-errors';
export async function POST(req:Request){
  if(!databaseAuthEnabled())return NextResponse.json({error:'Database sign-in is required.'},{status:404});
  try{const b=await req.json();if(typeof b.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(b.token)||typeof b.password!=='string'||b.password.length<12||Buffer.byteLength(b.password)>72||typeof b.name!=='string'||!b.name.trim()||b.name.length>100)return NextResponse.json({error:'Use your invitation, a name, and a password of at least 12 characters (at most 72 bytes).'},{status:400});
    const db=await pool().connect();try{await db.query('begin');const {rows:[invite]}=await db.query(`select i.* from driver_invites i join portal_clients c on c.id=i.client_id and c.factor_id=i.factor_id where token_hash=$1 and accepted_at is null and expires_at>now() and c.is_active for update of i`,[createHash('sha256').update(b.token).digest('hex')]);if(!invite){await db.query('rollback');return NextResponse.json({error:'This invitation expired or was already used.'},{status:410});}
      const id=`user_${randomUUID()}`;await db.query("insert into portal_users(id,factor_id,email,display_name,role,password_hash) values($1,$2,$3,$4,'DRIVER',$5)",[id,invite.factor_id,invite.email,b.name.trim(),await hash(b.password,12)]);await db.query('insert into user_client_access(user_id,client_id) values($1,$2)',[id,invite.client_id]);await db.query('update driver_invites set accepted_at=now() where factor_id=$1 and email=$2 and accepted_at is null',[invite.factor_id,invite.email]);await db.query('commit');return NextResponse.json({ok:true});
    }catch(e){await db.query('rollback');throw e;}finally{db.release();}
  }catch(e){return apiErrorResponse(e,'accept-invite');}
}
