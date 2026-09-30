'use client';
import {useEffect,useState} from 'react';
export default function InvitePage(){
  const [token,setToken]=useState(''),[name,setName]=useState(''),[password,setPassword]=useState(''),[message,setMessage]=useState(''),[done,setDone]=useState(false),[busy,setBusy]=useState(false);
  useEffect(()=>{setToken(window.location.hash.slice(1));window.history.replaceState(null,'','/invite');},[]);
  async function accept(e:React.FormEvent){e.preventDefault();setBusy(true);try{const r=await fetch('/api/portal-auth/accept-invite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,name,password})});const b=await r.json();if(!r.ok)throw Error(b.error);setPassword('');setDone(true);}catch(e){setMessage(String(e));}finally{setBusy(false);}}
  return <main className="opsContent"><section className="dashCard"><h1>Create your driver account</h1>{done?<p>Your account is ready. <a href="/login">Sign in</a></p>:<form onSubmit={accept}><label className="field"><span>Your name</span><input required maxLength={100} autoComplete="name" value={name} onChange={e=>setName(e.target.value)}/></label><label className="field"><span>Password (at least 12 characters)</span><input required type="password" minLength={12} maxLength={72} autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)}/></label><button disabled={busy||!token}>{busy?'Creating…':'Create account'}</button></form>}{message&&<p role="alert">{message}</p>}{!token&&!done&&<p>Open the full invitation link sent by your factor.</p>}</section></main>;
}
