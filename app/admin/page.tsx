"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { SharedSettings } from "@/lib/admin-types";
import { INTEGRATIONS } from "@/lib/integrations";
import { GLOBAL_CONTEXT_CATALOG } from "@/lib/global-context-catalog";
import PredictionAdmin from "../components/prediction-admin";
import ExperimentReportPanel from "../components/experiment-report";
import DeveloperTools from "../components/developer-tools";
import AppShell from "../components/app-shell";

const emptySettings: SharedSettings = { employeeId: "", notes: "", metadata: {}, hasToken: false, updatedAt: null };

export default function AdminPage() {
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [settings, setSettings] = useState<SharedSettings>(emptySettings);
  const [employeeId, setEmployeeId] = useState("");
  const [token, setToken] = useState("");
  const [notes, setNotes] = useState("");
  const [metadata, setMetadata] = useState("{}");
  const [clearToken, setClearToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  function applySettings(value: SharedSettings) {
    setSettings(value); setEmployeeId(value.employeeId); setNotes(value.notes);
    setMetadata(JSON.stringify(value.metadata, null, 2)); setToken(""); setClearToken(false);
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await fetch("/api/admin/session", { cache: "no-store" });
        const session = await response.json();
        if (!response.ok) throw new Error(session.error);
        if (!active) return;
        setConfigured(session.configured); setAuthenticated(session.authenticated);
        if (session.authenticated) {
          const response = await fetch("/api/admin/settings", { cache: "no-store" });
          const settings = await response.json();
          if (!response.ok) throw new Error(settings.error);
          if (active) applySettings(settings);
        }
      } catch (error) { if (active) setError(error instanceof Error ? error.message : "Could not load admin settings."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, []);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setMessage("");
    if (!configured && password !== confirmation) { setError("The passwords do not match."); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/admin/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: configured ? "login" : "setup", password }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setPassword(""); setConfirmation(""); setConfigured(true); setAuthenticated(true);
      const settingsResponse = await fetch("/api/admin/settings", { cache: "no-store" });
      const saved = await settingsResponse.json();
      if (!settingsResponse.ok) throw new Error(saved.error);
      applySettings(saved);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not sign in."); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setMessage("");
    let extra;
    try {
      extra = JSON.parse(metadata);
      if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error();
    } catch { setError("Extra data must be a valid JSON object, such as { \"region\": \"north\" }."); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employeeId: employeeId.trim(), token, notes, metadata: extra, clearToken }) });
      const body = await response.json();
      if (response.status === 401) setAuthenticated(false);
      if (!response.ok) throw new Error(body.error);
      applySettings(body); setMessage("Shared settings saved.");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save settings."); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/session", { method: "DELETE" });
      if (!response.ok) throw new Error("Could not sign out.");
      setAuthenticated(false); setPassword(""); setMessage(""); applySettings(emptySettings);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not sign out."); }
    finally { setBusy(false); }
  }

  return <AppShell active="admin" title="Admin" actions={authenticated ? <button type="button" className="btn btn-secondary" onClick={signOut} disabled={busy}>Sign out</button> : null}>
    <div className="admin-content">
      <p className="page-lede">Review measured model results, set calling rules, and manage shared integrations.</p>
      {authenticated&&<><ExperimentReportPanel/><PredictionAdmin/></>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {message && <div className="alert admin-success" role="status">{message}</div>}
      {loading ? <div className="empty-state" role="status">Loading admin panel…</div> : !authenticated ? <form className="search-panel admin-login" onSubmit={signIn}>
        <h2>{configured ? "Admin sign in" : "Set up admin access"}</h2><p>{configured ? "Enter your admin password to manage the shared settings." : "Create a password with at least 12 characters. You only need to do this once."}</p>
        <div className="admin-field"><label htmlFor="password">{configured ? "Password" : "New password"}</label><input id="password" type="password" autoComplete={configured ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={configured ? undefined : 12} maxLength={1024} required disabled={busy} /></div>
        {!configured && <div className="admin-field"><label htmlFor="confirmation">Confirm password</label><input id="confirmation" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required disabled={busy} /></div>}
        <button disabled={busy}>{busy ? "Please wait…" : configured ? "Sign in →" : "Create admin access →"}</button>
      </form> : <form className="search-panel admin-settings" onSubmit={save}>
        <div className="card-heading"><div><h2>One shared credential</h2><p>Global Context uses this token and employee ID for each GLID lookup.</p></div><span className="tag">{settings.hasToken ? "Token saved" : "No token saved"}</span></div>
        <div className="admin-field"><label htmlFor="employee-id">Employee ID</label><input id="employee-id" inputMode="numeric" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} placeholder="e.g. 12345" pattern="[1-9][0-9]*" maxLength={19} required disabled={busy} /><small>The employee associated with this token.</small></div>
        <div className="admin-field"><label htmlFor="shared-token">JWT / API token</label><input id="shared-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder={settings.hasToken ? "•••••••• — leave blank to keep saved token" : "Paste the token without a Bearer prefix"} maxLength={16384} disabled={busy || clearToken} /><small>The saved token is encrypted and never sent back to the browser.</small></div>
        {settings.hasToken && <label className="admin-checkbox"><input type="checkbox" checked={clearToken} disabled={busy} onChange={(event) => { setClearToken(event.target.checked); if (event.target.checked) setToken(""); }} />Remove the saved token when saving</label>}
        <div className="admin-field"><label htmlFor="extra-data">Extra data (JSON)</label><textarea id="extra-data" className="json-input" value={metadata} onChange={(event) => setMetadata(event.target.value)} rows={8} placeholder={'{\n  "region": "north",\n  "department": "sales"\n}'} maxLength={32000} disabled={busy} spellCheck={false} /><small>Add configuration such as region, department, service URLs, or other settings.</small></div>
        <div className="admin-field"><label htmlFor="notes">Notes</label><textarea id="notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} maxLength={4000} disabled={busy} placeholder="Optional context about this token or employee mapping" /></div>
        <div className="admin-footer"><button disabled={busy}>{busy ? "Saving…" : "Save settings"}</button><small>{settings.updatedAt ? `Last saved ${new Date(settings.updatedAt).toLocaleString("en-IN")}` : "Settings have not been saved yet."}</small></div>
        <section className="integration-list"><h3>API list</h3>{INTEGRATIONS.map((api) => <div key={api.route}><strong>{api.name}</strong><code>POST {api.route}</code><p>{api.description}</p></div>)}
          <p className="muted">Global Context: generateContextUID → x/getContext. Requested segments: {GLOBAL_CONTEXT_CATALOG.map((segment) => segment.key).join(", ")}.</p>
        </section>
      </form>}
      {authenticated && <DeveloperTools />}
    </div>
  </AppShell>;
}
