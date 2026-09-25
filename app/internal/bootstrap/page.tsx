'use client';

import { useState } from 'react';

export default function BootstrapPage() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>('');

  async function initialize() {
    setBusy(true);
    setResult('Initializing database...');
    try {
      const response = await fetch('/api/internal/bootstrap', { method: 'POST' });
      const body = await response.json();
      setResult(JSON.stringify(body, null, 2));
    } catch (error) {
      setResult(error instanceof Error ? error.message : 'Bootstrap failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', background: '#f4f6f8', padding: '48px 24px', fontFamily: 'Arial, sans-serif' }}>
      <section style={{ maxWidth: 720, margin: '0 auto', background: '#fff', border: '1px solid #dfe3e8', borderRadius: 14, padding: 32 }}>
        <h1 style={{ marginTop: 0 }}>Initialize portal database</h1>
        <p>
          Temporary development setup for the FactorCloud portal. This creates the portal tables, Client 001,
          the factor admin user, and the client user using the environment variables already configured in Vercel.
        </p>
        <button
          type="button"
          onClick={initialize}
          disabled={busy}
          style={{ background: '#111827', color: '#fff', border: 0, borderRadius: 8, padding: '12px 18px', cursor: busy ? 'default' : 'pointer', fontWeight: 700 }}
        >
          {busy ? 'Initializing...' : 'Initialize database'}
        </button>
        {result ? (
          <pre style={{ marginTop: 24, padding: 16, background: '#111827', color: '#e5e7eb', borderRadius: 8, overflowX: 'auto', whiteSpace: 'pre-wrap' }}>{result}</pre>
        ) : null}
      </section>
    </main>
  );
}
