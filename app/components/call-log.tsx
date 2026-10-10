"use client";

import { useSyncExternalStore } from "react";
import type { Sentiment } from "@/lib/recording-types";

// Call outcomes a rep records while working the queue. The backend has no write API for call
// outcomes or follow-ups, so these entries live only in this browser and are labelled as such.
export type LoggedOutcome = "answered" | "no_answer" | "meeting_booked" | "callback" | "not_interested";
export type CallLogEntry = {
  id: string; glid: string; at: string; outcome: LoggedOutcome; note: string; followUpAt: string | null;
  /** AI retry plan made when the call was logged as unsuccessful. */
  retry?: { status: string; call_at: string | null; window: string | null; reason: string; source: "llm" | "rules"; model: string | null; sentiment: Sentiment | null; score: number | null };
};

export const OUTCOMES: { key: LoggedOutcome; label: string; tone: "good" | "warn" | "bad" | "neutral" }[] = [
  { key: "answered", label: "Answered", tone: "good" },
  { key: "meeting_booked", label: "Meeting booked", tone: "good" },
  { key: "callback", label: "Asked to call back", tone: "warn" },
  { key: "no_answer", label: "No answer", tone: "warn" },
  { key: "not_interested", label: "Not interested", tone: "bad" },
];

const KEY = "callwise.callLog.v1", EVENT = "callwise-call-log";
const EMPTY: CallLogEntry[] = [];
let cache: { raw: string | null; value: CallLogEntry[] } = { raw: null, value: EMPTY };

function read(): CallLogEntry[] {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(KEY); } catch { return EMPTY; }
  if (raw === cache.raw) return cache.value;
  let value: CallLogEntry[] = EMPTY;
  try { const parsed = raw ? JSON.parse(raw) : []; if (Array.isArray(parsed)) value = parsed; } catch { /* corrupt entry: start empty */ }
  cache = { raw, value };
  return value;
}

function write(entries: CallLogEntry[]) {
  try { window.localStorage.setItem(KEY, JSON.stringify(entries.slice(-500))); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void) {
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) onChange(); };
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, onChange);
  return () => { window.removeEventListener("storage", onStorage); window.removeEventListener(EVENT, onChange); };
}

export function useCallLog(): CallLogEntry[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function logCall(entry: Omit<CallLogEntry, "id" | "at">): CallLogEntry {
  const full: CallLogEntry = { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString() };
  write([...read(), full]);
  return full;
}

export function removeLogEntry(id: string) {
  write(read().filter(e => e.id !== id));
}

export function outcomeMeta(key: LoggedOutcome) {
  return OUTCOMES.find(o => o.key === key)!;
}

/** GLIDs with an entry logged today (local calendar day). */
export function loggedToday(entries: CallLogEntry[], now = Date.now()): Map<string, CallLogEntry> {
  const today = new Date(now).toDateString();
  const map = new Map<string, CallLogEntry>();
  for (const e of entries) if (new Date(e.at).toDateString() === today) map.set(e.glid, e);
  return map;
}
