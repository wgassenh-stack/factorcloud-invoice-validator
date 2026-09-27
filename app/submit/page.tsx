'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { PortalNav } from '@/app/components/PortalNav';
import { ProcessingTheater, type TheaterPhase } from '@/app/components/ProcessingTheater';
import { CameraCapture } from '@/app/components/CameraCapture';
import { SubmitAnywayBox } from '@/app/components/SubmitAnyway';
import { validate } from '@/lib/rules';
import { applyFactorCloudAvailability } from '@/lib/validation-availability';
import { explanationProblem, flaggedChecks, hardBlocks } from '@/lib/override';
import { demoInBrowser, demoViewInBrowser } from '@/lib/demo';
import type { PaperworkCard, PaperworkResponse, SkippedFile } from '@/lib/paperwork';
import type { AnalyzedDocument, CreateResponse, ValidationReport } from '@/lib/types';

// One page for sending in paperwork: one invoice's documents or a whole stack. Everything is read,
// sorted into one card per invoice, and checked. Most of the time the sorting is right and people
// just press Send. When it isn't, "Fix sorting" shows tap buttons under each document; documents
// that couldn't be placed wait in a tray with a suggested match.

type Edits = { invoiceNumber: string; referenceNumber: string; invoiceAmount: string; invoiceDate: string };
type Sent = { state: 'sending' | 'sent' | 'error'; message: string; invoiceId?: string; review?: boolean };
type Card = PaperworkCard & { edits: Edits; note: string; sent?: Sent; serverFlags?: ValidationReport };
type Target = { id: string; label: string };

const DOC_LABEL: Record<string, string> = { invoice: 'Invoice', bol: 'BOL', pod: 'POD', rate_confirmation: 'Rate con', lumper_receipt: 'Lumper receipt', other: 'Other' };
const ACCEPT = 'application/pdf,image/png,image/jpeg,image/gif,image/webp';

export default function SendPaperworkPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [loads, setLoads] = useState<(number | null)[]>([]);
  const [load, setLoad] = useState(1);
  const [busy, setBusy] = useState<'' | 'reading' | 'checking' | 'sending' | 'adding'>('');
  const [error, setError] = useState('');
  const [upload, setUpload] = useState<{ documents: AnalyzedDocument[]; receipt: string; warnings: string[] } | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [unassigned, setUnassigned] = useState<number[]>([]);
  const [suggestions, setSuggestions] = useState<Record<number, number[]>>({});
  const [left, setLeft] = useState<number[]>([]);
  const [skipped, setSkipped] = useState<{ unreadable: SkippedFile[]; duplicates: SkippedFile[] }>({ unreadable: [], duplicates: [] });
  const [preview, setPreview] = useState<number | null>(null);
  const [asDriver, setAsDriver] = useState(false);

  useEffect(() => { setAsDriver(demoInBrowser() && demoViewInBrowser() === 'driver'); }, []);

  // A viewable link for every file, for thumbnails and the preview.
  const urls = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  useEffect(() => () => urls.forEach((url) => URL.revokeObjectURL(url)), [urls]);

  const photosThisLoad = files.filter((_, i) => loads[i] === load).length;
  const sentAny = cards.some((c) => c.sent?.state === 'sent');

  function addFiles(next: File[], nextLoad: number | null) {
    setFiles((current) => [...current, ...next]);
    setLoads((current) => [...current, ...next.map(() => nextLoad)]);
  }

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, i) => i !== index));
    setLoads((current) => current.filter((_, i) => i !== index));
  }

  function startOver() {
    setUpload(null);
    setCards([]);
    setUnassigned([]);
    setSuggestions({});
    setLeft([]);
    setSkipped({ unreadable: [], duplicates: [] });
    setError('');
    setFiles([]);
    setLoads([]);
    setLoad(1);
  }

  async function read() {
    setBusy('reading');
    setError('');
    try {
      const form = new FormData();
      files.forEach((file) => form.append('files', file));
      form.append('loads', JSON.stringify(loads));
      const res = await fetch('/api/paperwork/read', { method: 'POST', body: form });
      const body = await res.json() as PaperworkResponse & { error?: string };
      if (!res.ok) throw new Error(body.error || 'The paperwork could not be read.');
      setUpload({ documents: body.documents, receipt: body.documentsReceipt, warnings: body.warnings });
      setCards(body.cards.map((card) => withEdits(card)));
      setUnassigned(body.unassigned);
      setSuggestions(body.suggestions ?? {});
      setSkipped({ unreadable: body.unreadable ?? [], duplicates: body.duplicates ?? [] });
      setLeft([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  }

  /** Keeps what people typed on cards whose invoice didn't change. */
  function mergeCards(next: PaperworkCard[]): Card[] {
    const previous = new Map(cards.map((card) => [card.id, card]));
    return next.map((card) => {
      const before = previous.get(card.id);
      return before && before.documentIndexes[0] === card.documentIndexes[0] ? { ...withEdits(card), edits: before.edits, note: before.note, sent: before.sent, serverFlags: before.serverFlags } : withEdits(card);
    });
  }

  /** Moves one document and re-checks every card on the server (no re-reading). */
  async function move(docIndex: number, target: string) {
    if (!upload) return;
    let nextUnassigned = unassigned.filter((i) => i !== docIndex);
    let nextLeft = left.filter((i) => i !== docIndex);
    let groups = cards.map((card) => ({ id: card.id, documentIndexes: card.documentIndexes.filter((i) => i !== docIndex) }));
    if (target === 'unassigned') nextUnassigned = [...nextUnassigned, docIndex];
    else if (target === 'leave-out') nextLeft = [...nextLeft, docIndex];
    else if (target === 'new') groups = [...groups, { id: `card-n${Date.now().toString(36)}`, documentIndexes: [docIndex] }];
    else groups = groups.map((g) => (g.id === target ? { ...g, documentIndexes: [...g.documentIndexes, docIndex] } : g));
    groups = groups.filter((g) => g.documentIndexes.length);
    setUnassigned(nextUnassigned);
    setLeft(nextLeft);
    if (!groups.length) { setCards([]); return; }
    setBusy('checking');
    setError('');
    try {
      const res = await fetch('/api/paperwork/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentsReceipt: upload.receipt, cards: groups }) });
      const body = await res.json() as { cards: PaperworkCard[]; error?: string };
      if (!res.ok) throw new Error(body.error || 'The invoices could not be checked.');
      setCards(mergeCards(body.cards));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  }

  /** "+ Add a document": reads only the new files and puts them on that card. */
  async function addToCard(target: string, added: File[]) {
    if (!upload || !added.length) return;
    const firstIndex = files.length;
    addFiles(added, null);
    setBusy('adding');
    setError('');
    try {
      const form = new FormData();
      form.append('documentsReceipt', upload.receipt);
      form.append('cards', JSON.stringify(cards.map((c) => ({ id: c.id, documentIndexes: c.documentIndexes }))));
      form.append('target', target);
      form.append('firstIndex', String(firstIndex));
      added.forEach((file) => form.append('files', file));
      const res = await fetch('/api/paperwork/add', { method: 'POST', body: form });
      const body = await res.json() as { documents: AnalyzedDocument[]; documentsReceipt: string; cards: PaperworkCard[]; unreadable: SkippedFile[]; duplicates: SkippedFile[]; warnings: string[]; error?: string };
      if (!res.ok) throw new Error(body.error || 'The document could not be added.');
      setUpload({ documents: body.documents, receipt: body.documentsReceipt, warnings: upload.warnings });
      setCards(mergeCards(body.cards));
      setSkipped((current) => ({ unreadable: [...current.unreadable, ...body.unreadable], duplicates: [...current.duplicates, ...body.duplicates] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  }

  function updateCard(id: string, patch: Partial<Pick<Card, 'edits' | 'note'>>) {
    setCards((current) => current.map((card) => (card.id === id ? { ...card, ...patch } : card)));
  }

  async function send(card: Card): Promise<boolean> {
    const live = liveValidation(card);
    const setSent = (sent: Sent | undefined) => setCards((current) => current.map((c) => (c.id === card.id ? { ...c, sent } : c)));
    setSent({ state: 'sending', message: 'Sending…' });
    try {
      const form = new FormData();
      form.append('payload', JSON.stringify({
        invoiceNumber: card.edits.invoiceNumber,
        referenceNumber: card.edits.referenceNumber || null,
        invoiceAmount: card.edits.invoiceAmount,
        invoiceDate: card.edits.invoiceDate,
        debtorId: card.debtor?.id,
        analysisReceipt: card.analysisReceipt,
        explanation: live.status === 'PASS' ? null : card.note.trim(),
      }));
      // Files go in the card's order: the server matches each one to what was read.
      card.documentIndexes.forEach((i) => form.append('files', files[upload!.documents[i].sourceIndex ?? i]));
      const res = await fetch('/api/create', { method: 'POST', body: form });
      const body = await res.json() as CreateResponse & { needsExplanation?: boolean };
      if (body.needsExplanation && body.validation) {
        // The server found something the page couldn't check (for example a possible duplicate).
        // Show its reasons and ask for a note instead of just failing.
        setCards((current) => current.map((c) => (c.id === card.id ? { ...c, serverFlags: body.validation, sent: undefined } : c)));
        return false;
      }
      if (!res.ok || !body.ok) throw new Error(body.error || 'Sending failed.');
      const review = body.validation?.status === 'REVIEW';
      setSent({ state: 'sent', message: review ? 'Sent for review with your note' : 'Sent', invoiceId: body.invoiceId ?? undefined, review });
      return true;
    } catch (err) {
      setSent({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  async function sendReady() {
    setBusy('sending');
    for (const card of cards.filter((c) => cardState(c) === 'ready')) await send(card);
    setBusy('');
  }

  const states = cards.map(cardState);
  const readyCount = states.filter((s) => s === 'ready').length;
  const noteCount = states.filter((s) => s === 'needs-note').length;
  const single = cards.length === 1 && !unassigned.length ? cards[0] : null;
  const theaterPhase: TheaterPhase = busy === 'reading' ? 'analyzing'
    : single ? (single.sent?.state === 'sending' ? 'submitting' : single.sent?.state === 'sent' ? 'submitted' : 'analyzed')
      : 'idle';
  const targets: Target[] = useMemo(() => cards.map((card) => ({ id: card.id, label: shortTitle(card) })), [cards]);
  const cardOfInvoice = (invoiceDoc: number) => cards.find((c) => c.documentIndexes.includes(invoiceDoc));
  const docUrl = (i: number) => urls[upload?.documents[i]?.sourceIndex ?? i];
  const docFile = (i: number) => files[upload?.documents[i]?.sourceIndex ?? i];

  return (
    <main className="shell portalToolShell sendShell">
      <PortalNav active="submit" />

      <section className="hero portalSubHero">
        <div>
          <span className="eyebrow">FactorCloud Client Portal</span>
          <h1>{asDriver ? 'Send in paperwork' : 'Submit invoices'}</h1>
          <p>{asDriver
            ? 'Snap or upload the invoice, BOL and signed POD. Doing several loads? Tap “Next load” between them. We sort and check everything before it goes to your factor.'
            : 'Upload one invoice with its paperwork, or a whole stack. We read every page, sort it into one invoice each, and check it before anything reaches FactorCloud.'}</p>
        </div>
      </section>

      {!upload ? <section className="card sendUpload">
        <label className="dropzone">
          <input type="file" multiple accept={ACCEPT} disabled={Boolean(busy)} onChange={(e) => { addFiles(Array.from(e.target.files ?? []), null); e.target.value = ''; }} />
          <strong>{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} added` : 'Drop invoices and paperwork here'}</strong>
          <span>One invoice or a whole stack. PDF or photos, up to 24 files.</span>
        </label>
        <div className="sendCameraRow">
          <CameraCapture load={load} count={photosThisLoad} disabled={Boolean(busy)} onCapture={(photo) => addFiles([photo], load)} />
          {photosThisLoad > 0 && <button type="button" className="nextLoadButton" disabled={Boolean(busy)} onClick={() => setLoad(load + 1)}>Next load ›</button>}
        </div>
        {files.length > 0 && <ul className="fileChips">
          {files.map((file, index) => <li key={`${file.name}-${index}`}>
            <span title={file.name}>{loads[index] != null ? `Load ${loads[index]} · ` : ''}{file.name}</span>
            <small>{file.size >= 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`}</small>
            <button type="button" aria-label={`Remove ${file.name}`} disabled={Boolean(busy)} onClick={() => removeFile(index)}>×</button>
          </li>)}
        </ul>}
        <button onClick={() => void read()} disabled={!files.length || Boolean(busy)}>{busy === 'reading' ? 'Reading and checking…' : 'Read and check'}</button>
      </section>
      : <section className="sendTopBar">
        <span>{files.length} file{files.length === 1 ? '' : 's'} read</span>
        <button className="secondaryLink" onClick={startOver} disabled={busy === 'sending'}>Start over</button>
      </section>}

      {error && <div className="attentionSummary fail"><strong>Something went wrong</strong><span>{error}</span></div>}

      <ProcessingTheater
        files={theaterPhase === 'analyzing' ? files : single ? single.documentIndexes.map((i) => docFile(i)) : []}
        phase={theaterPhase}
        analysis={single}
        validation={single ? liveValidation(single) : null}
        createResult={single?.sent?.state === 'sent' ? { ok: true, invoiceId: single.sent.invoiceId ?? null, documentIds: [], steps: [], validation: single.validation } : null}
      />

      {upload && <>
        <section className="sendSummary">
          <div>
            <strong>{cards.length} invoice{cards.length === 1 ? '' : 's'} found</strong>
            <span>{[readyCount && `${readyCount} ready`, noteCount && `${noteCount} need${noteCount === 1 ? 's' : ''} a note`, unassigned.length && `${unassigned.length} document${unassigned.length === 1 ? '' : 's'} to place`].filter(Boolean).join(' · ') || (sentAny ? 'All sent' : 'Nothing ready yet')}</span>
          </div>
          {(busy === 'checking' || busy === 'adding') && <span className="sendChecking">{busy === 'adding' ? 'Reading the new document…' : 'Re-checking…'}</span>}
          <button onClick={() => void sendReady()} disabled={!readyCount || Boolean(busy)}>{busy === 'sending' ? 'Sending…' : `Send ${readyCount} ready invoice${readyCount === 1 ? '' : 's'}`}</button>
        </section>
        {upload.warnings.map((w) => <div className="warning" key={w}>{w}</div>)}
        {(skipped.unreadable.length > 0 || skipped.duplicates.length > 0) && <section className="sendSkipped">
          {skipped.unreadable.map((f) => <p key={`u${f.fileIndex}`} className="unreadable"><b>Couldn't read {f.fileName}.</b> Retake the photo or upload a clearer copy with “+ Add a document” on its invoice.</p>)}
          {skipped.duplicates.map((f) => <p key={`d${f.fileIndex}`}><b>{f.fileName}</b> was uploaded twice, so we only used it once.</p>)}
        </section>}

        {unassigned.length > 0 && <section className="card sendTray">
          <h2>Which invoice is this for?</h2>
          <p>We couldn't tell where these go. Tap the right invoice.</p>
          <div className="docTiles">
            {unassigned.map((i) => {
              const suggested = (suggestions[i] ?? []).map(cardOfInvoice).filter((c): c is Card => Boolean(c));
              const others = targets.filter((t) => !suggested.some((s) => s.id === t.id));
              return <DocTile key={i} doc={upload.documents[i]} url={docUrl(i)} file={docFile(i)} onOpen={() => setPreview(i)}>
                <div className="tileChoices">
                  {suggested.map((c, n) => <button key={c.id} className={n === 0 ? 'choice primary' : 'choice'} disabled={Boolean(busy)} onClick={() => void move(i, c.id)}>{n === 0 ? `Goes with ${shortTitle(c)}` : shortTitle(c)}</button>)}
                  {others.map((t) => <button key={t.id} className="choice" disabled={Boolean(busy)} onClick={() => void move(i, t.id)}>{t.label}</button>)}
                  <button className="choice quiet" disabled={Boolean(busy)} onClick={() => void move(i, 'new')}>Its own invoice</button>
                  <button className="choice quiet" disabled={Boolean(busy)} onClick={() => void move(i, 'leave-out')}>Leave out</button>
                </div>
              </DocTile>;
            })}
          </div>
        </section>}

        <section className="sendCards">
          {cards.map((card) => <InvoiceCard
            key={card.id} card={card} documents={upload.documents} targets={targets} busy={Boolean(busy)} asDriver={asDriver}
            only={cards.length === 1} urlFor={docUrl} fileFor={docFile} onOpen={setPreview}
            onMove={move} onAdd={(added) => void addToCard(card.id, added)} onChange={(patch) => updateCard(card.id, patch)} onSend={() => void send(card)}
          />)}
        </section>

        {left.length > 0 && <section className="card sendLeft">
          <strong>Left out</strong>
          <div className="docTiles">
            {left.map((i) => <DocTile key={i} doc={upload.documents[i]} url={docUrl(i)} file={docFile(i)} onOpen={() => setPreview(i)}>
              <div className="tileChoices"><button className="choice quiet" disabled={Boolean(busy)} onClick={() => void move(i, 'unassigned')}>Put back</button></div>
            </DocTile>)}
          </div>
        </section>}

        {sentAny && <div className="portalWelcomeActions sendAfter">
          <a className="primaryLink" href={asDriver ? '/driver' : '/invoices'}>{asDriver ? 'Back to my invoices' : 'See all invoices'}</a>
          <button className="secondaryLink" onClick={startOver}>{asDriver ? 'Send more' : 'Submit more'}</button>
        </div>}
      </>}

      {preview != null && upload && <div className="docPreview" role="dialog" aria-modal="true" aria-label={upload.documents[preview].fileName} onClick={() => setPreview(null)}>
        <div className="docPreviewBox" onClick={(e) => e.stopPropagation()}>
          <header><strong>{DOC_LABEL[upload.documents[preview].fields.documentType] ?? 'Document'} · {upload.documents[preview].fileName}</strong><button onClick={() => setPreview(null)} aria-label="Close">×</button></header>
          {docFile(preview)?.type === 'application/pdf'
            ? <iframe src={docUrl(preview)} title={upload.documents[preview].fileName} />
            : <img src={docUrl(preview)} alt={upload.documents[preview].fileName} />}
        </div>
      </div>}
    </main>
  );
}

function InvoiceCard({ card, documents, targets, busy, asDriver, only, urlFor, fileFor, onOpen, onMove, onAdd, onChange, onSend }: {
  card: Card; documents: AnalyzedDocument[]; targets: Target[]; busy: boolean; asDriver: boolean; only: boolean;
  urlFor: (i: number) => string; fileFor: (i: number) => File; onOpen: (i: number) => void;
  onMove: (doc: number, target: string) => void; onAdd: (files: File[]) => void;
  onChange: (patch: Partial<Pick<Card, 'edits' | 'note'>>) => void; onSend: () => void;
}) {
  const [sorting, setSorting] = useState(false);
  const addInput = useRef<HTMLInputElement>(null);
  const live = liveValidation(card);
  const state = cardState(card);
  const flagged = flaggedChecks(live.checks);
  const blocked = hardBlocks(live);
  const sent = card.sent?.state === 'sent';
  const amount = Number(card.edits.invoiceAmount);
  const [tone, label] = sent ? (card.sent!.review ? ['review', 'Sent for review'] : ['pass', 'Sent'])
    : state === 'ready' ? ['pass', 'Ready'] : state === 'needs-note' ? ['review', 'Needs a note'] : ['fail', "Can't send yet"];
  const elsewhere = targets.filter((t) => t.id !== card.id);

  return <article className={`card sendCard ${sent ? 'sent' : state}`}>
    <header className="sendCardHead">
      <div>
        <strong>{cardTitle(card)}</strong>
        <span>{[card.debtor?.companyName ?? card.documents[0]?.fields.debtorName, card.edits.invoiceDate].filter(Boolean).join(' · ') || 'Details below'}</span>
      </div>
      <div className="sendCardRight">
        <span className={`pill ${tone}`}>{label}</span>
        <b>{Number.isFinite(amount) && amount > 0 ? `$${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '-'}</b>
      </div>
    </header>

    <div className="docTiles">
      {card.documentIndexes.map((i) => <DocTile key={i} doc={documents[i]} url={urlFor(i)} file={fileFor(i)} onOpen={() => onOpen(i)}>
        {sorting && !sent && <div className="tileChoices">
          {elsewhere.map((t) => <button key={t.id} className="choice" disabled={busy} onClick={() => onMove(i, t.id)}>Move to {t.label}</button>)}
          {card.documentIndexes.length > 1 && <button className="choice quiet" disabled={busy} onClick={() => onMove(i, 'new')}>Its own invoice</button>}
          <button className="choice quiet" disabled={busy} onClick={() => onMove(i, 'leave-out')}>Leave out</button>
        </div>}
      </DocTile>)}
    </div>

    {!sent && <div className="sendCardTools">
      <button type="button" className="linkButton" disabled={busy} onClick={() => addInput.current?.click()}>+ Add a document</button>
      <input ref={addInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { const picked = Array.from(e.target.files ?? []); e.target.value = ''; if (picked.length) onAdd(picked); }} />
      <button type="button" className="linkButton" disabled={busy} onClick={() => setSorting(!sorting)}>{sorting ? 'Done sorting' : only ? 'Remove a document' : 'Fix sorting'}</button>
    </div>}

    {card.warnings.map((w) => <div className="warning" key={w}>{w}</div>)}
    {!sent && (flagged.length
      ? <ul className="sendChecks">{flagged.map((c) => <li key={c.id} className={c.status.toLowerCase()}><b>{c.label}:</b> {c.message}</li>)}</ul>
      : state === 'ready' && <p className="sendClear">✓ All checks clear</p>)}

    {!sent && <details className="sendDetails">
      <summary>Invoice details</summary>
      <div className="editGrid">
        <Field label="Invoice #" value={card.edits.invoiceNumber} onChange={(v) => onChange({ edits: { ...card.edits, invoiceNumber: v } })} />
        <Field label="Load #" value={card.edits.referenceNumber} onChange={(v) => onChange({ edits: { ...card.edits, referenceNumber: v } })} />
        <Field label="Amount" type="number" value={card.edits.invoiceAmount} onChange={(v) => onChange({ edits: { ...card.edits, invoiceAmount: v } })} />
        <Field label="Invoice date" type="date" value={card.edits.invoiceDate} onChange={(v) => onChange({ edits: { ...card.edits, invoiceDate: v } })} />
      </div>
      {card.debtor && <p className="match">Debtor: <strong>{card.debtor.companyName}</strong>{card.debtorMatch ? ` (matched by ${card.debtorMatch.method})` : ''}</p>}
    </details>}

    {!sent && !blocked.length && flagged.length > 0 && card.debtor && <SubmitAnywayBox compact flagged={flagged} blocked={[]} value={card.note} onChange={(note) => onChange({ note })} />}
    {!sent && blocked.length > 0 && <SubmitAnywayBox flagged={[]} blocked={blocked} value="" onChange={() => {}} />}

    <footer className="sendCardFoot">
      {card.sent && <span className={`rowResult ${card.sent.state === 'sent' ? 'created' : card.sent.state}`}>{card.sent.message}{card.sent.invoiceId && !asDriver ? <> · <a href={`/invoices/${encodeURIComponent(card.sent.invoiceId)}`}>view</a></> : null}</span>}
      {!sent && <button className="small" disabled={busy || card.sent?.state === 'sending' || (state !== 'ready' && state !== 'needs-note') || (state === 'needs-note' && Boolean(explanationProblem(card.note)))} onClick={onSend}>
        {card.sent?.state === 'sending' ? 'Sending…' : state === 'needs-note' ? 'Send with my note' : 'Send this invoice'}
      </button>}
    </footer>
  </article>;
}

/** A document as a thumbnail: the photo itself, or a page icon for a PDF. Tap to see it full size. */
function DocTile({ doc, url, file, onOpen, children }: { doc: AnalyzedDocument; url: string; file: File | undefined; onOpen: () => void; children?: React.ReactNode }) {
  const isPdf = file?.type === 'application/pdf';
  return <div className="docTile">
    <button type="button" className="docThumb" onClick={onOpen} aria-label={`View ${doc.fileName}`}>
      {isPdf || !url ? <span className="docThumbPdf" aria-hidden="true">PDF</span> : <img src={url} alt="" />}
      <span className={`docType ${doc.fields.documentType}`}>{DOC_LABEL[doc.fields.documentType] ?? 'Other'}</span>
    </button>
    <div className="docTileText">
      <strong title={doc.fileName}>{doc.fileName}</strong>
      <small>{doc.fields.referenceNumber ? `Load ${doc.fields.referenceNumber}` : 'No load # found'}</small>
    </div>
    {children}
  </div>;
}

function Field({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return <label className="field"><span>{label}</span><input type={type} value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}

function withEdits(card: PaperworkCard): Card {
  const f = card.documents[card.primaryIndex]?.fields;
  return {
    ...card,
    note: '',
    edits: {
      invoiceNumber: f?.invoiceNumber ?? '',
      referenceNumber: f?.referenceNumber ?? '',
      invoiceAmount: f?.invoiceAmount == null ? '' : String(f.invoiceAmount),
      invoiceDate: f?.invoiceDate ?? '',
    },
  };
}

function cardTitle(card: Card): string {
  const invoice = card.edits.invoiceNumber || card.documents[card.primaryIndex]?.fields.invoiceNumber;
  const loadNo = card.edits.referenceNumber;
  return [invoice ? `Invoice ${invoice}` : 'No invoice yet', loadNo && `load ${loadNo}`].filter(Boolean).join(', ');
}

function shortTitle(card: Card): string {
  const invoice = card.edits.invoiceNumber || card.documents[card.primaryIndex]?.fields.invoiceNumber;
  return invoice ? `Invoice ${invoice}` : card.edits.referenceNumber ? `Load ${card.edits.referenceNumber}` : 'New invoice';
}

/** The card's checks, re-run in the browser with whatever the person typed. The server re-runs them on send. */
function liveValidation(card: Card): ValidationReport {
  const original = card.documents[card.primaryIndex]?.fields;
  if (!original) return card.validation;
  const amount = card.edits.invoiceAmount === '' ? null : Number(card.edits.invoiceAmount);
  const fields = { ...original, invoiceNumber: card.edits.invoiceNumber || null, referenceNumber: card.edits.referenceNumber || null, invoiceAmount: amount, invoiceDate: card.edits.invoiceDate || null };
  const documents = card.documents.map((doc, i) => (i === card.primaryIndex ? { ...doc, fields } : doc));
  const base = applyFactorCloudAvailability(validate({ documents, primaryIndex: card.primaryIndex, debtor: card.debtor, client: card.client }), card.factorCloudLookupFailed);
  const changed = [
    (original.invoiceNumber ?? '') !== card.edits.invoiceNumber && 'invoice number',
    (original.referenceNumber ?? '') !== card.edits.referenceNumber && 'load number',
    (original.invoiceAmount == null ? '' : String(original.invoiceAmount)) !== card.edits.invoiceAmount && 'amount',
    (original.invoiceDate ?? '') !== card.edits.invoiceDate && 'invoice date',
  ].filter(Boolean) as string[];
  const merged = mergeServerFlags(base, card.serverFlags);
  if (!changed.length) return merged;
  const note = { id: 'client-corrections', label: 'Changed after reading', status: 'REVIEW' as const, message: `You changed the ${changed.join(', ')}. Your factor will review it.` };
  return { status: merged.status === 'FAIL' ? 'FAIL' : 'REVIEW', checks: [note, ...merged.checks] };
}

/** Adds checks the server flagged on a send attempt that the page's own checks don't cover. */
function mergeServerFlags(base: ValidationReport, server: ValidationReport | undefined): ValidationReport {
  if (!server) return base;
  const extra = server.checks.filter((c) => (c.status === 'REVIEW' || c.status === 'FAIL') && c.id !== 'client-corrections' && !base.checks.some((b) => b.id === c.id && b.status === c.status));
  if (!extra.length) return base;
  const checks = [...extra, ...base.checks.filter((b) => !extra.some((e) => e.id === b.id))];
  return { status: checks.some((c) => c.status === 'FAIL') ? 'FAIL' : 'REVIEW', checks };
}

function cardState(card: Card): 'ready' | 'needs-note' | 'blocked' | 'sent' {
  if (card.sent?.state === 'sent') return 'sent';
  const live = liveValidation(card);
  const hasBasics = Boolean(card.edits.invoiceNumber && Number(card.edits.invoiceAmount) > 0 && card.edits.invoiceDate);
  if (!card.debtor || !card.analysisReceipt || card.factorCloudLookupFailed || !hasBasics || hardBlocks(live).length) return 'blocked';
  return live.status === 'PASS' ? 'ready' : 'needs-note';
}
