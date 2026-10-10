import type { GlobalContextResult } from "./global-context-catalog";
import type { Prediction } from "./best-time-types";
import type { RecordingAnalysis } from "./recording-types";
import type { RunTrace } from "./pipeline-trace";

export type DbRecord = Record<string, unknown>;
export type Assignment = {
  record: DbRecord;
  employee: { employeeId: string; name: string | null; verticalId: string | null } | null;
  vertical: { id: string; name: string | null } | null;
};
export type Interaction = {
  id: string;
  source: string;
  at: string | null;
  employeeId: string | null;
  employeeName: string | null;
  status: string | null;
  outcome: string | null;
  successful: boolean | null;
  callKey: string;
  startedAt: string | null;
  endedAt: string | null;
  recordedAt: string | null;
  durationSeconds: number | null;
  durationBasis: string | null;
  purpose: string | null;
  mode: string | null;
  recordingUrl: string | null;
  record: DbRecord;
};
export type UserActivity = {
  metrics: {
    callCount: number;
    meetingCount: number;
    successfulMeetingCount: number;
    convertedCallCount: number;
    callToMeetingPercent: number | null;
    unlinkedSuccessfulMeetingCount: number;
  };
  lastCall: Interaction | null;
  lastAssignedEmployeeCall: Interaction | null;
  lastMeeting: Interaction | null;
  lastSuccessfulMeeting: Interaction | null;
  calls: Interaction[];
  meetings: Interaction[];
  salesMeetings: Interaction[];
  relatedRecords: Record<string, DbRecord[]>;
  successRule: string;
};
export type UserProfile = {
  glid: string;
  createdAt: string | null;
  customerType: string | null;
  designation: string | null;
  lastLoginAt: string | null;
  glusr_usr: DbRecord;
  company: DbRecord[];
  assignments: Assignment[];
  activity: UserActivity;
  historyFetched?: boolean;
  callPolicy?: { doNotCallMarkedAt: string | null };
  /** Cached Sarvam analyses of this seller's call recordings, newest first. */
  recordingAnalyses?: RecordingAnalysis[];
};
export type UserLookup = {
  lookupId: string;
  fetchedAt: string;
  source: { id: number; name: string };
  requestedGlids: string[];
  missingGlids: string[];
  users: UserProfile[];
  globalContexts: GlobalContextResult[];
  predictions?: Prediction[];
  /** Previous-call transcripts pasted with this lookup, as analysed by Sarvam. */
  callContext?: { glid: string; analyses: RecordingAnalysis[] } | null;
  /** Stages this build actually ran, with timings (see lib/pipeline-trace.ts). */
  trace?: RunTrace;
};
