'use client';
import {useEffect,useState} from 'react';
type Event={id:string;title:string;detail:unknown;at:string};
export function InvoiceJourney({submissionId}:{submissionId:string}){
  const [events,setEvents]=useState<Event[]>([]),[error,setError]=useState('');
  useEffect(()=>{void fetch(`/api/ops/submissions/${encodeURIComponent(submissionId)}/journey`).then(async r=>{const b=await r.json();if(!r.ok)throw Error(b.error);setEvents(b.events);}).catch(e=>setError(String(e)));},[submissionId]);
  return <section className="opsPanel"><div className="opsPanelHeader"><div><h2>Invoice timeline</h2><p>Submission, review, funding and recovery in one place.</p></div></div>{error&&<p role="alert">{error}</p>}<ol>{events.map(e=><li key={`${e.id}:${e.title}`}><strong>{e.title.replaceAll('_',' ')}</strong> · <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time><details><summary>Decision details</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(e.detail,null,2)}</pre></details></li>)}</ol></section>;
}
