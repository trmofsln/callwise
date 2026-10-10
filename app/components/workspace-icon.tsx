import type { CSSProperties } from "react";

const paths = {
  phone: <><path d="m8 3 3 5-3 3a15 15 0 0 0 5 5l3-3 5 3v3c0 1-1 2-2 2C10 21 3 14 3 5c0-1 1-2 2-2z" /></>,
  arrow: <><path d="M4 12h16m-6-6 6 6-6 6" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4m10-4v4M3 11h18m-13 5h2m4 0h2" /></>,
  people: <><circle cx="9" cy="7" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-17a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5v2" /></>,
  chart: <><path d="M4 4v16h17M8 15l4-4 4 2 5-7" /></>,
  download: <><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" /></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6z" /><path d="m8 12 3 3 5-6" /></>,
  list: <><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" /></>,
  x: <><path d="M6 6l12 12M18 6 6 18" /></>,
  check: <><path d="m5 12 5 5 9-10" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.6-4.4M4 4v4h4M4 13a8 8 0 0 0 14.6 4.4M20 20v-4h-4" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>,
  alert: <><path d="M12 3 2 20h20z" /><path d="M12 10v4m0 3h.01" /></>,
  chevron: <><path d="m9 6 6 6-6 6" /></>,
  note: <><path d="M5 4h14v12l-4 4H5z" /><path d="M15 20v-4h4M9 9h6M9 13h4" /></>,
  bolt: <><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></>,
} as const;

export type IconName = keyof typeof paths;
export default function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name]}</svg>;
}
