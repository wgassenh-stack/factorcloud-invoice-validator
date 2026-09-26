'use client';

import { useEffect, useState } from 'react';
import { CameraCapture } from './CameraCapture';

type Task = { id: string; submissionId: string; invoiceId: string | null; invoiceNumber: string | null; message: string; createdAt: string };

function useOpenTasks(): [Task[], () => void] {
  const [tasks, setTasks] = useState<Task[]>([]);
  const load = () => {
    void fetch('/api/tasks', { cache: 'no-store' }).then(async (res) => {
      if (res.ok) setTasks(((await res.json()) as { tasks: Task[] }).tasks ?? []);
    }).catch(() => {});
  };
  useEffect(load, []);
  return [tasks, load];
}

function ago(iso: string): string {
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min ago`;
  if (hours < 24) return `${Math.floor(hours)} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** Dashboard banner: what the factor is waiting on from this client. */
export function FixRequestsBanner() {
  const [tasks] = useOpenTasks();
  if (!tasks.length) return null;
  return <section className="fixBanner" aria-label="Action needed">
    <div className="fixBannerHead"><span className="fixBannerIcon" aria-hidden="true">!</span><div><strong>Your factor needs {tasks.length === 1 ? 'one thing' : `${tasks.length} things`} from you</strong><small>These invoices are on hold until you respond.</small></div></div>
    <ul>
      {tasks.map((task) => <li key={task.id}>
        <div><strong>Invoice {task.invoiceNumber ?? task.invoiceId ?? ''}</strong><span>“{task.message}”</span><small>Asked {ago(task.createdAt)}</small></div>
        {task.invoiceId && <a className="primaryLink" href={`/invoices/${encodeURIComponent(task.invoiceId)}#fix`}>Upload fix</a>}
      </li>)}
    </ul>
  </section>;
}

/** Invoice page: answer the factor's fix request by uploading files to the same invoice. */
export function FixRequestPanel({ invoiceId, onDone }: { invoiceId: string; onDone?: () => void }) {
  const [tasks, reload] = useOpenTasks();
  const task = tasks.find((t) => t.invoiceId === invoiceId);
  const [files, setFiles] = useState<File[]>([]);
  const [documentType, setDocumentType] = useState('pod');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  if (sent) return <section className="fixPanel sent" id="fix"><strong>Sent to your factor</strong><span>They'll review it and you'll see the decision on this invoice.</span></section>;
  if (!task) return null;

  async function send() {
    setSending(true);
    setError('');
    try {
      const form = new FormData();
      files.forEach((file) => form.append('files', file));
      form.append('documentType', documentType);
      form.append('note', note);
      const res = await fetch(`/api/tasks/${encodeURIComponent(task!.id)}`, { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not send the files.');
      setSent(true);
      reload();
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return <section className="fixPanel" id="fix">
    <div className="fixPanelHead"><span className="fixBannerIcon" aria-hidden="true">!</span><div><strong>Your factor asked for a fix</strong><span>“{task.message}”</span><small>Asked {ago(task.createdAt)}</small></div></div>
    <div className="fixPanelForm">
      <label className="dropzone fixDrop">
        <input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/gif,image/webp" onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
        <strong>{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} ready` : 'Add the corrected paperwork'}</strong>
        <span>{files.length ? files.map((f) => f.name).join(', ') : 'PDF or photos'}</span>
      </label>
      <CameraCapture count={files.filter((f) => f.name.startsWith('photo-')).length} disabled={sending} onCapture={(photo) => setFiles([...files, photo])} />
      <div className="fixPanelRow">
        <label><span>What is it?</span>
          <select value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
            <option value="pod">Proof of delivery</option>
            <option value="bol">Bill of lading</option>
            <option value="rate_confirmation">Rate confirmation</option>
            <option value="invoice">Corrected invoice</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="grow"><span>Note for your factor (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Signed POD attached" maxLength={1000} /></label>
      </div>
      {error && <div className="warning">{error}</div>}
      <div className="fixPanelActions">
        {files.length > 0 && <button type="button" className="secondaryLink" onClick={() => setFiles([])} disabled={sending}>Clear</button>}
        <button type="button" className="primaryLink" onClick={() => void send()} disabled={!files.length || sending}>{sending ? 'Sending…' : 'Send to factor'}</button>
      </div>
    </div>
  </section>;
}
