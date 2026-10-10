import { storedAnalyses } from "./recordings";
import type { PipelineTrace, RunStage } from "./pipeline-trace";
import { randomUUID } from "node:crypto";
import { kv } from "./kv";
import { RedashError, runQuery } from "./redash";
import type { Assignment, DbRecord, UserLookup, UserProfile } from "./user-types";
import { activitySelect, summarizeActivity } from "./user-activity";
import { fetchGlobalContexts } from "./global-context";
import { predictBatch } from "./best-time-service";

export const savedLookupKey = (lookupId: string, glid: string) => `lookup:${lookupId}:${glid}`;

export function parseGlids(input: unknown): string[] {
  if (typeof input !== "string" || !input.trim()) throw new RedashError("Enter at least one GLID.", 400);
  if (input.length > 2000) throw new RedashError("Enter up to 50 GLIDs.", 400);
  const values = input.split(",").map((value) => value.trim());
  if (values.some((value) => !/^[0-9]{1,19}$/.test(value) || BigInt(value) <= BigInt(0) || BigInt(value) > BigInt("9223372036854775807"))) {
    throw new RedashError("GLIDs must be positive whole numbers separated by commas.", 400);
  }
  const ids = [...new Set(values.map((value) => BigInt(value).toString()))];
  if (ids.length > 50) throw new RedashError("Look up at most 50 unique GLIDs at a time.", 400);
  return ids;
}

export function buildUserQuery(ids: string[]): string {
  // Validate again so only canonical integer literals can reach SQL.
  const safeIds = parseGlids(ids.join(","));
  return `SELECT g.glusr_usr_id::text AS glid,
    to_jsonb(g) AS glusr_usr,
    COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.companyid)
      FROM redash.company c WHERE c.fk_glusr_usr_id = g.glusr_usr_id), '[]'::jsonb) AS company,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'record', to_jsonb(s),
      'employee', CASE WHEN e.employeeid IS NULL THEN NULL ELSE jsonb_build_object(
        'employeeId', e.employeeid::text, 'name', e.employeename,
        'verticalId', e.fk_iil_vertical_id::text) END,
      'vertical', CASE WHEN v.iil_vertical_id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', v.iil_vertical_id::text, 'name', v.iil_vertical_name) END) ORDER BY s.companyid)
      FROM redash.sts_company s
      LEFT JOIN redash.employee e ON e.employeeid = s.assignedto
      LEFT JOIN redash.iil_vertical v ON v.iil_vertical_id = e.fk_iil_vertical_id
      WHERE s.sts_fk_glusr_id = g.glusr_usr_id), '[]'::jsonb) AS assignments,
    jsonb_build_object('doNotCallMarkedAt', (SELECT MAX(a.do_not_call_mark_date)
      FROM redash.hot_leads_assign a WHERE a.fk_glusr_usr_id = g.glusr_usr_id)) AS call_policy,
    ${activitySelect()}
    FROM redash.glusr_usr g
    WHERE g.glusr_usr_id IN (${safeIds.join(",")})
    ORDER BY g.glusr_usr_id`;
}

function jsonValue<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function text(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

/**
 * `callContext` resolves to Sarvam analyses of transcripts pasted with this lookup. It runs alongside
 * the ERP query and is added to that seller's analysed calls for this lookup only.
 */
export async function lookupUsers(glids: string[], { callContext, trace }: { callContext?: Promise<UserLookup["callContext"]>; trace?: PipelineTrace } = {}): Promise<UserLookup> {
  const time = <T,>(id: RunStage, fn: () => Promise<T> | T, detail?: (r: T) => string): Promise<T> => trace ? trace.time(id, fn, detail) : Promise.resolve(fn());
  const dataSourceId = Number(process.env.REDASH_USER_DATA_SOURCE_ID ?? "13");
  if (dataSourceId !== 13) throw new RedashError("This lookup is mapped to pg-main-prod-live (source 13).", 503);
  // The ERP query and Global Context run in parallel (and the pasted-call analysis started by the route).
  const [{ rows }, globalContexts] = await Promise.all([
    time("redash_query", () => runQuery({ query: buildUserQuery(glids), dataSourceId, maxAge: 0, queryIdEnv: "REDDASH_USER_QUERY_ID" }), r => `${r.rows.length} user row(s) from source ${dataSourceId}`),
    time("global_context", () => fetchGlobalContexts(glids), r => `${r.filter(c => c.status === "success").length} of ${r.length} returned · ${r.filter(c => c.status === "not_configured").length} not configured · ${r.filter(c => c.status === "error").length} error(s)`),
  ]);
  const byId = await time("build_profiles", () => {
    const map = new Map<string, UserProfile>();
    for (const row of rows) {
      const user = jsonValue<DbRecord>(row.glusr_usr);
      const glid = String(row.glid);
      const assignments = jsonValue<Assignment[]>(row.assignments);
      const records=jsonValue<Record<string, DbRecord[]>>(row.activity_records ?? {});
      map.set(glid, {
        glid,
        createdAt: text(user.glusr_usr_membersince),
        customerType: text(user.glusr_usr_custtype_name),
        designation: text(user.glusr_usr_designation),
        lastLoginAt: text(user.glusr_usr_lastlogin),
        glusr_usr: user,
        company: jsonValue<DbRecord[]>(row.company),
        assignments,
        activity: summarizeActivity(records, assignments),
        historyFetched: Array.isArray(records.click_to_call) && Array.isArray(records.sts_dsr_call),
        callPolicy: row.call_policy?jsonValue<UserProfile["callPolicy"]>(row.call_policy):undefined,
      });
    }
    return map;
  }, m => `${m.size} of ${glids.length} GLID(s) have an ERP user record`);
  const result: UserLookup = {
    lookupId: randomUUID(), fetchedAt: new Date().toISOString(),
    source: { id: dataSourceId, name: "pg-main-prod-live" },
    requestedGlids: glids,
    missingGlids: glids.filter((id) => !byId.has(id)),
    users: glids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []),
    globalContexts,
  };
  await time("attach_analyses", async () => {
    const [analyses,pasted]=await Promise.all([storedAnalyses(result.users.map(u=>u.glid)),callContext]);
    for(const user of result.users)user.recordingAnalyses=[...(pasted?.glid===user.glid?pasted.analyses:[]),...(analyses.get(user.glid)??[])];
    result.callContext=pasted??null;
    return { cached: [...analyses.values()].reduce((n, list) => n + list.length, 0), pasted: pasted?.analyses.length ?? 0 };
  }, r => `${r.cached} cached analysis(es) · ${r.pasted} pasted call(s)`);
  result.predictions=await time("predict_batch", () => predictBatch(glids,result.users,result.fetchedAt,{globalContexts}), p => `${p.length} seller(s) · ${p.filter(x => x.llm_status.status === "reviewed").length} reviewed by LLM · ${p.filter(x => x.pipeline?.validation.replaced_with_rules).length} replaced by the validator`);
  await time("save_lookup", async () => {
    // One record per seller, kept for 3 days: what the post-call retry planner needs without a second ERP query.
    await Promise.all(result.users.map(user => kv().set(savedLookupKey(result.lookupId, user.glid), { user, globalContext: globalContexts.find(g => g.glid === user.glid) ?? null }, 3 * 86_400)));
  }, () => "Lookup saved for the post-call retry planner");
  if (trace) result.trace = trace.toJSON();
  return result;
}

