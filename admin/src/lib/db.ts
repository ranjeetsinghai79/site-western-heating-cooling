import { Pool } from "@/lib/pool"

// Lazy pool — CF Workers injects process.env only at request time, not module load
let _pool: Pool | null = null
function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL })
  return _pool
}

// ── Lead ─────────────────────────────────────────────────────────────────────

export interface Lead {
  id: string
  name: string
  niche: string
  city: string
  state: string
  phone?: string
  email?: string
  website?: string
  tier?: string
  client_plan?: string
  status: string
  site_score?: number
  cloudflare_url?: string
  vercel_url?: string
  github_repo?: string
  rating?: number
  review_count?: number
  paid?: boolean
  stripe_payment_link?: string
  stripe_customer_id?: string
  stripe_subscription_id?: string
  subscription_active?: boolean
  subscription_plan?: string
  location_group_id?: string
  vapi_assistant_id?: string
  vapi_phone_number?: string
  webhook_url?: string
  created_at?: string
  // call tracking
  last_call_at?: string
  call_status?: string
  call_sid?: string
  call_count?: number
  sms_opt_out?: boolean
}

export async function getLeads(): Promise<Lead[]> {
  const { rows } = await pool().query<Lead>(`
    SELECT id, name, niche, city, state, phone, email, website,
           tier, status, site_score, cloudflare_url, vercel_url,
           github_repo, rating, review_count, paid, created_at,
           last_call_at, call_status, call_count, sms_opt_out
    FROM leads
    ORDER BY created_at DESC
    LIMIT 500
  `)
  return rows
}

export async function updateCallTracking(
  id: string,
  callSid: string,
  status: string,
): Promise<void> {
  await pool().query(
    `UPDATE leads
     SET call_sid = $2, call_status = $3, last_call_at = NOW(),
         call_count = COALESCE(call_count, 0) + 1
     WHERE id = $1`,
    [id, callSid, status],
  )
}

export async function setCallStatus(id: string, status: string): Promise<void> {
  await pool().query(`UPDATE leads SET call_status = $2 WHERE id = $1`, [id, status])
}

export async function setOptOut(id: string): Promise<void> {
  await pool().query(
    `UPDATE leads SET sms_opt_out = true, call_status = 'opted_out' WHERE id = $1`,
    [id],
  )
}

export async function getRecentLeads(limit = 8): Promise<Lead[]> {
  const { rows } = await pool().query<Lead>(
    `SELECT id, name, niche, city, state, status, tier, cloudflare_url, vercel_url, created_at
     FROM leads ORDER BY created_at DESC LIMIT $1`,
    [limit]
  )
  return rows
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export interface FullStats {
  total:      number
  processing: number
  deployed:   number
  paid:       number
  errors:     number
  skipped:    number
}

export async function getFullStats(): Promise<FullStats> {
  const { rows } = await pool().query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status IN ('found','scored','analyzed','config_generated','built')) AS processing,
      COUNT(*) FILTER (WHERE status IN ('deployed','outreach_sent','sms_sent','conversation_active','meeting_scheduled','payment_link_sent')) AS deployed,
      COUNT(*) FILTER (WHERE paid = TRUE OR status IN ('paid','handed_off')) AS paid,
      COUNT(*) FILTER (WHERE status = 'error') AS errors,
      COUNT(*) FILTER (WHERE status = 'skipped') AS skipped
    FROM leads
  `)
  const r = rows[0]
  return {
    total:      Number(r.total),
    processing: Number(r.processing),
    deployed:   Number(r.deployed),
    paid:       Number(r.paid),
    errors:     Number(r.errors),
    skipped:    Number(r.skipped),
  }
}

// Legacy compat
export async function getStats() {
  const s = await getFullStats()
  return { total: s.total, deployed: s.deployed, paid: s.paid, errors: s.errors }
}

export interface FunnelStage { group: string; count: number; color: string }

const FUNNEL_ORDER = ["Processing", "Live", "Engaged", "Converted", "Skipped", "Error"]

export async function getFunnelData(): Promise<FunnelStage[]> {
  const { rows } = await pool().query(`
    SELECT
      CASE
        WHEN status IN ('found','scored','analyzed','config_generated','built') THEN 'Processing'
        WHEN status IN ('deployed','outreach_sent','sms_sent') THEN 'Live'
        WHEN status IN ('conversation_active','meeting_scheduled','payment_link_sent') THEN 'Engaged'
        WHEN status IN ('paid','handed_off') THEN 'Converted'
        WHEN status = 'skipped' THEN 'Skipped'
        ELSE 'Error'
      END AS grp,
      COUNT(*) AS count
    FROM leads
    GROUP BY grp
  `)
  const colors: Record<string, string> = {
    Processing: "#6366f1",
    Live:       "#10b981",
    Engaged:    "#3b82f6",
    Converted:  "#22c55e",
    Skipped:    "#475569",
    Error:      "#ef4444",
  }
  const map = Object.fromEntries(rows.map(r => [r.grp, Number(r.count)]))
  return FUNNEL_ORDER.map(g => ({ group: g, count: map[g] ?? 0, color: colors[g] }))
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function setLeadTier(id: string, tier: string): Promise<void> {
  await pool().query(`UPDATE leads SET tier=$1 WHERE id=$2`, [tier, id])
}

export async function setLeadStatus(id: string, status: string): Promise<void> {
  await pool().query(`UPDATE leads SET status=$1 WHERE id=$2`, [status, id])
}

export async function markLeadPaid(id: string): Promise<void> {
  await pool().query(
    `UPDATE leads SET paid=TRUE, status='handed_off' WHERE id=$1`,
    [id]
  )
}

export async function deleteLead(id: string): Promise<void> {
  await pool().query(`DELETE FROM leads WHERE id=$1`, [id])
}

export async function setLeadEmail(id: string, email: string): Promise<void> {
  await pool().query(`UPDATE leads SET email=$1 WHERE id=$2`, [email || null, id])
}

export async function getCallLeads(): Promise<Lead[]> {
  const { rows } = await pool().query<Lead>(`
    SELECT id, name, niche, city, state, phone, email, website,
           tier, status, rating, review_count, cloudflare_url, vercel_url, created_at
    FROM leads
    WHERE phone IS NOT NULL
      AND status IN ('found','scored','called','interested')
    ORDER BY
      CASE WHEN status = 'interested' THEN 0
           WHEN status = 'called' THEN 2
           ELSE 1
      END,
      (website IS NULL) DESC,
      rating DESC NULLS LAST,
      created_at DESC
    LIMIT 200
  `)
  return rows
}

export interface SurveyResponse {
  id: string
  created_at: string
  name: string | null
  biz: string | null
  phone: string | null
  niche: string | null
  pain: string | null
  has_website: string | null
  ai_want: string | null
  budget: string | null
}

export async function getSurveyResponses(): Promise<SurveyResponse[]> {
  try {
    const { rows } = await pool().query<SurveyResponse>(`
      SELECT id, created_at, name, biz, phone, niche, pain, has_website, ai_want, budget
      FROM survey_responses
      ORDER BY created_at DESC
      LIMIT 500
    `)
    return rows
  } catch {
    return []
  }
}

export interface BusinessManagerSummary {
  workspace_id: string
  business_name: string
  website_url: string
  industry: string | null
  city: string | null
  autonomy_level: number
  plan_id: string | null
  plan_summary: string | null
  plan_priority: string | null
  queued_tasks: number
  approval_tasks: number
  memory_chunks: number
  social_drafts: number
  ad_drafts: number
  video_drafts: number
  crm_events: number
  updated_at: string
}

export async function getBusinessManagerSummaries(): Promise<BusinessManagerSummary[]> {
  try {
    const { rows } = await pool().query<BusinessManagerSummary>(`
      SELECT
        gw.id AS workspace_id,
        gw.business_name,
        gw.website_url,
        gw.industry,
        gw.city,
        gw.autonomy_level,
        gp.id AS plan_id,
        gp.summary AS plan_summary,
        gp.priority AS plan_priority,
        COUNT(DISTINCT gat.id) FILTER (WHERE gat.status = 'queued') AS queued_tasks,
        COUNT(DISTINCT gat.id) FILTER (WHERE gat.status = 'needs_approval') AS approval_tasks,
        COUNT(DISTINCT mc.id) AS memory_chunks,
        COUNT(DISTINCT sa.id) FILTER (WHERE sa.status IN ('draft','needs_approval')) AS social_drafts,
        COUNT(DISTINCT acd.id) FILTER (WHERE acd.status IN ('draft','needs_approval')) AS ad_drafts,
        COUNT(DISTINCT va.id) FILTER (WHERE va.status IN ('draft','needs_approval','approved','rendering')) AS video_drafts,
        COUNT(DISTINCT cse.id) AS crm_events,
        gw.updated_at::text
      FROM growth_workspaces gw
      LEFT JOIN growth_plans gp ON gp.id = gw.current_plan_id
      LEFT JOIN growth_agent_tasks gat ON gat.workspace_id = gw.id
      LEFT JOIN memory_chunks mc ON mc.workspace_id = gw.id
      LEFT JOIN social_assets sa ON sa.workspace_id = gw.id
      LEFT JOIN ad_campaign_drafts acd ON acd.workspace_id = gw.id
      LEFT JOIN video_assets va ON va.workspace_id = gw.id
      LEFT JOIN crm_sync_events cse ON cse.workspace_id = gw.id
      GROUP BY gw.id, gp.id
      ORDER BY gw.updated_at DESC
      LIMIT 100
    `)
    return rows.map((row) => ({
      ...row,
      queued_tasks: Number(row.queued_tasks),
      approval_tasks: Number(row.approval_tasks),
      memory_chunks: Number(row.memory_chunks),
      social_drafts: Number(row.social_drafts),
      ad_drafts: Number(row.ad_drafts),
      video_drafts: Number(row.video_drafts),
      crm_events: Number(row.crm_events),
    }))
  } catch {
    return []
  }
}

export interface FrontOfficeActivity {
  kind: "task" | "social" | "ad" | "video" | "crm"
  workspace_id: string
  business_name: string
  title: string
  status: string
  priority: string | null
  created_at: string
}

export async function getFrontOfficeActivity(): Promise<FrontOfficeActivity[]> {
  try {
    const { rows } = await pool().query<FrontOfficeActivity>(`
      SELECT * FROM (
        SELECT 'task' AS kind, gw.id AS workspace_id, gw.business_name,
               gat.title, gat.status, gat.priority, gat.created_at::text
        FROM growth_agent_tasks gat
        JOIN growth_workspaces gw ON gw.id = gat.workspace_id
        UNION ALL
        SELECT 'social' AS kind, gw.id AS workspace_id, gw.business_name,
               sa.title, sa.status, NULL AS priority, sa.created_at::text
        FROM social_assets sa
        JOIN growth_workspaces gw ON gw.id = sa.workspace_id
        UNION ALL
        SELECT 'ad' AS kind, gw.id AS workspace_id, gw.business_name,
               acd.campaign_name AS title, acd.status, NULL AS priority, acd.created_at::text
        FROM ad_campaign_drafts acd
        JOIN growth_workspaces gw ON gw.id = acd.workspace_id
        UNION ALL
        SELECT 'video' AS kind, gw.id AS workspace_id, gw.business_name,
               va.title, va.status, NULL AS priority, va.created_at::text
        FROM video_assets va
        JOIN growth_workspaces gw ON gw.id = va.workspace_id
        UNION ALL
        SELECT 'crm' AS kind, gw.id AS workspace_id, gw.business_name,
               cse.event_type AS title, cse.status, NULL AS priority, cse.created_at::text
        FROM crm_sync_events cse
        JOIN growth_workspaces gw ON gw.id = cse.workspace_id
      ) x
      ORDER BY created_at DESC
      LIMIT 80
    `)
    return rows
  } catch {
    return []
  }
}

export interface PendingApproval {
  entity_type: "task" | "social" | "ad" | "video"
  entity_id: string
  workspace_id: string
  business_name: string
  title: string
  status: string
  detail: string | null
  compliance_warnings: string[]
  created_at: string
}

export async function getPendingApprovals(): Promise<PendingApproval[]> {
  try {
    const { rows } = await pool().query<PendingApproval>(`
      SELECT * FROM (
        SELECT 'task' AS entity_type, gat.id AS entity_id, gw.id AS workspace_id, gw.business_name,
               gat.title, gat.status, gat.priority AS detail,
               '[]'::jsonb AS compliance_warnings, gat.created_at::text
        FROM growth_agent_tasks gat
        JOIN growth_workspaces gw ON gw.id = gat.workspace_id
        WHERE gat.status = 'needs_approval'
        UNION ALL
        SELECT 'social' AS entity_type, sa.id::text AS entity_id, gw.id AS workspace_id, gw.business_name,
               sa.title, sa.status, sa.platform AS detail,
               sa.compliance_warnings, sa.created_at::text
        FROM social_assets sa
        JOIN growth_workspaces gw ON gw.id = sa.workspace_id
        WHERE sa.status = 'needs_approval'
        UNION ALL
        SELECT 'ad' AS entity_type, acd.id::text AS entity_id, gw.id AS workspace_id, gw.business_name,
               acd.campaign_name AS title, acd.status, acd.platform || ' · $' || acd.daily_budget::text || '/day' AS detail,
               acd.compliance_warnings, acd.created_at::text
        FROM ad_campaign_drafts acd
        JOIN growth_workspaces gw ON gw.id = acd.workspace_id
        WHERE acd.status = 'needs_approval'
        UNION ALL
        SELECT 'video' AS entity_type, va.id::text AS entity_id, gw.id AS workspace_id, gw.business_name,
               va.title, va.status, va.platform || ' · ' || va.duration_sec::text || 's · ' || va.aspect_ratio AS detail,
               va.compliance_warnings, va.created_at::text
        FROM video_assets va
        JOIN growth_workspaces gw ON gw.id = va.workspace_id
        WHERE va.status = 'needs_approval'
      ) x
      ORDER BY created_at DESC
      LIMIT 100
    `)
    return rows.map((row) => ({
      ...row,
      compliance_warnings: row.compliance_warnings ?? [],
    }))
  } catch {
    return []
  }
}

export interface IntegrationStatus {
  provider: string
  status: string
  account_label: string | null
  connected_at: string | null
}

export async function getIntegrationStatuses(): Promise<IntegrationStatus[]> {
  const required = [
    "google_ads",
    "meta_ads",
    "instagram_ads",
    "facebook_page",
    "instagram",
    "threads",
    "linkedin",
    "google_business_profile",
    "pinterest",
    "tiktok",
    "x",
  ]
  try {
    const { rows } = await pool().query<IntegrationStatus>(`
      SELECT provider, status, account_label, connected_at::text
      FROM integration_connections
      WHERE provider = ANY($1::text[])
    `, [required])
    const byProvider = new Map(rows.map((row) => [row.provider, row]))
    return required.map((provider) => byProvider.get(provider) ?? {
      provider,
      status: "not_connected",
      account_label: null,
      connected_at: null,
    })
  } catch {
    return required.map((provider) => ({
      provider,
      status: "not_connected",
      account_label: null,
      connected_at: null,
    }))
  }
}

export interface PlatformOverview {
  agencies: number
  workspaces: number
  activeAgents: number
  activePlaybooks: number
  installedAgents: number
  queuedRuns: number
  failedRuns: number
  agents: Array<{
    id: string
    name: string
    category: string
    description: string
    version: string
    risk_level: "low" | "medium" | "high"
    default_requires_approval: boolean
    status: string
  }>
  playbooks: Array<{
    id: string
    name: string
    niche: string
    version: string
    description: string
    status: string
  }>
}

export async function getPlatformOverview(): Promise<PlatformOverview> {
  const empty: PlatformOverview = {
    agencies: 0,
    workspaces: 0,
    activeAgents: 0,
    activePlaybooks: 0,
    installedAgents: 0,
    queuedRuns: 0,
    failedRuns: 0,
    agents: [],
    playbooks: [],
  }

  try {
    const [counts, agents, playbooks] = await Promise.all([
      pool().query<{
        agencies: string
        workspaces: string
        active_agents: string
        active_playbooks: string
        installed_agents: string
        queued_runs: string
        failed_runs: string
      }>(`
        SELECT
          (SELECT COUNT(*) FROM agency_accounts WHERE status = 'active') AS agencies,
          (SELECT COUNT(*) FROM growth_workspaces WHERE agency_id IS NOT NULL) AS workspaces,
          (SELECT COUNT(*) FROM agent_definitions WHERE status = 'active') AS active_agents,
          (SELECT COUNT(*) FROM playbook_templates WHERE status = 'active') AS active_playbooks,
          (SELECT COUNT(*) FROM workspace_agent_installations WHERE enabled) AS installed_agents,
          (SELECT COUNT(*) FROM automation_runs WHERE status IN ('queued','running','needs_approval')) AS queued_runs,
          (SELECT COUNT(*) FROM automation_runs WHERE status = 'failed') AS failed_runs
      `),
      pool().query<PlatformOverview["agents"][number]>(`
        SELECT id, name, category, description, version, risk_level,
               default_requires_approval, status
        FROM agent_definitions
        ORDER BY category, name
      `),
      pool().query<PlatformOverview["playbooks"][number]>(`
        SELECT id, name, niche, version, description, status
        FROM playbook_templates
        ORDER BY niche, name
      `),
    ])
    const row = counts.rows[0]
    return {
      agencies: Number(row.agencies),
      workspaces: Number(row.workspaces),
      activeAgents: Number(row.active_agents),
      activePlaybooks: Number(row.active_playbooks),
      installedAgents: Number(row.installed_agents),
      queuedRuns: Number(row.queued_runs),
      failedRuns: Number(row.failed_runs),
      agents: agents.rows,
      playbooks: playbooks.rows,
    }
  } catch {
    return empty
  }
}

export async function resetLeadForRebuild(id: string): Promise<void> {
  await pool().query(
    `UPDATE leads SET status='analyzed', github_repo=NULL, cloudflare_url=NULL,
     vercel_url=NULL, outreach_sent=NULL, sms_sent=NULL WHERE id=$1`,
    [id]
  )
}

export async function getLeadById(id: string): Promise<{ status: string; cloudflare_url?: string } | null> {
  const { rows } = await pool().query(
    `SELECT status, cloudflare_url FROM leads WHERE id = $1`,
    [id]
  )
  return rows[0] ?? null
}

// ── Client auth ───────────────────────────────────────────────────────────────

export async function createMagicToken(email: string): Promise<string> {
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  const token = Array.from(arr, b => b.toString(16).padStart(2, "0")).join("")
  await pool().query(
    `INSERT INTO client_tokens (email, token) VALUES ($1, $2)`,
    [email, token]
  )
  return token
}

export async function validateMagicToken(token: string): Promise<string | null> {
  const { rows } = await pool().query(
    `UPDATE client_tokens
     SET used = TRUE
     WHERE token = $1 AND used = FALSE AND expires_at > NOW()
     RETURNING email`,
    [token]
  )
  return rows[0]?.email ?? null
}

export async function getClientLead(email: string): Promise<Lead | null> {
  const { rows } = await pool().query<Lead>(
    `SELECT id, name, niche, city, state, phone, email, website, tier, client_plan,
            status, site_score, cloudflare_url, vercel_url, github_repo,
            rating, review_count, paid, location_group_id, vapi_assistant_id,
            vapi_phone_number, webhook_url, created_at, call_count, last_call_at,
            stripe_customer_id, stripe_subscription_id, subscription_active, subscription_plan
     FROM leads WHERE email = $1 ORDER BY created_at DESC LIMIT 1`,
    [email]
  )
  return rows[0] ?? null
}

// ── Multi-location (Scale) ─────────────────────────────────────────────────────

export async function getLocationGroup(groupId: string): Promise<Lead[]> {
  const { rows } = await pool().query<Lead>(
    `SELECT id, name, niche, city, state, phone, email, website, tier, client_plan,
            status, site_score, cloudflare_url, vercel_url, rating, review_count,
            paid, location_group_id, vapi_phone_number, created_at
     FROM leads WHERE location_group_id = $1 ORDER BY created_at ASC`,
    [groupId]
  )
  return rows
}

export async function getClientLocations(email: string): Promise<Lead[]> {
  // First find the primary lead
  const primary = await getClientLead(email)
  if (!primary) return []
  // If in a group, return all group members; otherwise just the one
  if (primary.location_group_id) {
    return getLocationGroup(primary.location_group_id)
  }
  return [primary]
}

export async function setLocationGroup(leadIds: string[], groupId: string): Promise<void> {
  await pool().query(
    `UPDATE leads SET location_group_id=$1 WHERE id = ANY($2::uuid[])`,
    [groupId, leadIds]
  )
}

export interface CallTrend {
  this_week_calls:    number
  last_week_calls:    number
  this_week_booked:   number
  last_week_booked:   number
  this_week_spam:     number
  booking_rate_pct:   number   // 0–100
}

export async function getClientCallTrend(leadId: string): Promise<CallTrend> {
  try {
    const { rows } = await pool().query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'  AND duration_seconds >= 8) AS this_week_calls,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' AND duration_seconds >= 8) AS last_week_calls,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'  AND transcript ILIKE '%[BOOKING]%') AS this_week_booked,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' AND transcript ILIKE '%[BOOKING]%') AS last_week_booked,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'  AND duration_seconds < 8) AS this_week_spam
       FROM call_logs WHERE lead_id = $1`,
      [leadId]
    )
    const r = rows[0]
    const thisWeek = Number(r?.this_week_calls ?? 0)
    const booked   = Number(r?.this_week_booked ?? 0)
    return {
      this_week_calls:  thisWeek,
      last_week_calls:  Number(r?.last_week_calls ?? 0),
      this_week_booked: booked,
      last_week_booked: Number(r?.last_week_booked ?? 0),
      this_week_spam:   Number(r?.this_week_spam ?? 0),
      booking_rate_pct: thisWeek > 0 ? Math.round((booked / thisWeek) * 100) : 0,
    }
  } catch {
    return { this_week_calls: 0, last_week_calls: 0, this_week_booked: 0, last_week_booked: 0, this_week_spam: 0, booking_rate_pct: 0 }
  }
}

// ── getDb: pool accessor for API routes ───────────────────────────────────────

export async function getDb() {
  return pool()
}

// ── Outreach analytics ──────────────────────────────────────────────────────

export interface OutreachLead {
  id: string
  name: string
  niche: string
  city: string
  state: string
  phone: string | null
  email: string | null
  tier: string | null
  status: string
  outreach_sent: boolean
  outreach_sent_at: string | null
  sms_sent: boolean
  sms_sent_at: string | null
  vercel_url: string | null
  cloudflare_url: string | null
  follow_up_1_sent_at: string | null
  follow_up_2_sent_at: string | null
}

export interface OutreachStats {
  total_sent: number
  sms_count: number
  email_count: number
  tier1_count: number
  tier2_count: number
  by_niche: Array<{ niche: string; count: number }>
  by_day: Array<{ day: string; count: number }>
  follow_up_pending: number
}

export async function getOutreachLeads(): Promise<OutreachLead[]> {
  const { rows } = await pool().query<OutreachLead>(`
    SELECT
      id, name, niche, city, state, phone, email, tier, status,
      outreach_sent, outreach_sent_at,
      sms_sent, sms_sent_at,
      vercel_url, cloudflare_url,
      follow_up_1_sent_at, follow_up_2_sent_at
    FROM leads
    WHERE outreach_sent = true OR sms_sent = true
    ORDER BY outreach_sent_at DESC NULLS LAST
    LIMIT 1000
  `)
  return rows
}

export async function getOutreachStats(): Promise<OutreachStats> {
  const { rows: [r] } = await pool().query(`
    SELECT
      COUNT(*) FILTER (WHERE outreach_sent=true OR sms_sent=true)          AS total_sent,
      COUNT(*) FILTER (WHERE sms_sent=true OR (outreach_sent=true AND email IS NULL)) AS sms_count,
      COUNT(*) FILTER (WHERE outreach_sent=true AND email IS NOT NULL)      AS email_count,
      COUNT(*) FILTER (WHERE tier='tier1')                                  AS tier1_count,
      COUNT(*) FILTER (WHERE tier='tier2')                                  AS tier2_count,
      COUNT(*) FILTER (
        WHERE outreach_sent=true
          AND follow_up_1_sent_at IS NULL
          AND outreach_sent_at < NOW() - INTERVAL '3 days'
      )                                                                      AS follow_up_pending
    FROM leads
    WHERE outreach_sent = true OR sms_sent = true
  `)

  const { rows: byNiche } = await pool().query<{ niche: string; count: number }>(`
    SELECT niche, COUNT(*) AS count
    FROM leads
    WHERE outreach_sent = true OR sms_sent = true
    GROUP BY niche ORDER BY count DESC
  `)

  const { rows: byDay } = await pool().query<{ day: string; count: number }>(`
    SELECT
      TO_CHAR(outreach_sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
      COUNT(*) AS count
    FROM leads
    WHERE outreach_sent = true AND outreach_sent_at IS NOT NULL
    GROUP BY day ORDER BY day DESC
    LIMIT 30
  `)

  return {
    total_sent:       Number(r.total_sent),
    sms_count:        Number(r.sms_count),
    email_count:      Number(r.email_count),
    tier1_count:      Number(r.tier1_count),
    tier2_count:      Number(r.tier2_count),
    follow_up_pending: Number(r.follow_up_pending),
    by_niche:         byNiche.map(n => ({ niche: n.niche, count: Number(n.count) })),
    by_day:           byDay.map(d => ({ day: d.day, count: Number(d.count) })),
  }
}

// ── Lead activity timeline ──────────────────────────────────────────────────

export interface LeadEvent {
  id: string
  event_type: string
  detail: any
  created_at: string
}

export async function getLeadEvents(leadId: string): Promise<LeadEvent[]> {
  const { rows } = await pool().query<LeadEvent>(
    `SELECT id, event_type, detail, created_at FROM lead_events WHERE lead_id=$1 ORDER BY created_at DESC`,
    [leadId]
  )
  return rows
}

export async function logLeadEventByEmail(
  email: string,
  eventType: string,
  detail?: Record<string, unknown>
): Promise<void> {
  const { rows } = await pool().query(`SELECT id FROM leads WHERE email=$1 LIMIT 1`, [email])
  const leadId = rows[0]?.id
  if (!leadId) return
  await pool().query(
    `INSERT INTO lead_events (lead_id, event_type, detail) VALUES ($1, $2, $3)`,
    [leadId, eventType, detail ? JSON.stringify(detail) : null]
  )
}

export async function logLeadEventByPhone(
  phone: string,
  eventType: string,
  detail?: Record<string, unknown>
): Promise<string | null> {
  const normalized = phone.replace(/\D/g, '')
  const { rows } = await pool().query(
    `SELECT id FROM leads WHERE regexp_replace(phone, '\\D', '', 'g') = $1 LIMIT 1`,
    [normalized]
  )
  const leadId = rows[0]?.id
  if (!leadId) return null
  await pool().query(
    `INSERT INTO lead_events (lead_id, event_type, detail) VALUES ($1, $2, $3)`,
    [leadId, eventType, detail ? JSON.stringify(detail) : null]
  )
  return leadId
}

// ── Client call history ───────────────────────────────────────────────────────

export interface CallLog {
  id: string
  caller_number: string | null
  duration_seconds: number
  transcript: string | null
  escalated: boolean
  message_taken: string | null
  created_at: string
  booked: boolean
  is_spam: boolean
}

export interface CallStats {
  total_this_month: number
  booked_this_month: number
  escalated_this_month: number
  spam_this_month: number
  total_all_time: number
}

export async function getClientCallLogs(leadId: string, limit = 15): Promise<CallLog[]> {
  try {
    const { rows } = await pool().query(
      `SELECT id, caller_number, duration_seconds, transcript, escalated, message_taken, created_at,
              (transcript ILIKE '%[BOOKING]%') AS booked,
              (duration_seconds < 8) AS is_spam
       FROM call_logs
       WHERE lead_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [leadId, limit]
    )
    return rows.map(r => ({ ...r, booked: !!r.booked, is_spam: !!r.is_spam }))
  } catch {
    return []
  }
}

export async function getClientCallStats(leadId: string): Promise<CallStats> {
  try {
    const { rows } = await pool().query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()) AND duration_seconds >= 8) AS total_this_month,
         COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()) AND transcript ILIKE '%[BOOKING]%') AS booked_this_month,
         COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()) AND escalated = true) AS escalated_this_month,
         COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()) AND duration_seconds < 8) AS spam_this_month,
         COUNT(*) AS total_all_time
       FROM call_logs WHERE lead_id = $1`,
      [leadId]
    )
    const r = rows[0]
    return {
      total_this_month:     Number(r?.total_this_month ?? 0),
      booked_this_month:    Number(r?.booked_this_month ?? 0),
      escalated_this_month: Number(r?.escalated_this_month ?? 0),
      spam_this_month:      Number(r?.spam_this_month ?? 0),
      total_all_time:       Number(r?.total_all_time ?? 0),
    }
  } catch {
    return { total_this_month: 0, booked_this_month: 0, escalated_this_month: 0, spam_this_month: 0, total_all_time: 0 }
  }
}

// ── GSC traffic snapshots ─────────────────────────────────────────────────────

export interface GscSnapshot {
  id: string
  period_start: string
  period_end: string
  total_clicks: number
  total_impressions: number
  avg_position: number | null
  ctr_pct: number | null
  top_keywords: Array<{ keyword: string; clicks: number; impressions: number }> | null
  created_at: string
}

export async function getClientGscSnapshots(leadId: string, limit = 8): Promise<GscSnapshot[]> {
  try {
    const { rows } = await pool().query(
      `SELECT id, period_start, period_end, total_clicks, total_impressions,
              avg_position, ctr_pct, top_keywords, created_at
       FROM gsc_snapshots WHERE lead_id = $1
       ORDER BY period_start DESC LIMIT $2`,
      [leadId, limit]
    )
    return rows.map(r => ({
      ...r,
      total_clicks:      Number(r.total_clicks),
      total_impressions: Number(r.total_impressions),
      avg_position:      r.avg_position != null ? Number(r.avg_position) : null,
      ctr_pct:           r.ctr_pct != null ? Number(r.ctr_pct) : null,
    }))
  } catch {
    return []
  }
}

// ── Client reviews feed ───────────────────────────────────────────────────────

export interface ClientReview {
  id: string
  review_id: string
  reviewer_name: string | null
  rating: number
  comment: string | null
  our_reply: string | null
  replied_at: string | null
  review_date: string | null
  created_at: string
}

export async function getClientReviews(leadId: string, limit = 10): Promise<ClientReview[]> {
  try {
    const { rows } = await pool().query(
      `SELECT id, review_id, reviewer_name, rating, comment, our_reply, replied_at, review_date, created_at
       FROM client_reviews WHERE lead_id = $1
       ORDER BY COALESCE(review_date, created_at) DESC LIMIT $2`,
      [leadId, limit]
    )
    return rows
  } catch {
    return []
  }
}

// ─── SMS Conversations (Sofia agent) ─────────────────────────────────────────

export interface SmsConversation {
  phone: string
  stage: string
  demo_url: string | null
  offered_price: number | null
  last_message: string | null
  last_reply: string | null
  messages: Array<{ role: 'user' | 'model'; text: string }>
  updated_at: string
  lead_name: string | null
  lead_niche: string | null
  lead_city: string | null
  lead_tier: string | null
  build_status: string | null
  build_demo_url: string | null
}

export async function getSmsConversations(limit = 200): Promise<SmsConversation[]> {
  try {
    const { rows } = await pool().query(`
      SELECT
        c.phone, c.stage, c.demo_url, c.offered_price,
        c.last_message, c.last_reply, c.messages, c.updated_at,
        l.name  AS lead_name,
        l.niche AS lead_niche,
        l.city  AS lead_city,
        l.tier  AS lead_tier,
        b.status   AS build_status,
        b.demo_url AS build_demo_url
      FROM sms_conversations c
      LEFT JOIN LATERAL (
        SELECT name, niche, city, tier FROM leads
        WHERE phone = c.phone ORDER BY updated_at DESC LIMIT 1
      ) l ON true
      LEFT JOIN LATERAL (
        SELECT status, demo_url FROM build_requests
        WHERE phone = c.phone ORDER BY updated_at DESC LIMIT 1
      ) b ON true
      ORDER BY c.updated_at DESC
      LIMIT $1
    `, [limit])
    return rows.map(r => ({
      ...r,
      messages: typeof r.messages === 'string' ? JSON.parse(r.messages) : (r.messages ?? []),
    }))
  } catch {
    return []
  }
}

// ── Reception calls (AI Reception inbound call log + captured prospects) ──────

export interface ReceptionCallRow {
  id: string
  reception_config_id: string | null
  created_at: string
  caller_number: string | null
  duration_seconds: number | null
  escalated: boolean
  escalation_reason: string | null
  message_taken: string | null
  transcript: string | null
  lead_id: string | null
  lead_name: string | null
  lead_email: string | null
  lead_niche: string | null
  lead_status: string | null
}

// Anchored on call_logs (LEFT JOIN leads), not leads — insertCallLog() runs on
// every call unconditionally, but upsertReceptionLead() only fires when the
// caller gave enough info for the AI's take_message tool to succeed. A
// leads-anchored query would silently drop every call that didn't produce one.
export async function getReceptionCallLogs(configId?: string): Promise<ReceptionCallRow[]> {
  try {
    const { rows } = await pool().query<ReceptionCallRow>(`
      SELECT cl.id, cl.reception_config_id, cl.created_at, cl.caller_number,
             cl.duration_seconds, cl.escalated, cl.escalation_reason,
             cl.message_taken, cl.transcript,
             l.id AS lead_id, l.name AS lead_name, l.email AS lead_email,
             l.niche AS lead_niche, l.status AS lead_status
      FROM call_logs cl
      LEFT JOIN leads l ON l.id = cl.lead_id
      WHERE ($1::uuid IS NULL OR cl.reception_config_id = $1)
      ORDER BY cl.created_at DESC
      LIMIT 1000
    `, [configId ?? null])
    return rows
  } catch {
    return []
  }
}

export interface ReceptionConfigOption {
  id: string
  business_name: string
  website_url: string
}

export async function getReceptionConfigOptions(): Promise<ReceptionConfigOption[]> {
  try {
    const { rows } = await pool().query<ReceptionConfigOption>(
      `SELECT id, business_name, website_url FROM reception_configs ORDER BY created_at DESC`
    )
    return rows
  } catch {
    return []
  }
}
