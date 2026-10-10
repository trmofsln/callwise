/* eslint-disable @typescript-eslint/no-require-imports -- Node CLI script (pptxgenjs deck build). */
// Callwise hackathon deck (PS03 Best Time to Call). Structured pptxgenjs deck: theme, layouts, sections.
const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const fi = require("react-icons/fi");
const { applyTheme } = require(process.env.PPTX_SKILL + "/scripts/apply_theme.js");

const THEME = {
  name: "Callwise", headFontFace: "Cambria", bodyFontFace: "Calibri",
  colors: { dk1: "10201F", lt1: "FFFFFF", dk2: "0B4F45", lt2: "EEF4F2",
    accent1: "0B8A76", accent2: "EB6834", accent3: "2A78D6", accent4: "9AA8A6", accent5: "A86400", accent6: "B3261E",
    hlink: "0B8A76", folHlink: "0B4F45" },
};
const HEX = { ink: "10201F", ink2: "4A5D5B", muted: "7A8B89", line: "D9E3E0", teal: "0B8A76", deep: "0B4F45", soft: "EEF4F2", orange: "EB6834", blue: "2A78D6", gray: "9AA8A6", white: "FFFFFF", warn: "A86400", bad: "B3261E", good: "11804A" };

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5
pres.title = "Callwise: Best Time to Call";
pres.author = "Callwise team";
pres.company = "IndiaMART hackathon";
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
const C = pres.SchemeColor;
const FOOT = "Callwise · PS03 Best Time to Call";

pres.defineSlideMaster({
  title: "TITLE_DARK", background: { color: C.text2 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.8, y: 2.2, w: 11.7, h: 1.9, fontSize: 48, bold: true, color: C.background1, valign: "bottom", align: "left", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: 0.8, y: 4.3, w: 11.0, h: 1.4, fontSize: 20, color: C.background2, valign: "top", margin: 0 }, text: "" } },
  ],
});
pres.defineSlideMaster({
  title: "CONTENT", background: { color: C.background1 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 0.4, w: 12.1, h: 0.75, fontSize: 28, bold: true, color: C.text1, valign: "top", align: "left", margin: 0 }, text: "" } },
    { text: { text: FOOT, options: { x: 0.6, y: 7.0, w: 6, h: 0.3, fontSize: 10, color: C.accent4, margin: 0 } } },
  ],
  slideNumber: { x: 12.2, y: 7.0, w: 0.5, h: 0.3, fontSize: 10, color: C.accent4, align: "right" },
});
pres.defineSlideMaster({
  title: "SECTION_DARK", background: { color: C.text2 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.8, y: 2.6, w: 11.7, h: 1.3, fontSize: 40, bold: true, color: C.background1, valign: "middle", align: "left", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: 0.8, y: 4.0, w: 11.0, h: 1.2, fontSize: 18, color: C.background2, valign: "top", margin: 0 }, text: "" } },
  ],
});

async function icon(Comp, hex, px = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(Comp, { color: "#" + hex, size: px }));
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + buf.toString("base64");
}
const T = (slide, text, opts) => slide.addText(text, { isTextBox: true, margin: 0, fontFace: "Calibri", color: HEX.ink, ...opts });
const box = (slide, x, y, w, h, fill = HEX.soft, line) => slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.08, fill: { color: fill }, line: line ? { color: line, width: 1 } : { type: "none" } });
const subtitle = (slide, text) => T(slide, text, { x: 0.6, y: 1.15, w: 12.1, h: 0.62, fontSize: 15, color: HEX.ink2, valign: "top" });
const chartText = { catAxisLabelFontFace: "+mn-lt", valAxisLabelFontFace: "+mn-lt", dataLabelFontFace: "+mn-lt", titleFontFace: "+mn-lt", legendFontFace: "+mn-lt", catAxisLabelColor: HEX.ink2, valAxisLabelColor: HEX.muted, catAxisLabelFontSize: 11, valAxisLabelFontSize: 10, dataLabelFontSize: 11, dataLabelColor: HEX.ink, titleFontSize: 13, titleColor: HEX.ink };

async function main() {
  const ic = {};
  for (const [k, comp, color] of [["phone", fi.FiPhone, HEX.teal], ["clock", fi.FiClock, HEX.teal], ["cal", fi.FiCalendar, HEX.teal], ["repeat", fi.FiRepeat, HEX.teal], ["bar", fi.FiBarChart2, HEX.teal], ["msg", fi.FiMessageSquare, HEX.teal], ["shield", fi.FiShield, HEX.teal], ["db", fi.FiDatabase, HEX.teal], ["cpu", fi.FiCpu, HEX.teal], ["users", fi.FiUsers, HEX.teal], ["lock", fi.FiLock, HEX.teal], ["target", fi.FiTarget, HEX.teal], ["flask", fi.FiActivity, HEX.teal], ["phoneW", fi.FiPhoneCall, HEX.white]]) ic[k] = await icon(comp, color);

  // ---------------- 1. Title
  pres.addSection({ title: "Opening" });
  let s = pres.addSlide({ masterName: "TITLE_DARK", sectionTitle: "Opening" });
  s.addImage({ data: ic.phoneW, x: 0.8, y: 1.2, w: 0.7, h: 0.7, objectName: "Brand icon" });
  s.addText("The right hour to call, and the next step when nobody answers", { placeholder: "title" });
  s.addText("Callwise · PS03 Best Time to Call · a calling-plan recommender for IndiaMART sales teams, built on production ERP data", { placeholder: "body" });
  s.addNotes("Open with the user: a sales rep with a list of sellers and a phone. Today they decide when to call by habit. Callwise gives them, for every seller, the best hour, a retry plan, a confidence level and a short reason, all grounded in that seller's real history. We optimise for completed meetings, not pickups, because meetings are where revenue starts.");

  // ---------------- 2. Problem
  pres.addSection({ title: "Problem and product" });
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Problem and product" });
  s.addText("Hundreds of thousands of dials a day, few become meetings", { placeholder: "title" });
  subtitle(s, "Measured on IndiaMART's ERP replica (Redash source 13). Meetings are ERP-recorded physical meetings linked to the call.");
  const stats = [["324k", "eligible outbound click-to-call dials on a typical day (12 Aug 2026), to 218k sellers by 6.4k employees"], ["0.50%", "of calls lead to an attributable physical meeting within 14 days (sealed test of 269,060 calls)"], ["~202", "calls placed for every attributable meeting across all channels; about 18 in the booking channel"], ["92%", "of attributable meetings come from one calling channel (CSDMERP) that makes 8% of calls"]];
  stats.forEach(([n, l], i) => {
    const x = 0.6 + i * 3.08;
    box(s, x, 2.05, 2.85, 2.6);
    T(s, n, { x: x + 0.25, y: 2.25, w: 2.4, h: 1.0, fontSize: 44, bold: true, color: HEX.teal, fontFace: "Cambria", objectName: `Stat ${i + 1}` });
    T(s, l, { x: x + 0.25, y: 3.3, w: 2.4, h: 1.2, fontSize: 13, color: HEX.ink2, valign: "top" });
  });
  T(s, "What PS03 asks for, per seller", { x: 0.6, y: 5.0, w: 6, h: 0.4, fontSize: 16, bold: true });
  const asks = ["Ranked future call windows", "Recommended next call time", "Retry plan after an unanswered attempt", "Confidence / uncertainty", "A factual 2–3 sentence explanation"];
  asks.forEach((a, i) => {
    const x = 0.6 + i * 2.46;
    box(s, x, 5.5, 2.3, 1.05, HEX.white, HEX.line);
    T(s, a, { x: x + 0.15, y: 5.55, w: 2.0, h: 0.95, fontSize: 13, valign: "middle" });
  });
  s.addNotes("The scale makes timing a real lever: 324k dials a day means even a small change in conversion is large in absolute meetings. But note how rare the outcome is, about one meeting per 200 calls overall. That rarity shaped every modelling decision we made. And 92% of attributable meetings come from one channel, which turned out to be the most important data discovery of the project.");

  // ---------------- 3. Product
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Problem and product" });
  s.addText("One calling plan per seller, with all five answers", { placeholder: "title" });
  subtitle(s, "A rep enters GLIDs. The plan is ordered for a call that happens in the next few minutes. Raw API data stays behind a developer switch.");
  const outs = [[ic.clock, "Best time to call", "Tue 13 Oct, 11:00–12:00 IST"], [ic.cal, "Ranked windows", "Up to 4 future one-hour slots, each with its evidence and relative strength"], [ic.repeat, "Retry plan", "No answer? Wait ≥ 60 min, retry Thu 11:00; attempt 2 of up to 10"], [ic.bar, "Confidence", "Moderate, low or insufficient, tied to the evidence behind the ranking"], [ic.msg, "Why, in 2–3 sentences", "Written from measured history; checked by the LLM, never invented"]];
  outs.forEach(([img, h, d], i) => {
    const y = 2.0 + i * 0.95;
    s.addShape(pres.shapes.OVAL, { x: 0.6, y, w: 0.62, h: 0.62, fill: { color: HEX.soft }, line: { type: "none" } });
    s.addImage({ data: img, x: 0.74, y: y + 0.14, w: 0.34, h: 0.34 });
    T(s, h, { x: 1.4, y: y - 0.02, w: 4.6, h: 0.35, fontSize: 16, bold: true });
    T(s, d, { x: 1.4, y: y + 0.33, w: 5.0, h: 0.52, fontSize: 13, color: HEX.ink2, valign: "top" });
  });
  // mock plan card
  box(s, 6.7, 2.0, 6.0, 4.6, HEX.white, HEX.line);
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 6.95, y: 2.25, w: 2.6, h: 1.75, rectRadius: 0.08, fill: { color: HEX.deep }, line: { type: "none" } });
  T(s, "BEST TIME TO CALL", { x: 7.15, y: 2.4, w: 2.3, h: 0.3, fontSize: 10, bold: true, color: "BFE7DD", charSpacing: 2 });
  T(s, "Tue 13 Oct\n11:00 am", { x: 7.15, y: 2.72, w: 2.3, h: 0.9, fontSize: 22, bold: true, color: HEX.white, fontFace: "Cambria" });
  T(s, "Answer history · Low confidence", { x: 7.15, y: 3.6, w: 2.35, h: 0.3, fontSize: 10, color: "CFE9E2" });
  T(s, "Why this time: meeting evidence is inconclusive, so this seller's most answered slots rank first, with very short calls discounted. 12 observed prior calls; no meeting probability claimed.", { x: 9.75, y: 2.25, w: 2.75, h: 1.75, fontSize: 11.5, color: HEX.ink2, valign: "top" });
  s.addTable([
    [{ text: "Rank", options: { bold: true, color: HEX.muted } }, { text: "Window", options: { bold: true, color: HEX.muted } }, { text: "Evidence", options: { bold: true, color: HEX.muted } }],
    ["1", "Tue 13 Oct, 11:00", "6 answered calls"], ["2", "Thu 15 Oct, 11:00", "6 answered calls"], ["3", "Mon 12 Oct, 11:00", "6 answered calls"], ["4", "Wed 14 Oct, 11:00", "6 answered calls"],
  ], { x: 6.95, y: 4.2, w: 5.55, colW: [0.7, 2.35, 2.5], fontSize: 11.5, fontFace: "Calibri", color: HEX.ink, border: { type: "solid", color: HEX.line, pt: 0.75 }, rowH: 0.3 });
  T(s, "Example from the real engine on a synthetic seller", { x: 6.95, y: 6.2, w: 5.5, h: 0.3, fontSize: 10, color: HEX.muted, italic: true });
  s.addNotes("This is the whole product surface. We designed it so the rep can act in five seconds: the big card is the time, the reason sits next to it, the ranked list gives alternatives, and the retry plan answers the most common follow-up question, what if they don't pick up. Confidence is shown in words, not fake percentages, because the honest uncertainty here is about evidence, not a probability.");

  // ---------------- 4. Architecture
  pres.addSection({ title: "How it works" });
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "How it works" });
  s.addText("From GLID to a grounded calling plan in one request", { placeholder: "title" });
  subtitle(s, "Next.js app with server-side integrations. Each step is deterministic except the optional LLM review, which cannot change the plan.");
  const flow = [[ic.users, "GLID lookup", "Batch of up to 50 sellers"], [ic.db, "ERP history", "Redash source 13: calls, DSR calls, meetings, assignments"], [ic.shield, "Calling rules", "Hours, gap, caps, DNC, appointments"], [ic.target, "Ranking ladder", "Seller meetings → answers → model → hours"], [ic.repeat, "Retry simulation", "Assume a miss, recompute the plan"], [ic.msg, "LLM review", "GPT-6 Luna, tools only, strict schema"]];
  flow.forEach(([img, h, d], i) => {
    const x = 0.6 + i * 2.07;
    box(s, x, 2.2, 1.85, 2.3, HEX.soft);
    s.addImage({ data: img, x: x + 0.2, y: 2.4, w: 0.42, h: 0.42 });
    T(s, h, { x: x + 0.2, y: 2.92, w: 1.55, h: 0.55, fontSize: 14, bold: true, valign: "top" });
    T(s, d, { x: x + 0.2, y: 3.5, w: 1.55, h: 0.95, fontSize: 12, color: HEX.ink2, valign: "top" });
    if (i < flow.length - 1) s.addShape(pres.shapes.RIGHT_ARROW, { x: x + 1.87, y: 3.2, w: 0.18, h: 0.3, fill: { color: HEX.gray }, line: { type: "none" } });
  });
  const side = [["Global Context API", "7 segments (KYC, connects, tickets, BuyLeads, activity, duplicate GLIDs, actual data) fetched with a server-side token; shown for context, never used to rank."], ["Provenance checks", "Model files load only if their SHA-256, model card and sealed-test results match. Otherwise the app falls back to calling hours."], ["Developer mode", "Raw API responses, IDs and scores are hidden unless a per-browser switch in Admin is on."]];
  side.forEach(([h, d], i) => {
    const x = 0.6 + i * 4.1;
    box(s, x, 4.85, 3.85, 1.8, HEX.white, HEX.line);
    T(s, h, { x: x + 0.2, y: 4.98, w: 3.5, h: 0.35, fontSize: 14, bold: true });
    T(s, d, { x: x + 0.2, y: 5.35, w: 3.5, h: 1.2, fontSize: 12, color: HEX.ink2, valign: "top" });
  });
  s.addNotes("One request does all of this, within a 20-second batch deadline and four parallel workers. The important design choice is the order: rules first, then evidence, then explanation. That ordering is what lets us promise a rep that a recommended window is always callable, and that the explanation always matches the evidence.");

  // ---------------- 5. Decision ladder
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "How it works" });
  s.addText("The most specific evidence wins, and each plan names it", { placeholder: "title" });
  subtitle(s, "Thresholds are from the live code (lib/best-time-ranking.ts, lib/best-time-policy.ts).");
  const rungs = [["0", "Calling rules gate", "10:00–18:00 Mon–Sat · 60-min gap · 3/day · 10 per 7-day sequence · DNC · appointments · ≤ 4 windows", "Always", HEX.deep],
    ["1", "Seller's meeting history", "≥ 2 calls that led to meetings. Weekday slot if supported, else hour pooled across weekdays.", "Live", HEX.teal],
    ["2", "Seller's answer history", "≥ 3 answered, one hour ≥ 2. Priority × (1 − 0.75 × share of calls under 20 s).", "Live", HEX.teal],
    ["3", "Completed-meeting model", "Reserved for a calibrated meeting_done model; off until verified labels exist.", "Waiting", HEX.gray],
    ["4", "General timing model v4", "Smoothed weekday × hour rate from 150,875 calls / 723 meetings, dev-calibrated, hour back-off.", "Live", HEX.teal],
    ["5", "Calling hours", "No usable evidence: earliest allowed windows, labelled as such.", "Fallback", HEX.gray]];
  rungs.forEach(([n, h, d, st, col], i) => {
    const y = 1.95 + i * 0.8;
    box(s, 0.6, y, 12.1, 0.68, i === 0 ? HEX.soft : HEX.white, HEX.line);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.78, y: y + 0.13, w: 0.42, h: 0.42, rectRadius: 0.06, fill: { color: col }, line: { type: "none" } });
    T(s, n, { x: 0.78, y: y + 0.13, w: 0.42, h: 0.42, fontSize: 14, bold: true, color: HEX.white, align: "center", valign: "middle" });
    T(s, h, { x: 1.4, y: y + 0.1, w: 3.2, h: 0.48, fontSize: 15, bold: true, valign: "middle" });
    T(s, d, { x: 4.6, y: y + 0.08, w: 6.7, h: 0.52, fontSize: 12, color: HEX.ink2, valign: "middle" });
    T(s, st, { x: 11.4, y: y + 0.1, w: 1.15, h: 0.48, fontSize: 12, bold: true, color: col === HEX.gray ? HEX.muted : HEX.teal, align: "right", valign: "middle" });
  });
  s.addNotes("This ladder is the core logic. A seller with real meeting history gets ranked on their own data. With only pickups, we rank on pickups, discounting very short calls because a 10-second answer is often a hang-up. With little history, the trained general model ranks hours. Rung 3 is deliberately empty: we will not show a meeting probability until we have verified completed-meeting labels. That restraint is a product decision.");

  // ---------------- 6. Retry & guardrails
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "How it works" });
  s.addText("Retry timing is simulated, not guessed", { placeholder: "title" });
  subtitle(s, "The engine assumes the recommended call goes unanswered, adds that attempt, and reruns every rule and ranking.");
  const steps = [["Call", "Top window\nTue 11:00–12:00"], ["Miss", "Hypothetical unanswered attempt at 11:00"], ["Recompute", "Cooldown, daily cap, sequence cap, DNC, appointments, ranking"], ["Decide", "Same day → retry · later → postpone · capped or DNC → stop"]];
  steps.forEach(([h, d], i) => {
    const x = 0.6 + i * 3.08;
    s.addShape(pres.shapes.OVAL, { x, y: 2.2, w: 0.55, h: 0.55, fill: { color: i === 3 ? HEX.deep : HEX.teal }, line: { type: "none" } });
    T(s, String(i + 1), { x, y: 2.2, w: 0.55, h: 0.55, fontSize: 16, bold: true, color: HEX.white, align: "center", valign: "middle" });
    if (i < 3) s.addShape(pres.shapes.LINE, { x: x + 0.65, y: 2.475, w: 2.3, h: 0, line: { color: HEX.line, width: 2 } });
    T(s, h, { x, y: 2.9, w: 2.7, h: 0.4, fontSize: 16, bold: true });
    T(s, d, { x, y: 3.3, w: 2.75, h: 0.9, fontSize: 12.5, color: HEX.ink2, valign: "top" });
  });
  const facts = [["5", "candidate delays evaluated: 15 min, 30 min, 1 h, 2 h, 1 day"], ["60 min", "default minimum gap; rep cancels the retry if contact happens another way"], ["10", "attempts per 7-day sequence; the cap resets after an answered call"]];
  facts.forEach(([n, l], i) => {
    const x = 0.6 + i * 4.1;
    box(s, x, 4.6, 3.85, 1.9);
    T(s, n, { x: x + 0.25, y: 4.75, w: 3.4, h: 0.8, fontSize: 36, bold: true, color: HEX.teal, fontFace: "Cambria" });
    T(s, l, { x: x + 0.25, y: 5.55, w: 3.4, h: 0.85, fontSize: 13, color: HEX.ink2, valign: "top" });
  });
  s.addNotes("Most tools hard-code 'retry in 15 minutes'. We simulate instead, so the retry automatically respects every constraint the first call does. The candidate delays are kept as hypotheses: the historical data has no retry-chain identity, so we could not measure which delay is best. That is one of the questions the pilot answers.");

  // ---------------- 7. Data
  pres.addSection({ title: "Data and models" });
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Data and models" });
  s.addText("Production ERP data, without touching production", { placeholder: "title" });
  subtitle(s, "Read-only Redash extraction under a 5-second statement limit, a dedicated query id, and salted pseudonyms computed inside SQL.");
  const pipe = [[ic.db, "Redash 13", "ERP read replica"], [ic.cpu, "≈2,300", "30-min chunks, 6 workers"], [ic.lock, "md5 + salt", "no names, phones, recordings"], [ic.target, "42,785", "meetings linked by UCID"], [ic.users, "931,006", "calls, 8% seller sample"]];
  pipe.forEach(([img, n, l], i) => {
    const x = 0.6 + i * 2.46;
    box(s, x, 2.0, 2.3, 1.7);
    s.addImage({ data: img, x: x + 0.2, y: 2.15, w: 0.36, h: 0.36 });
    T(s, n, { x: x + 0.2, y: 2.6, w: 2.0, h: 0.5, fontSize: 22, bold: true, fontFace: "Cambria" });
    T(s, l, { x: x + 0.2, y: 3.1, w: 2.0, h: 0.5, fontSize: 12, color: HEX.ink2 });
  });
  T(s, "Time-ordered splits with a 14-day maturity embargo", { x: 0.6, y: 4.05, w: 8, h: 0.4, fontSize: 16, bold: true });
  const spans = [["Warm-up", "Aug 11–17", "history only", 0, 7, HEX.soft, HEX.ink2], ["Train", "Aug 18–24", "150,875 calls · 723 mtgs", 7, 7, HEX.teal, HEX.white], ["Dev", "Aug 25–31", "165,323 calls · 628 mtgs", 14, 7, HEX.blue, HEX.white], ["Embargo", "Sep 1–13", "labels mature", 21, 13, HEX.soft, HEX.ink2], ["Sealed test", "Sep 14–25", "269,060 calls · 1,332 mtgs", 34, 12, HEX.orange, HEX.white]];
  const dx = 12.1 / 46;
  spans.forEach(([n, d, info, st, len, fill, ink]) => {
    const x = 0.6 + st * dx, w = len * dx - 0.06;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 4.6, w, h: 0.55, rectRadius: 0.05, fill: { color: fill }, line: { type: "none" } });
    T(s, n, { x: x + 0.1, y: 4.6, w: w - 0.15, h: 0.55, fontSize: 12, bold: true, color: ink, valign: "middle" });
    T(s, d, { x, y: 5.25, w: Math.max(w, 1.6), h: 0.3, fontSize: 11.5, color: HEX.ink2 });
    T(s, info, { x, y: 5.52, w: Math.max(w, 1.6), h: 0.55, fontSize: 11, color: HEX.ink, bold: true, valign: "top" });
  });
  T(s, "Features use only events that happened and were recorded before the call. The test was opened once, after every model was frozen, and excludes the 1,000 calls the previous model's test had used.", { x: 0.6, y: 6.25, w: 12.1, h: 0.55, fontSize: 12, color: HEX.muted, italic: true });
  s.addNotes("Two constraints shaped the data work. The replica kills any query over 5 seconds, so we split extraction into about 2,300 small index-friendly chunks. And customer data must stay protected, so every identifier is hashed with a local salt inside SQL before it leaves the database. We sampled sellers, not calls, so each sampled seller's full history is available for leakage-free features. Call logs only go back to 11 August, which bounds how much history any feature can use.");

  // ---------------- 8. Heatmap
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Data and models" });
  s.addText("Mornings convert; afternoons mostly don't", { placeholder: "title" });
  subtitle(s, "Live v4 model: % of calls leading to an attributable physical meeting within 14 days, by weekday and hour.");
  const hours = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19], days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const V = [[0.394, 0.654, 0.679, 0.442, 0.348, 0.244, 0.013, 0.331, 0.169, 0.074, 0.127], [0.565, 0.542, 0.792, 0.384, 0.302, 0.554, 0.115, 0.199, 0.067, 0.070, 0.031], [0.232, 0.661, 0.712, 0.484, 0.361, 0.260, 0.155, 0.271, 0.141, 0.013, 0.148], [0.698, 0.786, 0.770, 0.603, 0.389, 0.390, 0.146, 0.190, 0.277, 0.102, 0.034], [0.599, 0.739, 0.935, 0.479, 0.307, 0.322, 0.123, 0.420, 0.083, 0.078, 0.039], [0.438, 0.552, 0.916, 0.516, 0.212, 0.238, 0.268, 0.299, 0.124, 0.140, 0.075]];
  const ramp = ["E6F4F0", "BFE4D9", "8FCFBE", "55B29C", "1F8D77", "0B5E51"], edges = [0.15, 0.3, 0.45, 0.6, 0.75];
  const bucket = v => { const k = edges.findIndex(e => v < e); return k === -1 ? 5 : k; };
  const gx = 1.4, gy = 2.25, cw = 0.78, ch = 0.58;
  hours.forEach((h, j) => T(s, `${String(h).padStart(2, "0")}:00`, { x: gx + j * cw, y: gy - 0.35, w: cw, h: 0.3, fontSize: 11, color: HEX.ink2, align: "center" }));
  days.forEach((d, i) => {
    T(s, d, { x: 0.6, y: gy + i * ch, w: 0.7, h: ch, fontSize: 13, color: HEX.ink2, valign: "middle" });
    V[i].forEach((v, j) => {
      const b = bucket(v);
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: gx + j * cw + 0.03, y: gy + i * ch + 0.03, w: cw - 0.06, h: ch - 0.06, rectRadius: 0.04, fill: { color: ramp[b] }, line: { type: "none" }, objectName: `Cell ${d} ${hours[j]}` });
      if (v >= 0.6) T(s, v.toFixed(2), { x: gx + j * cw, y: gy + i * ch, w: cw, h: ch, fontSize: 11, bold: true, color: HEX.white, align: "center", valign: "middle" });
    });
  });
  ["< 0.15%", "0.15–0.30", "0.30–0.45", "0.45–0.60", "0.60–0.75", "≥ 0.75%"].forEach((l, i) => {
    s.addShape(pres.shapes.RECTANGLE, { x: gx + i * 1.4, y: 5.95, w: 0.22, h: 0.22, fill: { color: ramp[i] }, line: { color: HEX.line, width: 0.5 } });
    T(s, l, { x: gx + i * 1.4 + 0.3, y: 5.92, w: 1.1, h: 0.28, fontSize: 11, color: HEX.ink2 });
  });
  box(s, 10.25, 2.25, 2.45, 3.45);
  T(s, "11:00", { x: 10.45, y: 2.4, w: 2.1, h: 0.7, fontSize: 36, bold: true, color: HEX.teal, fontFace: "Cambria" });
  T(s, "is the peak on 5 of 6 calling days, at up to 0.94% per call", { x: 10.45, y: 3.1, w: 2.1, h: 0.9, fontSize: 13, color: HEX.ink2 });
  T(s, "~40%", { x: 10.45, y: 4.05, w: 2.1, h: 0.6, fontSize: 30, bold: true, color: HEX.orange, fontFace: "Cambria" });
  T(s, "of dials still happen 14:00–18:00, where the rate is mostly under 0.3%", { x: 10.45, y: 4.65, w: 2.1, h: 0.95, fontSize: 13, color: HEX.ink2 });
  s.addNotes("This is what the live timing model learned from 150,875 calls. Late morning is consistently best; mid-afternoon, especially 15:00, is consistently weak. Yet about 40% of dials happen in the afternoon. That gap between when reps call and when meetings happen is the product opportunity. These are associations in historical data, which is why we pair the model with a pilot.");

  // ---------------- 9. Channel + volume
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Data and models" });
  s.addText("Meetings come almost entirely from one calling channel", { placeholder: "title" });
  subtitle(s, "Share of calls vs share of attributable meetings, by calling module (train + dev, 316,198 calls).");
  s.addChart(pres.charts.BAR, [
    { name: "Share of calls (%)", labels: ["NSD C2C", "NSD Normal", "CSD Normal", "CSDMERP", "DSR", "MERP", "Other"], values: [35.8, 34.1, 10.5, 8.0, 4.3, 0.5, 6.8] },
    { name: "Share of meetings (%)", labels: ["NSD C2C", "NSD Normal", "CSD Normal", "CSDMERP", "DSR", "MERP", "Other"], values: [0.0, 0.07, 3.7, 92.2, 0.6, 3.2, 0.3] },
  ], { x: 0.6, y: 1.9, w: 7.4, h: 4.9, barDir: "bar", barGrouping: "clustered", barGapWidthPct: 60, chartColors: [HEX.gray, HEX.teal], showLegend: true, legendPos: "b", legendFontSize: 11, legendColor: HEX.ink2, showValue: true, dataLabelPosition: "outEnd", dataLabelFormatCode: "0.0", valAxisHidden: true, valGridLine: { style: "none" }, catGridLine: { style: "none" }, catAxisOrientation: "maxMin", showTitle: false, ...chartText });
  box(s, 8.4, 1.95, 4.3, 4.85);
  T(s, "Why it matters", { x: 8.65, y: 2.1, w: 3.8, h: 0.4, fontSize: 16, bold: true });
  T(s, [
    { text: "A meeting is attributable only when its appointment record carries the call's ID. CSD booking calls do; NSD calls rarely do.", options: { bullet: true, breakLine: true, paraSpaceAfter: 8 } },
    { text: "A model that knows the channel looks 8× better on paper, but that only identifies the team dialling, not the best hour.", options: { bullet: true, breakLine: true, paraSpaceAfter: 8 } },
    { text: "So we judged timing quality inside the booking channel (CSDMERP + MERP, defined on training data only).", options: { bullet: true, breakLine: true, paraSpaceAfter: 8 } },
    { text: "Product implication: meeting-based timing is meaningful for booking teams; other teams need a different outcome, such as validated meetings.", options: { bullet: true } },
  ], { x: 8.65, y: 2.55, w: 3.85, h: 4.1, fontSize: 13, color: HEX.ink2, valign: "top" });
  s.addNotes("This was the most consequential finding. Without it we would have reported a tenfold model improvement that is really just the model recognising which team is calling. We caught it on the development data, wrote the change into our pre-registered plan before opening the test, and evaluated timing within the channel where the outcome actually exists.");

  // ---------------- 10. Model ladder
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Data and models" });
  s.addText("Seven model families: history predicts who converts", { placeholder: "title" });
  subtitle(s, "Average precision on the sealed test. Higher is better; the base rate is what random ranking scores.");
  const ladderOpts = (title, colors, fmt = "0.0%") => ({ barDir: "bar", chartColors: colors, showValue: true, dataLabelPosition: "outEnd", dataLabelFormatCode: fmt, valAxisHidden: true, valGridLine: { style: "none" }, catGridLine: { style: "none" }, catAxisOrientation: "maxMin", showLegend: false, showTitle: true, title, barGapWidthPct: 50, ...chartText });
  s.addChart(pres.charts.BAR, [{ name: "AP", labels: ["Previous model (v3)", "Hour/day retrained (v4, live)", "Clock-only LightGBM", "+ seller history", "+ channel", "All features (LightGBM)"], values: [0.0080, 0.0085, 0.0085, 0.0516, 0.0680, 0.0932] }],
    { x: 0.6, y: 1.9, w: 6.0, h: 4.4, ...ladderOpts("All calls · base rate 0.50% · 269,060 calls", [HEX.gray, HEX.teal, HEX.gray, HEX.gray, HEX.gray, HEX.blue], "0.00%") });
  s.addChart(pres.charts.BAR, [{ name: "AP", labels: ["Previous model (v3)", "Hour/day retrained", "Clock-only LightGBM", "Answer-history heuristic", "+ seller history", "Two-stage answer × convert"], values: [0.0641, 0.0605, 0.0618, 0.0684, 0.0904, 0.0923] }],
    { x: 6.75, y: 1.9, w: 6.0, h: 4.4, ...ladderOpts("Booking channel · base rate 5.57% · 22,708 calls", [HEX.gray, HEX.gray, HEX.gray, HEX.gray, HEX.gray, HEX.blue]) });
  T(s, "Clock-only models (logistic, LightGBM, partial pooling) never beat the smoothed hour/day table. Seller history lifts channel precision by 52% (95% CI +0.026 to +0.039 absolute).", { x: 0.6, y: 6.35, w: 12.1, h: 0.5, fontSize: 12.5, color: HEX.ink2 });
  s.addNotes("We trained population rates, the existing hour-day table, a personal-history heuristic, partial pooling, regularised logistic regression, LightGBM, a seller random-intercept model and a two-stage answer times conversion model, all on the same frozen data, tuned only on development data. The pattern is consistent: knowing the seller's recent history predicts conversion well; fancier modelling of the clock does not.");

  // ---------------- 11. Timing truth
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Data and models" });
  s.addText("But no model picks a better hour for the same seller", { placeholder: "title" });
  subtitle(s, "Within-seller hour ranking vs the previous live model (booking channel), and meeting rate inside vs outside each model's top-4 hours.");
  const conc = [["Hour/day retrained", -0.0319, -0.0710, 0.0061], ["Clock-only LightGBM", -0.0119, -0.0446, 0.0221], ["Partial pooling", -0.0222, -0.0586, 0.0143], ["Logistic, all features", -0.0324, -0.0714, 0.0069], ["LightGBM, all features", -0.0064, -0.0457, 0.0309], ["Two-stage (selected)", -0.0083, -0.0514, 0.0313], ["Answer-history heuristic", -0.0687, -0.1087, -0.0303]];
  const px0 = 3.0, pw = 3.6, lo = -0.12, hi = 0.05, X = v => px0 + pw * (v - lo) / (hi - lo);
  T(s, "Difference in concordance, 95% seller-cluster CI", { x: 0.6, y: 1.95, w: 6, h: 0.35, fontSize: 13, bold: true });
  [-0.1, -0.05, 0, 0.05].forEach(v => {
    s.addShape(pres.shapes.LINE, { x: X(v), y: 2.4, w: 0, h: 3.6, line: { color: v === 0 ? HEX.ink2 : HEX.line, width: v === 0 ? 1.25 : 0.75, dashType: v === 0 ? "solid" : "dash" } });
    T(s, (v > 0 ? "+" : "") + v.toFixed(2), { x: X(v) - 0.35, y: 6.05, w: 0.7, h: 0.25, fontSize: 10, color: HEX.muted, align: "center" });
  });
  conc.forEach(([n, d, a, b], i) => {
    const y = 2.6 + i * 0.5, worse = b < 0, color = worse ? HEX.orange : HEX.blue;
    T(s, n, { x: 0.6, y: y - 0.15, w: 2.3, h: 0.3, fontSize: 11.5, color: worse ? HEX.ink : HEX.ink2, bold: worse, align: "right" });
    s.addShape(pres.shapes.LINE, { x: X(a), y, w: X(b) - X(a), h: 0, line: { color, width: 2 } });
    s.addShape(pres.shapes.OVAL, { x: X(d) - 0.08, y: y - 0.08, w: 0.16, h: 0.16, fill: { color }, line: { color: HEX.white, width: 1 } });
  });
  s.addChart(pres.charts.BAR, [
    { name: "Inside top 4 hours", labels: ["Previous model (v3)", "Hour/day retrained", "Two-stage (selected)"], values: [6.22, 6.30, 6.48] },
    { name: "Other hours", labels: ["Previous model (v3)", "Hour/day retrained", "Two-stage (selected)"], values: [4.25, 3.95, 4.40] },
  ], { x: 7.0, y: 1.9, w: 5.7, h: 4.5, barDir: "col", barGrouping: "clustered", barGapWidthPct: 70, chartColors: [HEX.teal, HEX.gray], showValue: true, dataLabelPosition: "outEnd", dataLabelFormatCode: "0.0\"%\"", valAxisHidden: true, valGridLine: { style: "none" }, catGridLine: { style: "none" }, showLegend: true, legendPos: "b", legendFontSize: 11, legendColor: HEX.ink2, showTitle: true, title: "Meeting rate per call (%)", ...chartText });
  T(s, "All intervals cross zero except the answer-history heuristic, which ranks hours worse. Every model's recommended hours convert about 1.5× better, but that is association, not proof.", { x: 0.6, y: 6.4, w: 12.1, h: 0.5, fontSize: 12.5, color: HEX.ink2 });
  s.addNotes("This is the honest result that most hackathon decks would skip. Call-level precision went up a lot, but when we ask the question that matters for the product, does the model rank a seller's good hours above their bad hours better than before, no candidate wins. So we shipped the simplest model that measurably improved: the retrained hour-day table. The history-aware model is valuable for a different decision: who to call today.");

  // ---------------- 12. LLM
  pres.addSection({ title: "AI layer" });
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "AI layer" });
  s.addText("The LLM explains; it never decides", { placeholder: "title" });
  subtitle(s, "GPT-6 Luna through OpenRouter reviews each plan with read-only tools. Any deviation falls back to the rule-written explanation.");
  const guards = [[ic.cpu, "4 read-only tools", "prediction context, the selected scorer, retry plan, validation; arguments locked to the request's context ID"], [ic.lock, "Enum-pinned JSON", "tool, model version, route and validation status must equal the engine's own output"], [ic.clock, "Bounded budget", "12 s deadline, ≤ 6 tool calls, 900 output tokens, no reasoning tokens"], [ic.repeat, "One repair, then fallback", "a mismatched review gets one retry; failure keeps the deterministic plan"], [ic.shield, "Untrusted input", "source data is labelled untrusted; no SQL, no training, no window changes"], [ic.lock, "Secrets server-side", "the API key never reaches the browser, logs, tests or prompts"]];
  guards.forEach(([img, h, d], i) => {
    const col = i % 2, row = Math.floor(i / 2), x = 0.6 + col * 3.75, y = 2.0 + row * 1.55;
    box(s, x, y, 3.55, 1.4, HEX.white, HEX.line);
    s.addImage({ data: img, x: x + 0.2, y: y + 0.2, w: 0.34, h: 0.34 });
    T(s, h, { x: x + 0.65, y: y + 0.18, w: 2.75, h: 0.38, fontSize: 14, bold: true });
    T(s, d, { x: x + 0.2, y: y + 0.62, w: 3.2, h: 0.72, fontSize: 11.5, color: HEX.ink2, valign: "top" });
  });
  box(s, 8.3, 2.0, 4.4, 4.5, HEX.deep);
  T(s, "Why this design", { x: 8.55, y: 2.2, w: 3.9, h: 0.4, fontSize: 16, bold: true, color: HEX.white });
  T(s, [
    { text: "Reps act on the time, so the time must come from measured evidence.", options: { bullet: true, breakLine: true, paraSpaceAfter: 8 } },
    { text: "The 2–3 sentence explanation is a factual template; the LLM checks it against tool outputs.", options: { bullet: true, breakLine: true, paraSpaceAfter: 8 } },
    { text: "An LLM outage or error can never produce a wrong call time.", options: { bullet: true, breakLine: true, paraSpaceAfter: 8 } },
    { text: "Cost and latency are capped per seller, and every sentence is auditable.", options: { bullet: true } },
  ], { x: 8.55, y: 2.7, w: 3.95, h: 3.6, fontSize: 14, color: "D7EEE8", valign: "top" });
  s.addNotes("We used the LLM where it adds value and contained it where it adds risk. It can read the deterministic results through four tools and must return a schema whose key fields are pinned to those results. If it drifts, it gets one repair attempt, then we fall back. This is how we get the trust benefit of a natural-language reason without letting a language model choose when a rep calls.");

  // ---------------- 13. Impact
  pres.addSection({ title: "Impact and next steps" });
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Impact and next steps" });
  s.addText("Sizing the prize, and how we will prove it", { placeholder: "title" });
  subtitle(s, "Scenario built from measured volumes. Uplift is a pilot target, not a measured result.");
  const calc = [["≈ 23,650", "booking-channel calls per day (from the 8% sample)"], ["5.57%", "attributable meeting rate in that channel"], ["≈ 1,317", "attributable meetings per day today"], ["+10%", "relative uplift the pilot is powered to detect"]];
  calc.forEach(([n, l], i) => {
    const y = 2.0 + i * 0.95;
    T(s, n, { x: 0.6, y, w: 2.2, h: 0.75, fontSize: 28, bold: true, color: HEX.ink, fontFace: "Cambria", valign: "middle" });
    T(s, l, { x: 2.9, y, w: 3.4, h: 0.75, fontSize: 13, color: HEX.ink2, valign: "middle" });
  });
  box(s, 0.6, 5.85, 5.7, 0.95, HEX.soft);
  T(s, [{ text: "≈ 130 ", options: { fontSize: 30, bold: true, color: HEX.teal, fontFace: "Cambria" } }, { text: "more meetings a day · ≈ 3,400 a month", options: { fontSize: 14, color: HEX.ink } }], { x: 0.8, y: 5.9, w: 5.4, h: 0.85, valign: "middle" });
  box(s, 6.75, 2.0, 5.95, 3.55, HEX.white, HEX.line);
  box(s, 6.75, 5.85, 5.95, 0.95, HEX.soft);
  T(s, [{ text: "Guardrails tracked daily: ", options: { bold: true, color: HEX.ink } }, { text: "answer rate · calls per meeting · complaints · DNC breaches · LLM fallback rate", options: { color: HEX.ink2 } }], { x: 6.95, y: 5.9, w: 5.6, h: 0.85, fontSize: 13, valign: "middle" });
  T(s, "Proposed randomized pilot", { x: 7.0, y: 2.15, w: 5.5, h: 0.4, fontSize: 16, bold: true });
  T(s, [
    { text: "Within CSDMERP/MERP, randomize each eligible seller-day: model's top window vs a random allowed window, with propensities logged.", options: { bullet: { type: "number" }, breakLine: true, paraSpaceAfter: 8 } },
    { text: "Primary outcome: validated completed meeting within 14 days. Secondary: answer rate, calls per meeting.", options: { bullet: { type: "number" }, breakLine: true, paraSpaceAfter: 8 } },
    { text: "About 28k calls per arm for 5.6% → 6.2% (α 0.05, 80% power), more after seller clustering.", options: { bullet: { type: "number" }, breakLine: true, paraSpaceAfter: 8 } },
    { text: "Same caps, cooldowns and do-not-call rules; daily guardrails and a kill switch.", options: { bullet: { type: "number" } } },
  ], { x: 7.0, y: 2.6, w: 5.45, h: 2.85, fontSize: 13, color: HEX.ink2, valign: "top" });
  s.addNotes("Here is how I would size this for a business owner. In the booking channel alone, about 23,650 calls a day produce about 1,300 attributable meetings. If timing recommendations deliver the 10% relative uplift the pilot is designed to detect, that is roughly 130 extra meetings a day, around 3,400 a month. The observed 1.5× gap between recommended and other hours makes that plausible, but only a randomized pilot can prove it, so that is the ask.");

  // ---------------- 14. Roadmap & ask
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Impact and next steps" });
  s.addText("What is live, what we learned, what we ask for", { placeholder: "title" });
  subtitle(s, "The product is live and safe to use today. Two decisions unlock the measured uplift.");
  const road = [["Live now", "v4 timing model in the app", "Provenance-checked artifacts, JS/Python parity to 2e-18, one-line rollback, redesigned rep workspace.", HEX.teal], ["Next 2 weeks", "Confirm the meeting label", "ERP owners confirm result codes and a validated-meeting source (e.g. payout-eligible meetings).", HEX.blue], ["Next 6 weeks", "Run the pilot", "Randomized timing test in the booking channel; measure completed meetings per call.", HEX.orange], ["After the pilot", "Prioritisation product", "Use the history-aware ranker (+52% precision) to decide who to call today.", HEX.deep]];
  road.forEach(([when, h, d, col], i) => {
    const x = 0.6 + i * 3.08;
    box(s, x, 2.0, 2.85, 2.75, HEX.white, HEX.line);
    s.addShape(pres.shapes.OVAL, { x: x + 0.2, y: 2.2, w: 0.32, h: 0.32, fill: { color: col }, line: { type: "none" } });
    T(s, when.toUpperCase(), { x: x + 0.62, y: 2.2, w: 2.1, h: 0.32, fontSize: 11, bold: true, color: col, charSpacing: 1.5, valign: "middle" });
    T(s, h, { x: x + 0.2, y: 2.7, w: 2.5, h: 0.65, fontSize: 16, bold: true, valign: "top" });
    T(s, d, { x: x + 0.2, y: 3.4, w: 2.5, h: 1.3, fontSize: 13, color: HEX.ink2, valign: "top" });
  });
  box(s, 0.6, 5.05, 12.1, 1.55, HEX.deep);
  T(s, "Our ask", { x: 0.85, y: 5.22, w: 3, h: 0.4, fontSize: 16, bold: true, color: HEX.white });
  T(s, "Approve a 6-week randomized pilot in the CSD booking channel, and connect us with the ERP owners who can confirm what a completed meeting is. We will come back with measured uplift, not a projection.", { x: 0.85, y: 5.65, w: 11.6, h: 0.85, fontSize: 16, color: "E3F3EE", valign: "top" });
  s.addNotes("Close on the decision. The product is live and safe to use today. We were rigorous about what the data does and does not prove, and that rigor tells us exactly what to do next. Two things unlock the remaining value: a confirmed definition of a completed meeting, and permission to run a randomized pilot.");

  await pres.writeFile({ fileName: process.env.OUT });
  await applyTheme(process.env.OUT, THEME);
  console.log("wrote", process.env.OUT);
}
main().catch(e => { console.error(e); process.exit(1); });
