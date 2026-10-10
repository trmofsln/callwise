"use client";

import { useSyncExternalStore } from "react";

// Per-browser developer view preference, switched from the Admin page. It only controls
// whether raw API responses are rendered in the workspace; it is not an access control.
const KEY = "callwise.devMode";
const EVENT = "callwise-dev-mode";

function read(): boolean {
  try { return window.localStorage.getItem(KEY) === "1"; } catch { return false; }
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === KEY) onChange(); };
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, onChange);
  return () => { window.removeEventListener("storage", onStorage); window.removeEventListener(EVENT, onChange); };
}

export function useDevMode(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}

export function setDevMode(enabled: boolean) {
  try {
    if (enabled) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch { /* storage unavailable: preference stays off */ }
  window.dispatchEvent(new Event(EVENT));
}

/** Raw API response viewer, rendered only when developer mode is on. */
export function DevJson({ label, data, className }: { label: string; data: unknown; className?: string }) {
  const enabled = useDevMode();
  if (!enabled) return null;
  return <details className={`dev-json ${className ?? ""}`}><summary><span className="dev-badge">DEV</span>{label}</summary><pre>{JSON.stringify(data, null, 2)}</pre></details>;
}
