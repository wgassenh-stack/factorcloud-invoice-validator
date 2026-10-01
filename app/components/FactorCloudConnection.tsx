'use client';

import { useEffect, useState } from 'react';
import styles from './FactorCloudConnection.module.css';

type Status = {
  demo?: boolean;
  connected: { expiresAt: string | null; connectedBy: string | null; connectedAt: string } | null;
  setting: { expiresAt: string | null } | null;
  canReconnect: boolean;
  needsLogin: boolean;
};

const DAY = 86_400_000;

function when(iso: string) {
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/** How long a token has left, in words, and how worried to be about it. */
function remaining(expiresAt: string | null): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!expiresAt) return { text: 'Expiry not known', tone: 'ok' };
  const left = new Date(expiresAt).getTime() - Date.now();
  if (left <= 0) return { text: `Expired ${when(expiresAt)}`, tone: 'bad' };
  const hours = Math.round(left / 3_600_000);
  const text = `Good until ${when(expiresAt)} (${hours < 48 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${Math.round(left / DAY)} days`} left)`;
  return { text, tone: left < 3 * DAY ? 'warn' : 'ok' };
}

/**
 * Diagnostics → FactorCloud connection. Shows when the portal's FactorCloud access runs out, and lets
 * a factor admin renew it: sign in to FactorCloud, enter the emailed code, done. No redeploy.
 */
export function FactorCloudConnection({ onConnected }: { onConnected?: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [step, setStep] = useState<'idle' | 'login' | 'code'>('idle');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    let alive = true;
    fetch('/api/ops/factorcloud-connection', { cache: 'no-store' })
      .then(async (res) => { if (res.ok && alive) setStatus(await res.json()); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!status) return null; // client logins and setups without factor access see nothing here

  async function send(body: Record<string, string>) {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/ops/factorcloud-connection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'That did not work. Try again.');
      return out;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const login: Record<string, string> = status.needsLogin ? { username, password } : {};
  async function start() {
    if (await send({ step: 'start', ...login })) setStep('code');
  }
  async function verify() {
    const out = await send({ step: 'verify', code, ...login });
    if (!out) return;
    setStatus(out); setStep('idle'); setCode(''); setPassword('');
    setDone('Connected. The portal is using the new FactorCloud access now.');
    onConnected?.();
  }

  const active = status.connected ?? (status.setting ? { expiresAt: status.setting.expiresAt, connectedBy: null, connectedAt: null } : null);
  const left = active ? remaining(active.expiresAt) : null;

  return <section className={`dashCard ${styles.panel}`} id="factorcloud-connection">
    <div className="dashCardBody">
      <div className={styles.status}>
        <div>
          <strong>FactorCloud connection</strong>
          {active && left
            ? <p><span className={styles[left.tone]}>{left.text}</span>{status.connected?.connectedBy ? ` · connected by ${status.connected.connectedBy} on ${when(status.connected.connectedAt)}` : status.connected ? '' : ' · from the deployment settings'}</p>
            : <p className={styles.bad}>Not connected.</p>}
        </div>
        {status.canReconnect && step === 'idle' && <button className="primaryLink" onClick={() => { setDone(''); setError(''); if (status.needsLogin) setStep('login'); else void start(); }} disabled={busy}>Reconnect FactorCloud</button>}
      </div>
      {!status.canReconnect && !status.demo && <p className={styles.note}>Only a factor admin can reconnect FactorCloud.</p>}
      {done && <p className={styles.done}>{done}</p>}
      {step === 'idle' && error && <p className={styles.error}>{error}</p>}

      {step === 'login' && <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <label>FactorCloud username<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /><small>Used to sign in this once. It isn&apos;t stored.</small></label>
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.row}><button className="primaryLink" type="submit" disabled={busy || !username || !password}>{busy ? 'Sending…' : 'Email me a code'}</button><button className="secondaryLink" type="button" onClick={() => setStep('idle')} disabled={busy}>Cancel</button></div>
      </form>}

      {step === 'code' && <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void verify(); }}>
        <label>Code from the FactorCloud email<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required /></label>
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.row}><button className="primaryLink" type="submit" disabled={busy || !code.trim()}>{busy ? 'Connecting…' : 'Connect'}</button><button className="secondaryLink" type="button" onClick={() => { setStep('idle'); setCode(''); }} disabled={busy}>Cancel</button></div>
      </form>}
    </div>
  </section>;
}
