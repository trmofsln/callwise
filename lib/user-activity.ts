import type { Assignment, DbRecord, Interaction, UserActivity } from "./user-types";

export function activitySelect(): string {
  const linked = (alias: string) => `EXISTS (SELECT 1 FROM redash.sts_company sc WHERE sc.companyid = ${alias}.fk_sts_company_id AND sc.sts_fk_glusr_id = g.glusr_usr_id)`;
  const entries = [
    ["click_to_call", "fk_employeeid", "t.fk_glusr_usr_id = g.glusr_usr_id"],
    ["sts_dsr_call", "sts_dsr_call_by", linked("t")],
    ["sts_dsr_meeting", "sts_dsr_meeting_by", linked("t")],
    ["sts_dsr_sales", "sts_dsr_sales_by", linked("t")],
  ].map(([table, employee, filter]) => `'${table}', COALESCE((SELECT jsonb_agg(to_jsonb(t) || jsonb_build_object('_employee_name', emp.employeename)) FROM redash.${table} t LEFT JOIN redash.employee emp ON emp.employeeid = t.${employee} WHERE ${filter}), '[]'::jsonb)`);
  for (const table of ["sts_dsr_app_session", "meeting_trust_score", "nsd_sales_welcome_meeting", "sts_dsr_auth", "call_kdm_feedback"]) {
    entries.push(`'${table}', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM redash.${table} t WHERE t.fk_glusr_usr_id = g.glusr_usr_id), '[]'::jsonb)`);
  }
  return `jsonb_build_object(${entries.join(",\n")}) AS activity_records`;
}

const meetingResults: Record<string, string> = {
  "1": "Interested", "2": "Not Interested", "3": "Matured", "4": "WIP", "5": "Renewed", "6": "Closed",
  "7": "Hot Prospective - 15 Days", "8": "Warm Prospective > 15 Days", "9": "Not Met", "10": "Service Meeting", "11": "Sales Meeting",
};
const callResults: Record<string, string> = { "1": "Not talked", "2": "Talked", "3": "Talked and appointment", "4": "Not talked and appointment" };

function text(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

export function isSuccessfulMeeting(record: DbRecord): boolean {
  const result = text(record.sts_dsr_meeting_result);
  const mode = text(record.sts_dsr_meeting_mode);
  // Match ERP nsdTaskTracker/getMeetingData.go IS_SUCCESSFUL exactly.
  return result !== null && result !== "9" && (mode === "0" || (mode === "1" && text(record.sts_dsr_meeting_verify_status) === "9"));
}

function timestamp(event: Interaction): number {
  const number = event.at ? Date.parse(event.at) : NaN;
  return Number.isNaN(number) ? -Infinity : number;
}

function seconds(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function elapsed(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  return seconds((Date.parse(end) - Date.parse(start)) / 1000);
}

function ucid(record: DbRecord): string | null {
  const value = text(record.ucid)?.trim();
  return value && !["0", "null", "na", "n/a"].includes(value.toLowerCase()) ? value : null;
}

const purposes: Record<string, string> = {
  "-1": "Feedback", "-2": "Ticket", "2": "Pre-renewal", "3": "Renewal - fresh", "4": "Upsell - fresh",
  "11": "Engagement", "15": "Upsell - follow up", "17": "Welcome meeting", "24": "Renewal - follow up",
  "30": "Others", "58": "Renewal", "59": "Upsell", "60": "Servicing",
};
const meetingPurposes: Record<string, string> = {
  "4": "Renewal - fresh", "5": "Feedback", "8": "Pre-renewal", "11": "Engagement", "13": "Upsell - fresh",
  "15": "Upsell - follow up", "17": "Welcome meeting", "18": "Renewal - follow up", "30": "Others", "31": "Ticket",
  "42": "Welcome call", "58": "Renewal", "59": "Upsell", "60": "Servicing",
};

export function summarizeActivity(records: Record<string, DbRecord[]>, assignments: Assignment[]): UserActivity {
  const clickByUcid = new Map((records.click_to_call ?? []).filter((row) => ucid(row)).map((row) => [ucid(row), row]));
  const authByCall = new Map<string, DbRecord>();
  for (const auth of records.sts_dsr_auth ?? []) {
    const id = text(auth.fk_sts_dsr_call_id);
    if (!id) continue;
    const previous = authByCall.get(id);
    if (!previous || BigInt(String(auth.sts_dsr_auth_id ?? 0)) > BigInt(String(previous.sts_dsr_auth_id ?? 0))) authByCall.set(id, auth);
  }
  const events = (source: string, id: string, date: string, employee: string, status: string, outcome?: string): Interaction[] =>
    (records[source] ?? []).map((raw) => {
      const { _employee_name, ...record } = raw;
      const result = outcome ? text(raw[outcome]) : null;
      const call = source === "click_to_call" ? raw : source === "sts_dsr_call" ? clickByUcid.get(ucid(raw)) : undefined;
      const isMeeting = source === "sts_dsr_meeting";
      const mode = isMeeting ? text(raw.sts_dsr_meeting_mode) : null;
      const auth = isMeeting ? authByCall.get(String(raw.fk_sts_dsr_call_id)) : undefined;
      const recordedAt = text(raw.sts_dsr_meeting_entrydate ?? raw.sts_dsr_sales_entrydate ?? raw.sts_dsr_call_entrydate ?? raw.entered_on);
      const startedAt = isMeeting ? mode === "1" ? text(raw.virtual_meet_start_time) : mode === "0" ? text(auth?.auth_verification_time) : null
        : source === "sts_dsr_sales" ? text(raw.sts_dsr_sales_date) : text(call?.call_start_time);
      const endedAt = isMeeting ? mode === "1" ? text(raw.virtual_meet_end_time) : mode === "0" ? recordedAt : null
        : source === "sts_dsr_sales" ? text(raw.sts_dsr_sales_end_date) : text(call?.call_end_time);
      const durationSeconds = isMeeting ? (mode === "1" ? seconds(raw.video_meet_duration_sec) : null) ?? elapsed(startedAt, endedAt)
        : source === "sts_dsr_sales" ? elapsed(startedAt, endedAt) : seconds(call?.call_duration) ?? elapsed(startedAt, endedAt);
      const purposeCode = text(raw.sts_dsr_call_purpose ?? raw.sts_dsr_meeting_purpose);
      const purpose = purposeCode ? (isMeeting ? meetingPurposes : purposes)[purposeCode] ?? `Purpose ${purposeCode}` : text(raw.service_name);
      const callId = ucid(raw);
      return {
        id: String(raw[id]), source, at: text(raw[date]), employeeId: text(raw[employee]), employeeName: text(_employee_name),
        status: text(raw[status]),
        outcome: source === "sts_dsr_meeting" ? (result ? meetingResults[result] ?? `Result ${result}` : null)
          : source === "sts_dsr_call" ? (result ? callResults[result] ?? `Result ${result}` : null) : result,
        successful: source === "sts_dsr_meeting" ? isSuccessfulMeeting(raw) : null,
        callKey: callId ? `ucid:${callId}` : `${source}:${raw[id]}`,
        startedAt, endedAt, recordedAt, durationSeconds,
        durationBasis: durationSeconds === null ? null : isMeeting && mode === "0" ? "ERP: auth verification to meeting entry" : source === "sts_dsr_sales" ? "Sales start to end" : isMeeting ? "Video meeting" : "Click-to-call duration",
        purpose, mode: isMeeting ? mode === "0" ? "Physical" : mode === "1" ? "Video" : mode : text(raw.flag_in_out),
        recordingUrl: text(call?.call_recording_url),
        record,
      };
    });
  const calls = [
    ...events("click_to_call", "click_to_call_id", "call_start_time", "fk_employeeid", "status"),
    ...events("sts_dsr_call", "sts_dsr_call_id", "sts_dsr_call_entrydate", "sts_dsr_call_by", "sts_dsr_call_status", "sts_dsr_call_result"),
  ];
  const meetings = events("sts_dsr_meeting", "sts_dsr_meeting_id", "sts_dsr_meeting_date", "sts_dsr_meeting_by", "sts_dsr_meeting_status", "sts_dsr_meeting_result");
  const salesMeetings = events("sts_dsr_sales", "sts_dsr_sales_id", "sts_dsr_sales_date", "sts_dsr_sales_by", "sts_dsr_sales_status");
  for (const list of [calls, meetings, salesMeetings]) list.sort((a, b) => timestamp(b) - timestamp(a));
  const assignedIds = new Set(assignments.map((a) => a.employee?.employeeId ?? text(a.record.assignedto)).filter(Boolean));
  const latest = (list: Interaction[]) => list.find((event) => Number.isFinite(timestamp(event))) ?? null;
  const uniqueCalls = new Set(calls.map((call) => call.callKey));
  const dsrCalls = new Map(calls.filter((call) => call.source === "sts_dsr_call").map((call) => [call.id, call]));
  const successfulMeetings = meetings.filter((meeting) => meeting.successful);
  const convertedCalls = new Set<string>();
  let unlinkedSuccessfulMeetingCount = 0;
  for (const meeting of successfulMeetings) {
    const call = dsrCalls.get(String(meeting.record.fk_sts_dsr_call_id));
    if (call) convertedCalls.add(call.callKey);
    else unlinkedSuccessfulMeetingCount++;
  }
  return {
    metrics: {
      callCount: uniqueCalls.size, meetingCount: meetings.length, successfulMeetingCount: successfulMeetings.length,
      convertedCallCount: convertedCalls.size,
      callToMeetingPercent: uniqueCalls.size ? convertedCalls.size / uniqueCalls.size * 100 : null,
      unlinkedSuccessfulMeetingCount,
    },
    lastCall: latest(calls), lastAssignedEmployeeCall: latest(calls.filter((call) => assignedIds.has(call.employeeId))),
    lastMeeting: latest(meetings), lastSuccessfulMeeting: latest(meetings.filter((meeting) => meeting.successful)),
    calls, meetings, salesMeetings,
    relatedRecords: Object.fromEntries(Object.entries(records).filter(([key]) => !["click_to_call", "sts_dsr_call", "sts_dsr_meeting", "sts_dsr_sales"].includes(key))),
    successRule: "Physical: meeting result is not 9 (Not Met). Video: result is not 9 and verification status is 9. Null or unknown modes are not successful. Based on ERP nsdTaskTracker/getMeetingData.go. Sales meetings are reported separately without inferring success.",
  };
}
