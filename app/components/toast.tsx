"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Toast = { id: number; message: string; tone: "success" | "info" | "error"; action?: { label: string; run: () => void } };
const ToastContext = createContext<(toast: Omit<Toast, "id">) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts(list => [...list.slice(-2), { ...toast, id }]);
    setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), 5000);
  }, []);
  return <ToastContext.Provider value={push}>
    {children}
    <div className="toast-region" role="status" aria-live="polite">
      {toasts.map(t => <div key={t.id} className={`toast toast-${t.tone}`}>
        <span>{t.message}</span>
        {t.action && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { t.action!.run(); setToasts(list => list.filter(x => x.id !== t.id)); }}>{t.action.label}</button>}
      </div>)}
    </div>
  </ToastContext.Provider>;
}

export function useToast() {
  return useContext(ToastContext);
}
