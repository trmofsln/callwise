"use client";

import { useSyncExternalStore } from "react";
import type { AiRetryPlan } from "@/lib/retry-planner";

// The latest post-call AI retry plan per seller in this browser tab, so the retry execution flow
// can show the real result of "Plan retry with AI" without calling the API again.
let plans: Record<string, AiRetryPlan> = {};
const listeners = new Set<() => void>();

export function rememberRetryPlan(plan: AiRetryPlan) {
  plans = { ...plans, [plan.glid]: plan };
  listeners.forEach(l => l());
}

export function useRetryPlans(): Record<string, AiRetryPlan> {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => plans, () => plans);
}
