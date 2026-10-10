import { useState } from "react";
import Link from "next/link";
import { DevJson, useDevMode } from "./dev-mode";
import { findContextSegment, GLOBAL_CONTEXT_CATALOG, parseContextValue, type GlobalContextResult } from "@/lib/global-context-catalog";

function fields(value: unknown, prefix = "", depth = 0): { key: string; value: string }[] {
  const parsed = parseContextValue(value);
  if (parsed === null || parsed === undefined) return [{ key: prefix || "value", value: "Not available" }];
  if (typeof parsed !== "object") return [{ key: prefix || "value", value: String(parsed) }];
  if (depth >= 12) return [{ key: prefix || "value", value: JSON.stringify(parsed) }];
  const entries = Object.entries(parsed);
  if (!entries.length) return [{ key: prefix || "value", value: Array.isArray(parsed) ? "No records" : "No fields" }];
  return entries.flatMap(([key, child]) => fields(child, Array.isArray(parsed) ? `${prefix}[${key}]` : prefix ? `${prefix}.${key}` : key, depth + 1));
}

function Segment({ name, label, value, documentedKeys }: { name: string; label: string; value: unknown; documentedKeys: readonly string[] }) {
  const [all, setAll] = useState(false);
  const available = value !== undefined;
  const rows = available ? fields(value) : [];
  return <details className="context-segment"><summary><span>{label}</span><span className={`context-status ${available ? "available" : ""}`}>{available ? `${rows.length} fields` : "Not returned"}</span></summary>
    <small className="context-key">{name}</small>
    {available ? <><dl className="context-fields">{(all ? rows : rows.slice(0, 30)).map((row) => <div key={row.key}><dt>{row.key}</dt><dd>{row.value}</dd></div>)}</dl>
      {rows.length > 30 && <button type="button" className="secondary" onClick={() => setAll(!all)}>{all ? "Show first 30 fields" : `Show all ${rows.length} fields`}</button>}
    </> : <p className="muted">The API did not return this segment for this GLID.</p>}
    {documentedKeys.length > 0 && <details className="context-key-list"><summary>Keys listed in the master sheet ({documentedKeys.length})</summary><p>{documentedKeys.join(", ")}</p></details>}
  </details>;
}

export default function GlobalContextSection({ context }: { context: GlobalContextResult | undefined }) {
  const dev = useDevMode();
  if (!context) return null;
  return <section className="card-section global-context-section">
    <div className="card-heading"><h3>Global Context</h3><span className="tag">7 segments requested</span></div>
    {context.status !== "success" ? <div className="alert">{context.error || "Global Context is unavailable."}{context.status === "not_configured" && <> <Link href="/admin">Configure in Admin →</Link></>}</div> : <>
      <p className="source-note">All returned keys are available below. Missing segments are shown explicitly.{dev && <> Mapping ID: <code>{context.mappingId}</code></>}</p>
      {context.error && <div className="alert">{context.error}</div>}
      {GLOBAL_CONTEXT_CATALOG.map((segment) => <Segment key={segment.key} name={segment.key} label={segment.label} documentedKeys={segment.keys} value={findContextSegment(context.data, segment.key)} />)}
      <DevJson className="context-raw" label="Global Context API response" data={context.response} />
    </>}
  </section>;
}
