import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
let cookie='';
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='fc_portal_session'&&cookie?{value:cookie}:undefined})}));
const enabled=Boolean(process.env.TEST_DATABASE_URL);
describe.skipIf(!enabled)('pilot workflows against PostgreSQL',()=>{
  let query:typeof import('./db').query,pool:typeof import('./db').pool;
  const saved={...process.env};
  const admin={v:1 as const,userId:'admin',factorId:'factor',email:'admin@test.invalid',displayName:'Admin',role:'FACTOR_ADMIN' as const,clients:[],exp:Date.now()+3600000};
  async function login(role:'FACTOR_ADMIN'|'DRIVER'='FACTOR_ADMIN',userId='admin'){
    const {signPortalSession}=await import('./session');cookie=await signPortalSession({...admin,userId,role,clients:role==='DRIVER'?[{id:'client',factorCloudClientId:'fc-client',name:'Client'}]:[]});
  }
  async function run(id:string,amount=600){await query(`insert into engine_runs(id,factor_id,client_id,factorcloud_invoice_id,factorcloud_client_id,invoice_number,amount,mode,outcome,state,rules,reasons,invoice_group_id,payment_type)
    values($1,'factor','client',$1,'fc-client',$1,$2,'fund','FUND','APPROVED','[]','[]',$1,'ACH')`,[id,amount]);}
  async function settings(){const {DEFAULT_SETTINGS}=await import('./rules/settings');const s=structuredClone(DEFAULT_SETTINGS);s.mode='fund';s.caps={...s.caps,perInvoice:1000,perClientPerDay:1000,perFactorPerDay:1000};return s;}
  async function submission(id='sub',owner='driver'){
    await query(`insert into submissions(id,factor_id,client_id,submitted_by_user_id,invoice_number_submitted,factorcloud_invoice_id,validation_status,idempotency_key) values($1,'factor','client',$2,$1,$1,'REVIEW',$1)`,[id,owner]);
  }
  beforeAll(async()=>{Object.assign(process.env,{DATABASE_URL:process.env.TEST_DATABASE_URL,PORTAL_AUTH_MODE:'database',AUTH_SESSION_SECRET:'test-secret',FACTORCLOUD_FACTOR_ID:'fc-factor',FACTORCLOUD_BEARER_TOKEN:'test-token',PORTAL_PUBLIC_URL:'https://portal.test',NEXT_PUBLIC_DEMO_TOGGLE:'false'});delete process.env.NEXT_PUBLIC_DEMO_MODE;({query,pool}=await import('./db'));});
  beforeEach(async()=>{
    await query('truncate factors cascade');
    await query("insert into factors(id,factorcloud_factor_id,name) values('factor','fc-factor','Factor'),('other','other-factor','Other')");
    await query("insert into portal_clients(id,factor_id,factorcloud_client_id,name) values('client','factor','fc-client','Client')");
    await query("insert into portal_users(id,factor_id,email,role) values('admin','factor','admin@test.invalid','FACTOR_ADMIN'),('driver','factor','driver@test.invalid','DRIVER'),('driver2','factor','driver2@test.invalid','DRIVER')");
    await query("insert into user_client_access values('driver','client'),('driver2','client')");
    await login();vi.unstubAllGlobals();process.env.NOTIFICATIONS_ENABLED='false';
  });
  afterAll(async()=>{await pool().end();process.env=saved;vi.unstubAllGlobals();});

  it('reserves one shared allowance across concurrent invoices',async()=>{
    await run('one');await run('two');const {claimFunding}=await import('./funding-safety');const s=await settings();
    const result=await Promise.all([claimFunding('one',true,s),claimFunding('two',true,s)]);
    expect(result.filter(Boolean)).toHaveLength(1);
    expect(Number((await query('select sum(amount) as total from funding_reservations'))[0].total)).toBe(600);
  });
  it('double clicks claim only one funding operation',async()=>{await run('one');const {claimFunding}=await import('./funding-safety');const s=await settings();expect((await Promise.all([claimFunding('one',true,s),claimFunding('one',true,s)])).filter(Boolean)).toHaveLength(1);});
  it('a stored policy change overrides stale automatic funding settings',async()=>{
    await run('one'); const stale=await settings();
    const {saveSettings}=await import('./funding-engine');
    await saveSettings('factor','admin',{...stale,mode:'off'});
    const {claimFunding}=await import('./funding-safety');
    expect(await claimFunding('one',true,stale)).toBe(false);
    expect(await query('select * from funding_reservations')).toHaveLength(0);
  });
  it('an unresolved reservation blocks automatic and manual retries even if the run was reset',async()=>{
    await run('one'); const {claimFunding,fundingReservationResult}=await import('./funding-safety');
    const s=await settings(); expect(await claimFunding('one',true,s)).toBe(true);
    await fundingReservationResult('one','UNKNOWN');
    await query("update engine_runs set state='APPROVED' where id='one'");
    expect(await claimFunding('one',true,s)).toBe(false);
    expect(await claimFunding('one',false,s)).toBe(false);
  });
  it('invalid invoice amounts cannot be claimed even manually',async()=>{
    await run('one',0); const {claimFunding}=await import('./funding-safety');
    expect(await claimFunding('one',false,await settings())).toBe(false);
  });
  it('a later failure preserves the known invoice and keeps its retry key blocked',async()=>{
    await submission(); const {markSubmissionFactorCloudResult}=await import('./submission-store');
    await markSubmissionFactorCloudResult({submission:{id:'sub',portalClientId:'client'},session:admin,validationStatus:'REVIEW',error:'late failure',retryable:true});
    const [row]=await query("select factorcloud_invoice_id,idempotency_key,idempotency_released_at from submissions where id='sub'");
    expect(row).toEqual({factorcloud_invoice_id:'sub',idempotency_key:'sub',idempotency_released_at:null});
    const [event]=await query("select event_data from audit_events where event_type='FACTORCLOUD_CREATE_FAILED'");
    expect(event.event_data).toMatchObject({invoiceId:'sub',retryAllowed:false});
  });
  it('result and audit roll back together when the actor is invalid',async()=>{
    await submission(); const {markSubmissionFactorCloudResult}=await import('./submission-store');
    await expect(markSubmissionFactorCloudResult({submission:{id:'sub',portalClientId:'client'},session:{...admin,userId:'missing'},validationStatus:'PASS'})).rejects.toThrow();
    expect((await query("select workflow_status from submissions where id='sub'"))[0].workflow_status).toBe('SUBMITTED');
  });
  it('an unresolved previous-day reservation still consumes allowance',async()=>{await run('one');await run('two');const {claimFunding,fundingReservationResult}=await import('./funding-safety');const s=await settings();await claimFunding('one',true,s);await fundingReservationResult('one','UNKNOWN');await query("update funding_reservations set business_day=current_date-1");expect(await claimFunding('two',true,s)).toBe(false);});
  it('a funding timeout blocks a second send and opens recovery',async()=>{
    await run('one');const {saveSettings,actOnRun}=await import('./funding-engine');await saveSettings('factor','admin',await settings());
    const fetcher=vi.fn(async()=>{throw Error('connection closed');});vi.stubGlobal('fetch',fetcher);
    expect((await actOnRun('factor','one','fund','admin','Admin')).ok).toBe(false);
    expect((await query("select state from engine_runs where id='one'"))[0].state).toBe('FUNDING');
    expect((await query('select kind from recovery_items'))[0].kind).toBe('FUNDING_UNKNOWN');
    await actOnRun('factor','one','fund','admin','Admin');expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reconciliation needs evidence and records the actor before unblocking',async()=>{
    await run('one');const {claimFunding}=await import('./funding-safety');await claimFunding('one',true,await settings());const {openRecovery}=await import('./recovery');await openRecovery({factorId:'factor',runId:'one',kind:'FUNDING_UNKNOWN',detail:'Timeout'});
    const id=(await query('select id from recovery_items'))[0].id;const {POST}=await import('../app/api/ops/recovery/route');
    const request=(evidence:string)=>new Request('https://portal.test/api/ops/recovery',{method:'POST',body:JSON.stringify({id,outcome:'not-funded',evidence})});
    expect((await POST(request(''))).status).toBe(400);
    expect((await POST(request('Checked batch one: status NOT_FUNDED; no payment reference.'))).status).toBe(200);
    expect((await query("select state from engine_runs where id='one'"))[0].state).toBe('APPROVED');
    expect((await query('select status from funding_reservations'))[0].status).toBe('RELEASED');
    expect((await query("select actor_user_id from audit_events where event_type='RECOVERY_RECONCILED'"))[0].actor_user_id).toBe('admin');
  });
  it('recovery cannot be reconciled across factors',async()=>{
    const {openRecovery}=await import('./recovery');await openRecovery({factorId:'other',kind:'DOCUMENT_UPLOAD',detail:'other'});const id=(await query('select id from recovery_items'))[0].id;
    const {POST}=await import('../app/api/ops/recovery/route');expect((await POST(new Request('https://portal.test',{method:'POST',body:JSON.stringify({id,outcome:'repaired',evidence:'Verified another invoice in FactorCloud'})}))).status).toBe(404);
  });
  it('driver access never grants factor operations',async()=>{await login('DRIVER','driver');const {requireFactorSession}=await import('./portal-auth');await expect(requireFactorSession()).rejects.toThrow('Factor access required');});
  it('a driver cannot answer another driver’s fix request',async()=>{
    await submission('mine','driver');await submission('theirs','driver2');await query("insert into client_tasks(id,factor_id,client_id,submission_id,message) values('tm','factor','client','mine','Fix'),('tt','factor','client','theirs','Fix')");await login('DRIVER','driver');const {clientTask}=await import('./client-tasks');expect(await clientTask('tm','factor','fc-client')).not.toBeNull();expect(await clientTask('tt','factor','fc-client')).toBeNull();
  });
  it('deactivating a driver revokes their existing session',async()=>{await login('DRIVER','driver');await query("update portal_users set is_active=false where id='driver'");const {requirePortalSession}=await import('./portal-auth');await expect(requirePortalSession()).rejects.toThrow('access has changed');});
  it('invitation is single use and creates only a client-scoped driver',async()=>{
    const {POST:invite}=await import('../app/api/ops/team/route');const r=await invite(new Request('https://portal.test',{method:'POST',body:JSON.stringify({email:'new@test.invalid',clientId:'client'})}));expect(r.status).toBe(200);const body=await r.json();const token=new URL(body.invitationUrl).hash.slice(1);const {POST:accept}=await import('../app/api/portal-auth/accept-invite/route');const request=()=>new Request('https://portal.test',{method:'POST',body:JSON.stringify({token,name:'New Driver',password:'a-long-local-test-password'})});expect((await accept(request())).status).toBe(200);expect((await accept(request())).status).toBe(410);const [u]=await query("select u.role,a.client_id from portal_users u join user_client_access a on a.user_id=u.id where email='new@test.invalid'");expect(u).toEqual({role:'DRIVER',client_id:'client'});
  });
  it('expired invitations cannot create accounts',async()=>{
    const {createHash}=await import('crypto');const token='a'.repeat(43);await query("insert into driver_invites values($1,'factor','client','expired@test.invalid','admin',now()-interval '1 hour',null,now())",[createHash('sha256').update(token).digest('hex')]);const {POST}=await import('../app/api/portal-auth/accept-invite/route');expect((await POST(new Request('https://portal.test',{method:'POST',body:JSON.stringify({token,name:'Expired',password:'long-local-test-password'})}))).status).toBe(410);
  });
  it('fix notifications deduplicate and reach only the owning driver',async()=>{
    await submission();await query("insert into client_tasks(id,factor_id,client_id,submission_id,message,created_at) values('task','factor','client','sub','Missing POD',now()-interval '25 hours')");const {enqueueFixNotifications}=await import('./notifications');expect(await enqueueFixNotifications('factor')).toBe(2);expect(await enqueueFixNotifications('factor')).toBe(0);expect((await query('select distinct recipient from notification_outbox'))).toEqual([{recipient:'driver@test.invalid'}]);
  });
  it('disabled notifications make no network calls',async()=>{const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const {processNotifications}=await import('./notifications');expect((await processNotifications('factor')).disabled).toBe(true);expect(fetcher).not.toHaveBeenCalled();});
  it('rule versions retain previous settings',async()=>{const {saveSettings}=await import('./funding-engine');const first=await settings();await saveSettings('factor','admin',first);await saveSettings('factor','admin',{...first,mode:'suggest'});const versions=await query('select settings from rule_versions order by id');expect(versions.map(v=>v.settings.mode)).toEqual(['fund','suggest']);});
  it('preview uses recorded facts without making FactorCloud calls',async()=>{
    await run('one');await query(`update engine_runs set facts_snapshot=$1::jsonb where id='one'`,[JSON.stringify({invoice:{id:'one',amount:600,clientId:'fc-client',debtorId:'debtor'},paperwork:'REVIEW',debtorCredit:null,clientRecords:[],debtorRecords:[],cashReserve:0,fundedToday:{client:0,factor:0},now:new Date().toISOString()})]);const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const {POST}=await import('../app/api/ops/rules/preview/route');const r=await POST(new Request('https://portal.test',{method:'POST',body:JSON.stringify({settings:await settings()})}));expect(r.status).toBe(200);expect((await r.json()).results[0].after).toBe('REVIEW');expect(fetcher).not.toHaveBeenCalled();
  });
});
