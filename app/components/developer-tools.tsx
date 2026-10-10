"use client";
import { setDevMode, useDevMode } from "./dev-mode";

export default function DeveloperTools() {
  const enabled = useDevMode();
  return <section className="search-panel developer-tools" aria-labelledby="developer-tools-title">
    <div className="card-heading"><div><span className="eyebrow">DEVELOPERS ONLY</span><h2 id="developer-tools-title">Developer tools</h2></div><span className={`tag ${enabled ? "tag-warn" : ""}`}>{enabled ? "On in this browser" : "Off"}</span></div>
    <label className="dev-switch">
      <input type="checkbox" role="switch" checked={enabled} onChange={(event) => setDevMode(event.target.checked)} aria-describedby="dev-switch-help" />
      <span className="dev-switch-track" aria-hidden="true"><span /></span>
      <span>Show raw API responses in the workspace</span>
    </label>
    <p id="dev-switch-help">Adds prediction, user lookup and Global Context JSON panels, raw record JSON, internal IDs, raw model scores and the JSON download. It is off by default and only applies to this browser. It is a display setting, not access control: the API still returns the same data.</p>
  </section>;
}
