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
    await query('truncate auth_throttle');
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
  it('an uncertain approval cannot be funded even when a batch was persisted',async()=>{
    await run('one');await query("update engine_runs set approval_status='UNKNOWN'");
    const {claimFunding}=await import('./funding-safety');expect(await claimFunding('one',false,await settings())).toBe(false);
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
    // The batch check answers; the money call times out.
    const fundCalls:string[]=[];
    const fetcher=vi.fn(async(input:URL|string,init?:RequestInit)=>{const path=new URL(String(input)).pathname;
      if(init?.method==='PATCH'){fundCalls.push(path);throw Error('connection closed');}
      if(path.endsWith('/invoice-funding'))return new Response(JSON.stringify({invoiceFundings:[{invoiceId:'one',invoiceGroupId:'batch-one'}]}));
      if(path.startsWith('/invoice-groups/'))return new Response(JSON.stringify({invoiceGroup:{id:'batch-one',code:'B1',status:'NOT_FUNDED'}}));
      if(path==='/invoices/one')return new Response(JSON.stringify({invoice:{id:'one',invoiceNumber:'ONE',invoiceAmount:600,status:'APPROVED'}}));
      return new Response(JSON.stringify({}));});
    vi.stubGlobal('fetch',fetcher);
    expect((await actOnRun('factor','one','fund','admin','Admin',{expected:[{invoiceId:'one',amount:600}]})).ok).toBe(false);
    expect((await query("select state from engine_runs where id='one'"))[0].state).toBe('FUNDING');
    expect((await query('select kind from recovery_items'))[0].kind).toBe('FUNDING_UNKNOWN');
    await actOnRun('factor','one','fund','admin','Admin',{expected:[{invoiceId:'one',amount:600}]});expect(fundCalls).toEqual(['/invoice-groups/fund']);
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
    const {createHash}=await import('crypto');const token='a'.repeat(43);await query("insert into driver_invites(token_hash,factor_id,client_id,email,created_by,expires_at) values($1,'factor','client','expired@test.invalid','admin',now()-interval '1 hour')",[createHash('sha256').update(token).digest('hex')]);const {POST}=await import('../app/api/portal-auth/accept-invite/route');expect((await POST(new Request('https://portal.test',{method:'POST',body:JSON.stringify({token,name:'Expired',password:'long-local-test-password'})}))).status).toBe(410);
  });
  it('fix notifications deduplicate and reach only the owning driver',async()=>{
    await submission();await query("insert into client_tasks(id,factor_id,client_id,submission_id,message,created_at) values('task','factor','client','sub','Missing POD',now()-interval '25 hours')");const {enqueueFixNotifications}=await import('./notifications');expect(await enqueueFixNotifications('factor')).toBe(1);expect(await enqueueFixNotifications('factor')).toBe(0);
    await query("update notification_outbox set status='SENT',sent_at=now()-interval '25 hours'");expect(await enqueueFixNotifications('factor')).toBe(1);
    expect((await query('select distinct recipient from notification_outbox'))).toEqual([{recipient:'driver@test.invalid'}]);
  });
  it('disabled notifications make no network calls',async()=>{const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const {processNotifications}=await import('./notifications');expect((await processNotifications('factor')).disabled).toBe(true);expect(fetcher).not.toHaveBeenCalled();});
  it('concurrent approval claims execute only one operation',async()=>{
    await run('one');await query("update engine_runs set state='SUGGESTED'");
    const {withApprovalClaim}=await import('./approval-safety');
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    const first=withApprovalClaim('one',async()=>{entered();await gate;return {ok:true};});
    await started;expect(await withApprovalClaim('one',async()=>{throw Error('duplicate');})).toMatchObject({ok:false});
    release();expect(await first).toEqual({ok:true});
  });
  it('interrupted approval writes remain blocked and appear in recovery',async()=>{
    await run('one');await query("update engine_runs set state='FAILED'");
    const {withApprovalClaim}=await import('./approval-safety');
    await expect(withApprovalClaim('one',async()=>{await query("update engine_runs set approval_status='SENDING'");throw Error('lost response');})).rejects.toThrow('lost response');
    expect(await withApprovalClaim('one',async()=>true)).toMatchObject({ok:false});
    expect((await query('select kind from recovery_items'))[0].kind).toBe('APPROVAL_UNKNOWN');
  });
  it('stale approval checks can be reconciled without closing unrelated recovery',async()=>{
    await run('one');await query("update engine_runs set state='FAILED',approval_status='CHECKING',approval_started_at=now()-interval '6 minutes'");
    const {openRecovery,recoveryQueue}=await import('./recovery');
    await openRecovery({factorId:'factor',runId:'one',kind:'DOCUMENT_ATTACH',detail:'Needs documents'});
    expect((await recoveryQueue('factor')).some(r=>r.id==='approval:one')).toBe(true);
    const {POST}=await import('../app/api/ops/recovery/route');
    expect((await POST(new Request('https://portal.test',{method:'POST',body:JSON.stringify({id:'approval:one',outcome:'not-approved',evidence:'Invoice has no approval or funding batch in FactorCloud.'})}))).status).toBe(200);
    expect((await query('select approval_status from engine_runs'))[0].approval_status).toBe('IDLE');
    expect((await query('select status from recovery_items'))[0].status).toBe('OPEN');
  });
  it('unknown creation requires explicit reconciliation and never releases a known invoice',async()=>{
    await submission();const {openRecovery}=await import('./recovery');await openRecovery({factorId:'factor',submissionId:'sub',kind:'CREATE_UNKNOWN',detail:'Lost response'});
    const id=(await query('select id from recovery_items'))[0].id;const {POST}=await import('../app/api/ops/recovery/route');
    for(const outcome of ['repaired','not-created'])expect((await POST(new Request('https://portal.test',{method:'POST',body:JSON.stringify({id,outcome,evidence:'Checked invoice list and payment history.'})}))).status).toBe(400);
    await query("update submissions set factorcloud_invoice_id=null");
    expect((await POST(new Request('https://portal.test',{method:'POST',body:JSON.stringify({id,outcome:'not-created',evidence:'Confirmed no invoice exists for this client and invoice number.'})}))).status).toBe(200);
    expect((await query('select idempotency_released_at from submissions'))[0].idempotency_released_at).not.toBeNull();
  });
  it('linking an invoice verifies client ownership and leaves document repair open',async()=>{
    await submission();await query('update submissions set factorcloud_invoice_id=null');
    const {openRecovery}=await import('./recovery');await openRecovery({factorId:'factor',submissionId:'sub',kind:'CREATE_UNKNOWN',detail:'Lost response'});
    const id=(await query('select id from recovery_items'))[0].id;const {POST}=await import('../app/api/ops/recovery/route');
    const request=()=>new Request('https://portal.test',{method:'POST',body:JSON.stringify({id,outcome:'created',invoiceId:'remote',evidence:'Located the matching client invoice in FactorCloud.'})});
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({invoice:{id:'remote',invoiceNumber:'sub',companyClientId:'wrong-client'}}))));
    expect((await POST(request())).status).toBe(400);
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({invoice:{id:'remote',invoiceNumber:'sub',companyClientId:'fc-client'}}))));
    expect((await POST(request())).status).toBe(200);
    expect((await query('select factorcloud_invoice_id from submissions'))[0].factorcloud_invoice_id).toBe('remote');
    expect((await query("select kind from recovery_items where status='OPEN'"))[0].kind).toBe('DOCUMENT_ATTACH');
  });
  async function invite(email='new@test.invalid'){
    const {POST}=await import('../app/api/ops/team/route');
    const r=await POST(new Request('https://portal.test',{method:'POST',body:JSON.stringify({email,clientId:'client'})}));expect(r.status).toBe(200);
    return new URL((await r.json()).invitationUrl).hash.slice(1);
  }
  async function accept(token:string){const {POST}=await import('../app/api/portal-auth/accept-invite/route');return POST(new Request('https://portal.test',{method:'POST',body:JSON.stringify({token,name:'Driver',password:'long-local-test-password'})}));}
  it('resending an invitation revokes the old token',async()=>{
    const old=await invite();const next=await invite();expect((await accept(old)).status).toBe(410);expect((await accept(next)).status).toBe(200);
    expect((await query("select count(*) from portal_users where email='new@test.invalid'"))[0].count).toBe('1');
  });
  it('revocation is audited and prevents invitation acceptance',async()=>{
    const token=await invite();const id=(await query('select token_hash from driver_invites'))[0].token_hash;
    const {PATCH}=await import('../app/api/ops/team/route');expect((await PATCH(new Request('https://portal.test',{method:'PATCH',body:JSON.stringify({invitationId:id})}))).status).toBe(200);
    expect((await accept(token)).status).toBe(410);expect(await query("select id from audit_events where event_type='DRIVER_INVITE_REVOKED'")).toHaveLength(1);
  });
  it('invitation attempts are throttled before password hashing',async()=>{
    const token='z'.repeat(43);for(let i=0;i<10;i++)expect((await accept(token)).status).toBe(410);
    expect((await accept(token)).status).toBe(429);
  });
  it('concurrent invitation acceptance creates exactly one account',async()=>{
    const token=await invite();expect((await Promise.all([accept(token),accept(token)])).map(r=>r.status).sort()).toEqual([200,410]);
  });
  it('drivers cannot invite or change another account',async()=>{
    await login('DRIVER','driver');const {POST,PATCH}=await import('../app/api/ops/team/route');
    expect((await POST(new Request('https://portal.test',{method:'POST',body:'{}'}))).status).toBe(403);
    expect((await PATCH(new Request('https://portal.test',{method:'PATCH',body:'{}'}))).status).toBe(403);
  });
  async function enableMail(){Object.assign(process.env,{NOTIFICATIONS_ENABLED:'true',RESEND_API_KEY:'test-only',NOTIFICATION_FROM:'portal@test.invalid'});}
  it('queued notifications are canceled after recipient access is revoked',async()=>{
    await submission();await query("insert into client_tasks(id,factor_id,client_id,submission_id,message) values('task','factor','client','sub','Fix')");
    const {enqueueFixNotifications,processNotifications}=await import('./notifications');await enqueueFixNotifications('factor');await query("delete from user_client_access where user_id='driver'");
    await enableMail();const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await processNotifications('factor');expect(fetcher).not.toHaveBeenCalled();
    expect((await query('select status from notification_outbox'))[0].status).toBe('CANCELED');
  });
  it('expired invitation emails are canceled without contacting the provider',async()=>{
    await invite();await query("update driver_invites set expires_at=now()-interval '1 minute'");await enableMail();const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const {processNotifications}=await import('./notifications');await processNotifications('factor');expect(fetcher).not.toHaveBeenCalled();expect((await query('select status from notification_outbox'))[0].status).toBe('CANCELED');
  });
  it('rate limits retry with the same key but uncertain sends remain blocked',async()=>{
    await invite();await enableMail();const keys:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{keys.push((init.headers as Record<string,string>)['Idempotency-Key']);return new Response('',{status:429});}));
    const {processNotifications}=await import('./notifications');await processNotifications('factor');expect((await query('select status from notification_outbox'))[0].status).toBe('PENDING');
    await query('update notification_outbox set available_at=now()');await processNotifications('factor');expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
    await query('update notification_outbox set available_at=now()');vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('timeout');}));await processNotifications('factor');expect((await query('select status from notification_outbox'))[0].status).toBe('FAILED');
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await processNotifications('factor');expect(fetcher).not.toHaveBeenCalled();
  });
  it('rule versions retain previous settings',async()=>{const {saveSettings}=await import('./funding-engine');const first=await settings();await saveSettings('factor','admin',first);await saveSettings('factor','admin',{...first,mode:'suggest'});const versions=await query('select settings from rule_versions order by id');expect(versions.map(v=>v.settings.mode)).toEqual(['fund','suggest']);});
  it('notification retries require evidence and commit an audit event',async()=>{
    await invite();await query("update notification_outbox set status='FAILED'");const id=(await query('select id from notification_outbox'))[0].id;
    const {PATCH}=await import('../app/api/ops/notifications/route');
    const request=(evidence:string)=>new Request('https://portal.test',{method:'PATCH',body:JSON.stringify({id,outcome:'not-sent',evidence})});
    expect((await PATCH(request(''))).status).toBe(400);
    expect((await PATCH(request('Provider logs confirm the message was never accepted.'))).status).toBe(200);
    expect((await query('select status from notification_outbox'))[0].status).toBe('PENDING');
    expect(await query("select id from audit_events where event_type='NOTIFICATION_RECONCILED'")).toHaveLength(1);
  });
  it('a confirmed approval records its batch without funding it',async()=>{
    await run('one');await query("update engine_runs set state='FAILED',approval_status='UNKNOWN'");
    const {openRecovery}=await import('./recovery');await openRecovery({factorId:'factor',runId:'one',kind:'APPROVAL_UNKNOWN',detail:'Lost response'});
    const id=(await query('select id from recovery_items'))[0].id;const {POST}=await import('../app/api/ops/recovery/route');const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    expect((await POST(new Request('https://portal.test',{method:'POST',body:JSON.stringify({id,outcome:'approved',invoiceGroupId:'verified-batch',paymentType:'ACH',evidence:'FactorCloud shows this invoice approved in batch verified-batch, not funded.'})}))).status).toBe(200);
    expect((await query('select state,approval_status,invoice_group_id from engine_runs'))[0]).toEqual({state:'APPROVED',approval_status:'COMPLETE',invoice_group_id:'verified-batch'});expect(fetcher).not.toHaveBeenCalled();
  });
  it('worker batches stay bounded and never reclaim sent messages',async()=>{
    for(let i=0;i<4;i++)await invite(`new${i}@test.invalid`);await enableMail();
    const fetcher=vi.fn(async()=>new Response('{}',{status:200}));vi.stubGlobal('fetch',fetcher);
    const {processNotifications}=await import('./notifications');expect(await processNotifications('factor')).toEqual({sent:3,failed:0});
    expect(await processNotifications('factor')).toEqual({sent:1,failed:0});expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('cross-factor notification and invitation changes are denied',async()=>{
    await query("insert into notification_outbox(id,factor_id,recipient,subject,message,dedupe_key,status) values('other-mail','other','a@test.invalid','Test','Test','other-key','FAILED')");
    const {PATCH}=await import('../app/api/ops/notifications/route');expect((await PATCH(new Request('https://portal.test',{method:'PATCH',body:JSON.stringify({id:'other-mail',outcome:'not-sent',evidence:'Verified with the provider that nothing was sent.'})}))).status).toBe(404);
    const {POST}=await import('../app/api/ops/team/route');await query("insert into portal_clients(id,factor_id,factorcloud_client_id,name) values('other-client','other','other-fc','Other')");
    expect((await POST(new Request('https://portal.test',{method:'POST',body:JSON.stringify({email:'other@test.invalid',clientId:'other-client'})}))).status).toBe(404);
  });
  it('preview uses recorded facts without making FactorCloud calls',async()=>{
    await run('one');await query(`update engine_runs set facts_snapshot=$1::jsonb where id='one'`,[JSON.stringify({invoice:{id:'one',amount:600,clientId:'fc-client',debtorId:'debtor'},paperwork:'REVIEW',debtorCredit:null,clientRecords:[],debtorRecords:[],cashReserve:0,fundedToday:{client:0,factor:0},now:new Date().toISOString()})]);const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const {POST}=await import('../app/api/ops/rules/preview/route');const r=await POST(new Request('https://portal.test',{method:'POST',body:JSON.stringify({settings:await settings()})}));expect(r.status).toBe(200);expect((await r.json()).results[0].after).toBe('REVIEW');expect(fetcher).not.toHaveBeenCalled();
  });
  it('reconciling a batch-funding failure settles every invoice in the batch together',async()=>{
    await run('a1');await run('a2');
    await query("update engine_runs set invoice_group_id='g1',state='FUNDING',updated_at=now()-interval '10 minutes' where id in ('a1','a2')");
    await query("insert into funding_reservations(run_id,factor_id,client_id,business_day,amount,status) values('a1','factor','fc-client',current_date,600,'UNKNOWN'),('a2','factor','fc-client',current_date,600,'UNKNOWN')");
    const {openRecovery,recoveryQueue}=await import('./recovery');
    await openRecovery({factorId:'factor',runId:'a1',kind:'FUNDING_UNKNOWN',detail:'Timeout funding batch g1'});
    const queue=await recoveryQueue('factor') as {id:string;kind:string}[];
    expect(queue.filter((i)=>i.kind==='FUNDING_UNKNOWN')).toHaveLength(1); // one item for the batch, not one per invoice
    const {POST}=await import('../app/api/ops/recovery/route');
    const res=await POST(new Request('https://portal.test',{method:'POST',body:JSON.stringify({id:queue[0].id,outcome:'not-funded',evidence:'Checked batch g1 in FactorCloud: status NOT_FUNDED.'})}));
    expect(res.status).toBe(200);
    expect((await query<{state:string}>("select id,state from engine_runs where id in ('a1','a2') order by id")).map((r)=>r.state)).toEqual(['APPROVED','APPROVED']);
    expect((await query<{status:string}>("select status from funding_reservations order by run_id")).map((r)=>r.status)).toEqual(['RELEASED','RELEASED']);
    expect(await recoveryQueue('factor')).toHaveLength(0);
  });
  it('a send that stopped part-way surfaces in Recovery and can be settled',async()=>{
    const {recoveryQueue}=await import('./recovery');await recoveryQueue('factor'); // provisions send_stage
    await query(`insert into submissions(id,factor_id,client_id,submitted_by_user_id,invoice_number_submitted,validation_status,idempotency_key,send_stage,updated_at)
      values('s-unknown','factor','client','driver','INV-9','PASS','k-unknown','SENDING',now()-interval '20 minutes'),
            ('s-docs','factor','client','driver','INV-10','PASS','k-docs','CREATED',now()-interval '20 minutes'),
            ('s-recent','factor','client','driver','INV-11','PASS','k-recent','SENDING',now()),
            ('s-done','factor','client','driver','INV-12','PASS','k-done','COMPLETE',now()-interval '20 minutes'),
            ('s-legacy','factor','client','driver','INV-13','PASS','k-legacy',null,now()-interval '20 minutes')`);
    await query("update submissions set factorcloud_invoice_id='fc-10' where id='s-docs'");
    const queue=await recoveryQueue('factor') as {id:string;kind:string}[];
    expect(queue.map((i)=>[i.id,i.kind]).sort()).toEqual([['send:s-docs','DOCUMENT_ATTACH'],['send:s-unknown','CREATE_UNKNOWN']]);
    const {POST}=await import('../app/api/ops/recovery/route');
    const post=(body:object)=>POST(new Request('https://portal.test',{method:'POST',body:JSON.stringify(body)}));
    expect((await post({id:'send:s-unknown',outcome:'not-created',evidence:'Searched FactorCloud for INV-9 for this client: no invoice.'})).status).toBe(200);
    expect((await post({id:'send:s-docs',outcome:'repaired',evidence:'Attached the POD to fc-10 in FactorCloud and checked it.'})).status).toBe(200);
    expect(await recoveryQueue('factor')).toHaveLength(0);
    expect((await query("select send_stage from submissions where id='s-docs'"))[0].send_stage).toBe('COMPLETE');
  });
  it('a client fix is claimed before uploading: an unconfirmed attach blocks a second upload and goes to Recovery',async()=>{
    await submission('mine','driver');await query("insert into client_tasks(id,factor_id,client_id,submission_id,message) values('tm','factor','client','mine','Fix')");await login('DRIVER','driver');
    let attach:'fail'|'ok'='fail';const sentPaths:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(input:URL|string)=>{const path=new URL(String(input)).pathname;sentPaths.push(path);
      if(path==='/documents')return new Response(JSON.stringify({document:{id:'doc-'+sentPaths.length}}));
      if(path==='/invoices/mine/documents'){if(attach==='fail')throw Error('connection reset');return new Response(JSON.stringify({status:'SUCCESS'}));}
      return new Response('{}');}));
    const {POST}=await import('../app/api/tasks/[taskId]/route');
    const send=()=>{const form=new FormData();form.append('files',new File(['pod'],'pod.pdf',{type:'application/pdf'}));form.append('documentType','pod');return POST(new Request('https://portal.test',{method:'POST',body:form}),{params:Promise.resolve({taskId:'tm'})});};
    const first=await send();
    expect(first.status).toBe(502);expect((await first.json()).error).toMatch(/don't need to send them again/);
    expect((await query<{kind:string}>("select kind from recovery_items where submission_id='mine' and status='OPEN'")).map((r)=>r.kind)).toEqual(['FIX_ATTACH_UNKNOWN']);
    expect((await query("select status from client_tasks where id='tm'"))[0].status).toBe('OPEN');
    const uploadsBefore=sentPaths.filter(p=>p==='/documents').length;
    const second=await send();
    expect(second.status).toBe(409);expect(sentPaths.filter(p=>p==='/documents').length).toBe(uploadsBefore); // nothing sent again
    // The factor checks FactorCloud and resolves it; the client can answer again, and it completes.
    await query("update recovery_items set status='RESOLVED' where submission_id='mine'");attach='ok';
    const third=await send();
    expect(third.status).toBe(200);
    expect((await query("select status from client_tasks where id='tm'"))[0].status).toBe('DONE');
    expect(await query("select id from recovery_items where submission_id='mine' and status='OPEN'")).toHaveLength(0);
  });
  it('a claim left by an interrupted fix upload blocks another upload and appears in Recovery after five minutes',async()=>{
    await submission('mine','driver');await query("insert into client_tasks(id,factor_id,client_id,submission_id,message) values('tm','factor','client','mine','Fix')");
    await query("insert into recovery_items(id,factor_id,submission_id,kind,detail,created_at) values('claim','factor','mine','FIX_SENDING','in progress',now())");
    const {recoveryQueue}=await import('./recovery');
    expect(await recoveryQueue('factor')).toHaveLength(0); // still in progress, not a problem yet
    await login('DRIVER','driver');const sent=vi.fn(async()=>new Response('{}'));vi.stubGlobal('fetch',sent);
    const {POST}=await import('../app/api/tasks/[taskId]/route');
    const form=new FormData();form.append('files',new File(['pod'],'pod.pdf',{type:'application/pdf'}));
    expect((await POST(new Request('https://portal.test',{method:'POST',body:form}),{params:Promise.resolve({taskId:'tm'})})).status).toBe(409);
    expect(sent).not.toHaveBeenCalled();
    await query("update recovery_items set created_at=now()-interval '6 minutes' where id='claim'");await login();
    expect((await recoveryQueue('factor') as {kind:string}[]).map((i)=>i.kind)).toEqual(['FIX_SENDING']);
  });
});
