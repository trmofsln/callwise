"use client";

import { useState, type FormEvent } from "react";
import Icon from "../components/workspace-icon";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/site-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setError(body.error ?? "Could not sign in."); return; }
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
    } catch { setError("Could not reach the server."); }
    finally { setBusy(false); }
  }

  return <main className="site-login">
    <form className="search-panel admin-login" onSubmit={signIn}>
      <span className="brand"><span className="brand-mark"><Icon name="phone" size={16} /></span><span>Callwise</span></span>
      <h2>Sign in</h2>
      <p>Enter the site password to plan calls.</p>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="admin-field"><label htmlFor="site-password">Password</label><input id="site-password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} maxLength={1024} required disabled={busy} /></div>
      <button className="btn btn-primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  </main>;
}
