'use client';

import { useState } from 'react';

const checks = [
  ['Debtor found in FactorCloud', 'Ready'],
  ['Company name match', 'Ready'],
  ['Address match', 'Ready'],
  ['Phone match', 'Ready'],
  ['Reference matches across documents', 'Ready'],
  ['Amount matches across documents', 'Ready'],
];

export default function Home() {
  const [fileName, setFileName] = useState<string>('');

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <span className="eyebrow">FactorCloud Labs</span>
          <h1>Invoice Intake + Validation</h1>
          <p>Upload invoice paperwork, extract key fields, validate against FactorCloud, then create the invoice without retyping it.</p>
        </div>
        <span className="prototype">Prototype</span>
      </section>

      <section className="grid">
        <div className="card uploadCard">
          <div className="step">1</div>
          <h2>Upload documents</h2>
          <p>Start with an invoice PDF. Supporting documents will be added next.</p>
          <label className="dropzone">
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => setFileName(e.target.files?.[0]?.name ?? '')}
            />
            <strong>{fileName || 'Drop an invoice PDF here'}</strong>
            <span>{fileName ? 'Ready to analyze' : 'or click to choose a file'}</span>
          </label>
          <button disabled={!fileName}>Analyze invoice</button>
        </div>

        <div className="card">
          <div className="step">2</div>
          <h2>Extracted invoice</h2>
          <dl className="fields">
            <div><dt>Invoice #</dt><dd>Waiting for document</dd></div>
            <div><dt>Reference</dt><dd>Waiting for document</dd></div>
            <div><dt>Debtor</dt><dd>Waiting for document</dd></div>
            <div><dt>Amount</dt><dd>Waiting for document</dd></div>
            <div><dt>Invoice date</dt><dd>Waiting for document</dd></div>
            <div><dt>Due date</dt><dd>Waiting for document</dd></div>
          </dl>
        </div>

        <div className="card validationCard">
          <div className="step">3</div>
          <div className="validationHeader">
            <div>
              <h2>Validation</h2>
              <p>Rules will run against FactorCloud and across uploaded documents.</p>
            </div>
            <span className="status neutral">Not run</span>
          </div>
          <div className="checks">
            {checks.map(([label, status]) => (
              <div className="check" key={label}>
                <span>{label}</span>
                <span className="muted">{status}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card actionCard">
          <div className="step">4</div>
          <h2>Create in FactorCloud</h2>
          <p>After review, the app will create the invoice, upload the source documents, and attach them through the API.</p>
          <button className="secondary" disabled>Create invoice</button>
        </div>
      </section>
    </main>
  );
}
