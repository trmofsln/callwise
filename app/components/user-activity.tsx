import { useState } from "react";
import type { Interaction, UserActivity } from "@/lib/user-types";
import { DevJson, useDevMode } from "./dev-mode";

function dateTime(value: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function datePart(value: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(date);
}

function timePart(value: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IN", { timeStyle: "medium" }).format(date);
}

function duration(seconds: number | null) {
  if (seconds === null) return "Not recorded";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  return `${hours ? `${hours}h ` : ""}${minutes ? `${minutes}m ` : ""}${total % 60}s`;
}

function recordingLink(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function EventDetails({ event }: { event: Interaction }) {
  const link = recordingLink(event.recordingUrl);
  const fields = Object.entries(event.record).filter(([, value]) => value !== null && value !== undefined && value !== "");
  return <details className="record-details"><summary>All details</summary><div className="event-detail-panel">
    <dl className="event-fields">
      {event.startedAt && <div><dt>Start</dt><dd>{dateTime(event.startedAt)}</dd></div>}
      {event.endedAt && <div><dt>End</dt><dd>{dateTime(event.endedAt)}</dd></div>}
      {event.recordedAt && <div><dt>Recorded at</dt><dd>{dateTime(event.recordedAt)}</dd></div>}
      {fields.map(([key, value]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}
    </dl>
    {link && <a className="recording-link" href={link} target="_blank" rel="noopener noreferrer">Open call recording ↗</a>}
    <DevJson className="raw-record" label="Raw record JSON" data={event.record} />
  </div></details>;
}

function LatestEvent({ title, event }: { title: string; event: Interaction | null }) {
  return <div><dt>{title}</dt><dd>{event ? datePart(event.at) : "No record found"}</dd>
    {event && <><small>{event.startedAt ? `Start ${timePart(event.startedAt)}` : event.recordedAt ? `Recorded ${timePart(event.recordedAt)}` : "Time not recorded"}</small><small>{event.employeeName || "Employee"}{event.employeeId ? ` · ${event.employeeId}` : ""}</small><small>{event.outcome || event.source.replaceAll("_", " ")}</small></>}
  </div>;
}

function History({ title, events }: { title: string; events: Interaction[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? events : events.slice(0, 20);
  return <details className="history-section"><summary>{title} <span className="history-count">{events.length}</span></summary>
    {!events.length ? <p className="muted">No linked records found.</p> : <>
      <div className="table-wrap"><table className="activity-table"><thead><tr><th>Date & source</th><th>Time</th><th>Duration</th><th>Employee</th><th>Outcome & purpose</th><th>Details</th></tr></thead><tbody>
        {visible.map((event) => <tr key={`${event.source}-${event.id}`}>
          <td>{datePart(event.at)}<small>{event.source} · {event.id}</small></td>
          <td>{timePart(event.startedAt ?? event.recordedAt)}<small>{event.startedAt ? "Start time" : event.recordedAt ? "Recorded time" : "Time unavailable"}</small>{event.endedAt && <small>End {timePart(event.endedAt)}</small>}</td>
          <td>{event.durationSeconds === null && event.record.call_duration !== null && event.record.call_duration !== undefined
            ? <>{String(event.record.call_duration)}<small>Stored duration · unit unavailable</small></> : duration(event.durationSeconds)}{event.durationBasis && <small>{event.durationBasis}</small>}</td>
          <td>{event.employeeName || "Not available"}<small>{event.employeeId || "ID unavailable"}</small></td>
          <td>{event.outcome || (event.status ? `Status ${event.status}` : "Not available")}
            {event.purpose && <small>{event.purpose}</small>}{event.source === "sts_dsr_meeting" && event.mode && <small>{event.mode} meeting</small>}
            {event.successful !== null && <small className={event.successful ? "success-label" : ""}>{event.successful ? "Successful meeting" : "Not successful"}</small>}
          </td>
          <td><EventDetails event={event} /></td>
        </tr>)}
      </tbody></table></div>
      {events.length > 20 && <button className="secondary history-more" onClick={() => setShowAll(!showAll)}>{showAll ? "Show latest 20" : `Show all ${events.length} records`}</button>}
    </>}
  </details>;
}

export default function UserActivitySection({ activity }: { activity: UserActivity }) {
  const dev = useDevMode();
  return <section className="card-section activity-section">
    <h3>Calls & meetings</h3>
    <div className="activity-metrics">
      <div><span>Total calls</span><strong>{activity.metrics.callCount}</strong><small>Unique calls across both sources</small></div>
      <div><span>Total meetings</span><strong>{activity.metrics.meetingCount}</strong><small>DSR meeting records</small></div>
      <div><span>Successful meetings</span><strong>{activity.metrics.successfulMeetingCount}</strong><small>Completed under the ERP rule</small></div>
      <div><span>Call → meeting conversion</span><strong>{activity.metrics.callToMeetingPercent === null ? "N/A" : `${activity.metrics.callToMeetingPercent.toFixed(1)}%`}</strong><small>{activity.metrics.convertedCallCount} / {activity.metrics.callCount} calls linked to successful meetings</small></div>
    </div>
    <p className="source-note">All fetched history. Calls sharing a UCID count once. Conversion counts each call linked to a successful DSR meeting once; sales meeting records are separate.{activity.metrics.unlinkedSuccessfulMeetingCount > 0 && ` ${activity.metrics.unlinkedSuccessfulMeetingCount} successful meeting(s) have no matching fetched call and are excluded from conversion.`}</p>
    <dl className="facts activity-facts">
      <LatestEvent title="Last call · any employee" event={activity.lastCall} />
      <LatestEvent title="Last call · assigned employee" event={activity.lastAssignedEmployeeCall} />
      <LatestEvent title="Last DSR meeting" event={activity.lastMeeting} />
      <LatestEvent title="Last successful DSR meeting" event={activity.lastSuccessfulMeeting} />
    </dl>
    <p className="source-note">Calls are linked to this GLID. Assigned-employee calls match its current assignment. Meeting success follows the ERP rule: physical meetings exclude “Not Met”; video meetings also need verification status 9.</p>
    <History title="Call history" events={activity.calls} />
    <History title="Meeting history" events={activity.meetings} />
    <History title="Sales meeting history" events={activity.salesMeetings} />
    <details className="history-section"><summary>Additional activity data <span className="history-count">{Object.values(activity.relatedRecords).reduce((sum, records) => sum + records.length, 0)}</span></summary>
      <p className="muted">Meeting sessions, trust scores, welcome meetings, authentication records, and call feedback.</p>
      {dev
        ? Object.entries(activity.relatedRecords).map(([source, records]) => <DevJson key={source} className="record-details" label={`${source} (${records.length})`} data={records} />)
        : <ul className="related-counts">{Object.entries(activity.relatedRecords).map(([source, records]) => <li key={source}><span>{source.replaceAll("_", " ")}</span><strong>{records.length}</strong></li>)}</ul>}
    </details>
  </section>;
}
