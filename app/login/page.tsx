'use client';

import { FormEvent, useState } from 'react';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/portal-auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Sign in failed.');
      window.location.href = body.redirectTo || '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return <main className="portalLoginPage">
    <section className="portalLoginCard">
      <img className="portalLoginLogo" src="https://www.factorcloud.com/images/logo-nav.svg" alt="FactorCloud" />
      <div className="portalLoginCopy">
        <span>Secure portal</span>
        <h1>Sign in</h1>
        <p>Use the account provided by your factoring company.</p>
      </div>
      <form onSubmit={submit} className="portalLoginForm">
        <label><span>Email</span><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <div className="portalLoginError">{error}</div>}
        <button type="submit" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
      </form>
      <small>Factor users are directed to operations. Client users are directed to their assigned client portal.</small>
    </section>
  </main>;
}
