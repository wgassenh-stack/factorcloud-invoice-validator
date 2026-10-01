'use client';
import {useEffect,useRef,useState} from 'react';
import {loadDraft,saveDraft} from '@/lib/upload-draft';
export function UploadDraft<T>({value,onRestore,empty}:{value:T;onRestore:(v:T)=>void;empty:boolean}){
  const [key,setKey]=useState(''),[ready,setReady]=useState(false),[pending,setPending]=useState<T|null>(null),[message,setMessage]=useState('');
  const restoring=useRef(false);
  // What was on screen when the draft was discarded: not saved again until something changes.
  const discarded=useRef<string|null>(null),latest=useRef(value);latest.current=value;
  useEffect(()=>{let alive=true;void fetch('/api/portal-auth/session').then(r=>r.json()).then(async b=>{
    // Shared-password sessions cannot reliably isolate drafts between people.
    if(b.mode!=='database'||!b.user?.id)return;
    const k=`v1:${b.user.id}`;const draft=await loadDraft<{value:T;savedAt:number}>(k);
    if(!alive)return;setKey(k);if(draft&&Date.now()-draft.savedAt<7*86400000)setPending(draft.value);else setReady(true);
  }).catch(()=>{if(alive)setMessage('Draft storage is unavailable in this browser. Keep this page open.');});return()=>{alive=false;};},[]);
  useEffect(()=>{if(!key||!ready||restoring.current){restoring.current=false;return;}const timer=setTimeout(()=>{if(discarded.current!==null){if(signature(value)===discarded.current)return;discarded.current=null;}void saveDraft(key,empty?null:{value,savedAt:Date.now()}).then(()=>setMessage(empty?'':'Draft saved on this device.')).catch(()=>setMessage('Draft could not be saved. Keep this page open.'));},400);return()=>clearTimeout(timer);},[key,ready,value,empty]);
  return <div>{pending&&<section className="attentionSummary review"><strong>Resume your paperwork?</strong><span>A draft is saved for your account on this device. Verification may need refreshing.</span><button onClick={()=>{restoring.current=true;onRestore(pending);setPending(null);setReady(true);}}>Restore draft</button><button onClick={()=>{void saveDraft(key,null).then(()=>{discarded.current=signature(latest.current);setPending(null);setMessage('');setReady(true);}).catch(()=>setMessage('Could not discard draft.'));}}>Discard draft</button></section>}{message&&<p role="status">{message}</p>}</div>;
}

/** A cheap fingerprint of the page's state, with files reduced to name, size and date. */
function signature(value:unknown):string{
  return JSON.stringify(value,(_k,v)=>typeof Blob!=='undefined'&&v instanceof Blob?`blob:${(v as File).name??''}:${v.size}:${(v as File).lastModified??''}`:v);
}
