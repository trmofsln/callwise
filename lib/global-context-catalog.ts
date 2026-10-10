// Segment names and documented attribute paths from the supplied Global Context Keys PDF.
export const GLOBAL_CONTEXT_CATALOG = [
  { key: "kycdetails", label: "KYC & account", keys: [
    "company_name", "customer_name", "stsid", "address", "address_verification_status", "city", "company_type",
    "input_mobile_verification_status", "input_email_verification_status", "gst_registration_since", "gst_new", "gst_status",
    "gst_turnover", "gst_nature_of_business", "registered_since_with_indiamart", "customer_type", "payment_plan", "highest_service",
    "customer_vintage", "nach_status.DIS_TEXT", "nach_status.NACH_NEXT_DEDUCTION", "nach_stopped_date", "high_churn",
    "high_risk_suspected", "top_city_rest_of_india", "wip_wo", "rating_count", "avg_rating_count", "account_manager_bd.name",
    "account_manager_fsf.name", "first_name", "last_name", "glusr_usr_listing_status", "glusr_usr_approv", "glusr_disabled_reason",
    "email1", "freeshowroom_alias_im", "fcp_flag", "vertical_name", "glusr_customer_type", "SERVICE_VINTAGE", "catalog_url",
    "ticket_count", "approved_product_count", "payment_invoice_date", "payment_receipt_date", "bl_active_dau_30",
    "LAST_TICKETS_CLM_FEEDBACK", "WIP_TICKET_BUCKET", "LAST_10SUPPLIER_ACTIVITIES", "gst_availability", "last_call_details",
  ] },
  { key: "connectdetails", label: "Calls & meetings · 7 / 30 days", keys: [
    "last_call_summary", "connect_7D.call_answered_transcript",
    ...["connect_7D", "connect_30D"].flatMap((period) => ["call_answered_date", "call_by",
      "call_answered_summary", "video_verified_date", "video_meet_by", "video_meet_sts_update", "meet_sucessful_date", "met_by", "meet_sts_update"].map((key) => `${period}.${key}`)),
  ] },
  { key: "ticketsdetails", label: "Tickets & complaints", keys: [
    "current.tickets.ticket_opening_comments", "current.tickets.ticket_type",
    ...["last_7_days", "last_8_to_90_days"].flatMap((period) => ["tickets.ticket_issue_date", "tickets.ticket_status",
      "tickets.ticket_opening_comments", "total_ticket_count", "irate_complaint_count", "board_social_media_ticket_count",
      "negative_feedback_count", "whatsapp_negative_feedback_count"].map((key) => `${period}.${key}`)),
    "last_8_to_90_days.bs_conflict_status", "last_8_to_90_days.dt_ticket_count", "last_8_to_90_days.employee_ticket_count", "WIP_LEGAL_TICKETS", "WIP_OPS_TICKETS",
  ] },
  { key: "BLdetails", label: "BuyLead availability", keys: ["BL_available_gl_city", "active_bl_details", "bl_available_a_rank",
    "bl_available_a_rank_pref_city", "bl_available_pref_city", "glid", "upload_metadata"] },
  { key: "activitydetails", label: "Platform activity", keys: [
    "last_week.bl_active_days", "last_month.bl_active_days", "last_4_week.bl_active_days", "last_3_month.bl_active_days",
    ...["last_month", "last_4_week"].flatMap((period) => ["bl_cons", "cons_0_4_hrs", "cons_4_24_hrs", "cons_grter_1day",
      "cons_0_4_hrs_percent", "cons_4_24_hrs_percent", "cons_grter_1day_percent", "bl_credits_alctd", "bl_cons_app_percent",
      "bl_cons_desktop_percent", "bl_cons_mobile_percent", "blni", "enquiry", "lms_active_days", "prd_without_photo",
      "prd_without_price", "prd_without_ctg_mapping", "total_mcats", "a_rank_mcats", "high_sold_mcats_percent",
      "total_notifications", "notification_clicked_percent"].map((key) => `${period}.${key}`)),
    "last_week.blni", "last_week.enquiry", "enq_last_90_days", "pns_received_30_days", "last_4_week.pns_call_received",
    "pns_received_90_days", "last_3_month.lms_active_days", "last_month.cq_score", "last_month.high_sold_a_rank",
    "last_4_week.high_sold_mcats", "blni_wrng_product", "blni_loc", "blni_spec", "pmcat_count", "premium_ctg_without_primary_prd",
    "premium_ctg_without_a_rank", "negative_ctg_count", "negative_ctg_with_product_mapped", "preferred_cities_count",
    "notification_clicked", "location_preference", "total_negative_cities", "preferred_state", "total_hide",
  ] },
  { key: "duplicate_glids_details", label: "Duplicate users", keys: ["duplicate_glid", "duplicate_paid_ids"] },
  // The PDF lists the segment but does not supply attribute keys for Actual Data.
  { key: "ActualData", label: "Actual data", keys: [] },
] as const;

export const GLOBAL_CONTEXT_SEGMENTS = GLOBAL_CONTEXT_CATALOG.map((segment) => segment.key);

export type GlobalContextResult = {
  glid: string;
  status: "success" | "error" | "not_configured";
  mappingId: string | null;
  requestedSegments: string[];
  fetchedAt: string;
  data: unknown;
  response: unknown;
  error: string | null;
};

export function parseContextValue(value: unknown): unknown {
  if (typeof value !== "string" || !/^[\[{]/.test(value.trim())) return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function findContextSegment(data: unknown, segment: string, depth = 0): unknown {
  const value = parseContextValue(data);
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  const entries = Object.entries(value);
  const match = entries.find(([key]) => key === segment || key.endsWith(`:${segment}`));
  if (match) return parseContextValue(match[1]);
  for (const [, child] of entries) {
    const found = findContextSegment(child, segment, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}
