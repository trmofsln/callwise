"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import Icon from "./workspace-icon";
import { useDevMode } from "./dev-mode";
import { ToastProvider } from "./toast";

/** Shared chrome: a compact left sidebar on desktop, a top bar on small screens. */
export default function AppShell({ active, title, actions, children }: { active: "queue" | "admin"; title: string; actions?: ReactNode; children: ReactNode }) {
  const dev = useDevMode();
  const nav = [
    { key: "queue", href: "/", label: "Call queue", icon: "list" as const },
    { key: "admin", href: "/admin", label: "Admin", icon: "settings" as const },
  ];
  return <ToastProvider>
    <div className="shell">
      <aside className="sidebar" aria-label="Primary">
        <Link href="/" className="brand"><span className="brand-mark"><Icon name="phone" size={16} /></span><span>Callwise</span></Link>
        <nav className="side-nav">
          {nav.map(item => <Link key={item.key} href={item.href} className={active === item.key ? "active" : ""} aria-current={active === item.key ? "page" : undefined}><Icon name={item.icon} size={17} />{item.label}</Link>)}
        </nav>
        <div className="sidebar-foot">
          {dev && <span className="dev-badge" title="Raw API responses are visible. Turn off in Admin → Developer tools.">DEV MODE</span>}
          <span>Best Time to Call</span>
          <span className="muted-xs">Recommendations are advisory</span>
        </div>
      </aside>
      <div className="main">
        <header className="page-header">
          <div className="page-title"><h1>{title}</h1></div>
          <div className="page-actions">{actions}</div>
        </header>
        <main className="page-body">{children}</main>
      </div>
    </div>
  </ToastProvider>;
}
