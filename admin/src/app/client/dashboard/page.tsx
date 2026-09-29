export const runtime = 'edge'
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import {
  getClientLead, getClientLocations,
  getClientCallLogs, getClientCallStats, getClientCallTrend,
  getClientGscSnapshots, getClientReviews,
} from "@/lib/db"
import { verifyClientCookie } from "@/lib/client-session"
import { ClientLogout } from "@/components/client-logout"
import { Globe, Star, CheckCircle, Clock, AlertCircle, ExternalLink, MessageSquare, MapPin, Phone, TrendingUp } from "lucide-react"

export const dynamic = "force-dynamic"

const STATUS_LABEL: Record<string, { label: string; color: string; icon: any }> = {
  deployed:           { label: "Live",          color: "var(--success)", icon: CheckCircle },
  outreach_sent:      { label: "Live",          color: "var(--success)", icon: CheckCircle },
  sms_sent:           { label: "Live",          color: "var(--success)", icon: CheckCircle },
  conversation_active:{ label: "In Progress",   color: "var(--info)",    icon: Clock },
  meeting_scheduled:  { label: "Meeting Set",   color: "var(--accent-light)", icon: Clock },
  payment_link_sent:  { label: "Payment Sent",  color: "var(--warning)", icon: Clock },
  paid:               { label: "Active Client", color: "var(--paid)",    icon: CheckCircle },
  handed_off:         { label: "Active Client", color: "var(--paid)",    icon: CheckCircle },
  built:              { label: "Building",      color: "var(--warning)", icon: Clock },
  analyzed:           { label: "Preparing",     color: "var(--warning)", icon: Clock },
  error:              { label: "Issue Detected",color: "var(--error)",   icon: AlertCircle },
}

const PLAN_LABEL: Record<string, { label: string; color: string }> = {
  launch: { label: "Launch",  color: "#f59e0b" },
  grow:   { label: "Grow",    color: "#6366f1" },
  scale:  { label: "Scale",   color: "#10b981" },
}

export default async function ClientDashboardPage() {
  const store = await cookies()
  const email = await verifyClientCookie(store.get("client_email")?.value)
  if (!email) redirect("/client/login")

  const lead = await getClientLead(email)
  if (!lead) redirect("/client/login?error=not-found")

  // Scale: fetch all locations; others: single lead
  const locations = await getClientLocations(email)
  const isMultiLocation = locations.length > 1

  // Parallel fetch: call logs, GSC traffic, reviews
  const [callLogs, callStats, callTrend, gscSnapshots, reviews] = lead.id
    ? await Promise.all([
        getClientCallLogs(lead.id, 12),
        getClientCallStats(lead.id),
        getClientCallTrend(lead.id),
        getClientGscSnapshots(lead.id, 8),
        getClientReviews(lead.id, 10),
      ])
    : [
        [],
        { total_this_month: 0, booked_this_month: 0, escalated_this_month: 0, spam_this_month: 0, total_all_time: 0 },
        { this_week_calls: 0, last_week_calls: 0, this_week_booked: 0, last_week_booked: 0, this_week_spam: 0, booking_rate_pct: 0 },
        [],
        [],
      ]

  const latestGsc     = gscSnapshots[0] ?? null
  const hasGscData    = gscSnapshots.length > 0
  const hasReviews    = reviews.length > 0

  const hasCallActivity = callStats.total_all_time > 0

  // Estimated ROI per booked call by niche
  const ROI_PER_BOOKING: Record<string, number> = {
    hvac: 350, roofing: 1500, plumbing: 300, remodeling: 600, dentist: 250,
    medspa: 300, 'skin-clinic': 250, 'iv-therapy': 180, cleaning: 150,
    landscaping: 200, 'auto-detailing': 130, 'junk-removal': 200,
    lawfirm: 800, daycare: 100, salon: 80, barbershop: 60,
    restaurant: 60, 'nail-studio': 70, 'luxury-realestate': 5000,
  }
  const avgJobValue = ROI_PER_BOOKING[lead.niche] ?? 200
  const estimatedRoi = callStats.booked_this_month * avgJobValue

  const siteUrl = lead.cloudflare_url ?? lead.vercel_url
  const statusInfo = STATUS_LABEL[lead.status] ?? { label: lead.status, color: "var(--muted)", icon: Clock }
  const StatusIcon = statusInfo.icon
  const planInfo = PLAN_LABEL[lead.client_plan ?? "launch"] ?? PLAN_LABEL.launch

  return (
    <div
      style={{
        minHeight:   "100vh",
        background:  "var(--bg)",
        padding:     "0 0 60px",
      }}
    >
      {/* Header */}
      <header
        style={{
          background:  "var(--surface)",
          borderBottom: "1px solid var(--border)",
          padding:     "14px 32px",
          display:     "flex",
          alignItems:  "center",
          gap:         16,
        }}
      >
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontWeight:    800,
              fontSize:      15,
              letterSpacing: "-0.02em",
              color:         "var(--text)",
            }}
          >
            {lead.name}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 1 }}>
            {lead.city}, {lead.state} · {lead.niche}
          </div>
        </div>
        <ClientLogout />
      </header>

      <div style={{ maxWidth: 820, margin: "0 auto", padding: "32px 24px" }}>

        {/* Site status card */}
        <div
          style={{
            background:   "var(--surface)",
            border:       "1px solid var(--border)",
            borderRadius: 14,
            padding:      "24px 28px",
            marginBottom: 20,
          }}
        >
          <div
            style={{
              display:        "flex",
              alignItems:     "center",
              justifyContent: "space-between",
              marginBottom:   20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <StatusIcon size={18} color={statusInfo.color} />
              <span
                style={{
                  fontSize:   15,
                  fontWeight: 700,
                  color:      statusInfo.color,
                }}
              >
                {statusInfo.label}
              </span>
            </div>
            {siteUrl && (
              <a
                href={siteUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display:      "flex",
                  alignItems:   "center",
                  gap:          6,
                  background:   "var(--accent)",
                  color:        "#fff",
                  padding:      "9px 18px",
                  borderRadius: 8,
                  fontWeight:   700,
                  fontSize:     13,
                  textDecoration: "none",
                }}
              >
                <Globe size={14} />
                View Your Site
                <ExternalLink size={12} />
              </a>
            )}
          </div>

          <div
            style={{
              background:   "var(--surface-2)",
              border:       "1px solid var(--border)",
              borderRadius: 8,
              padding:      "12px 16px",
            }}
          >
            <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Website URL
            </div>
            {siteUrl ? (
              <a
                href={siteUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color:          "var(--accent-light)",
                  fontSize:       13,
                  textDecoration: "none",
                  fontWeight:     500,
                }}
              >
                {siteUrl}
              </a>
            ) : (
              <span style={{ color: "var(--muted)", fontSize: 13 }}>
                Site is being built — check back soon
              </span>
            )}
          </div>
        </div>

        {/* Stats row */}
        <div
          style={{
            display:             "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap:                 16,
            marginBottom:        20,
          }}
        >
          {/* Site score */}
          <div
            style={{
              background:   "var(--surface)",
              border:       "1px solid var(--border)",
              borderRadius: 12,
              padding:      "18px 20px",
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
              Site Performance
            </div>
            {lead.site_score != null ? (
              <>
                <div
                  style={{
                    fontSize:      28,
                    fontWeight:    800,
                    letterSpacing: "-0.04em",
                    color:
                      lead.site_score >= 70
                        ? "var(--success)"
                        : lead.site_score >= 50
                        ? "var(--warning)"
                        : "var(--error)",
                    lineHeight:    1,
                    marginBottom:  8,
                  }}
                >
                  {lead.site_score}
                  <span style={{ fontSize: 14, fontWeight: 500, color: "var(--muted)" }}>/100</span>
                </div>
                <div
                  style={{
                    height:         5,
                    borderRadius:   3,
                    background:     "var(--border-2)",
                    overflow:       "hidden",
                  }}
                >
                  <div
                    style={{
                      height:       "100%",
                      width:        `${lead.site_score}%`,
                      background:
                        lead.site_score >= 70
                          ? "var(--success)"
                          : lead.site_score >= 50
                          ? "var(--warning)"
                          : "var(--error)",
                      borderRadius: 3,
                      transition:   "width 0.4s ease",
                    }}
                  />
                </div>
              </>
            ) : (
              <div style={{ color: "var(--muted)", fontSize: 13 }}>
                Being measured…
              </div>
            )}
          </div>

          {/* Google rating */}
          <div
            style={{
              background:   "var(--surface)",
              border:       "1px solid var(--border)",
              borderRadius: 12,
              padding:      "18px 20px",
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
              Google Reviews
            </div>
            {lead.rating != null ? (
              <>
                <div
                  style={{
                    display:     "flex",
                    alignItems:  "baseline",
                    gap:         6,
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{
                      fontSize:      28,
                      fontWeight:    800,
                      letterSpacing: "-0.04em",
                      color:         "var(--warning)",
                      lineHeight:    1,
                    }}
                  >
                    {lead.rating}
                  </span>
                  <Star size={16} color="var(--warning)" fill="var(--warning)" />
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  {lead.review_count ?? 0} reviews
                </div>
              </>
            ) : (
              <div style={{ color: "var(--muted)", fontSize: 13 }}>No data yet</div>
            )}
          </div>

          {/* Account / plan */}
          <div
            style={{
              background:   "var(--surface)",
              border:       "1px solid var(--border)",
              borderRadius: 12,
              padding:      "18px 20px",
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
              Your Plan
            </div>
            <div
              style={{
                fontSize:      20,
                fontWeight:    800,
                color:         planInfo.color,
                lineHeight:    1,
                marginBottom:  6,
                letterSpacing: "-0.02em",
              }}
            >
              {planInfo.label}
            </div>
            <div style={{ fontSize: 12, color: lead.paid ? "var(--paid)" : "var(--warning)" }}>
              {lead.paid ? "✓ Active" : "Pending payment"}
            </div>
          </div>
        </div>

        {/* AI Reception ROI panel */}
        {hasCallActivity && (
          <div
            style={{
              background:   "linear-gradient(135deg, rgba(99,102,241,0.08) 0%, rgba(16,185,129,0.06) 100%)",
              border:       "1px solid rgba(99,102,241,0.25)",
              borderRadius: 14,
              padding:      "22px 28px",
              marginBottom: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
              <TrendingUp size={16} color="#6366f1" />
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                AI Reception — This Month
              </span>
            </div>
            <div
              style={{
                display:             "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap:                 14,
              }}
            >
              {[
                { label: "Real Calls",    value: callStats.total_this_month,     color: "var(--accent-light)" },
                { label: "Bookings Made", value: callStats.booked_this_month,    color: "#10b981" },
                { label: "Spam Filtered", value: callStats.spam_this_month,      color: "var(--muted)" },
                {
                  label: "Est. Revenue Recovered",
                  value: estimatedRoi > 0 ? `$${estimatedRoi.toLocaleString()}` : "—",
                  color: "#10b981",
                },
              ].map(({ label, value, color }) => (
                <div
                  key={label}
                  style={{
                    background:   "var(--surface)",
                    border:       "1px solid var(--border)",
                    borderRadius: 10,
                    padding:      "14px 16px",
                  }}
                >
                  <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 700, marginBottom: 8 }}>
                    {label}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, color, letterSpacing: "-0.03em", lineHeight: 1 }}>
                    {value}
                  </div>
                </div>
              ))}
            </div>
            {estimatedRoi > 0 && (
              <div style={{ marginTop: 12, fontSize: 12, color: "rgba(16,185,129,0.8)" }}>
                ✓ Based on {callStats.booked_this_month} booking{callStats.booked_this_month !== 1 ? "s" : ""} × ${avgJobValue} avg job value for {lead.niche}
              </div>
            )}
          </div>
        )}

        {/* Call history */}
        {callLogs.length > 0 && (
          <div
            style={{
              background:   "var(--surface)",
              border:       "1px solid var(--border)",
              borderRadius: 14,
              padding:      "22px 28px",
              marginBottom: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <Phone size={16} color="var(--accent-light)" />
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                Recent Calls
              </span>
              <span
                style={{
                  fontSize:     11,
                  fontWeight:   600,
                  color:        "var(--muted)",
                  background:   "var(--surface-2)",
                  border:       "1px solid var(--border)",
                  borderRadius: 20,
                  padding:      "2px 8px",
                }}
              >
                {callStats.total_all_time} total
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {callLogs.map((call) => {
                const mins = Math.floor(call.duration_seconds / 60)
                const secs = call.duration_seconds % 60
                const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
                const callDate = new Date(call.created_at)
                const dateStr = callDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })
                const timeStr = callDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
                const callerDisplay = call.caller_number
                  ? call.caller_number.replace(/(\+1)?(\d{3})(\d{3})(\d{4})/, "($2) $3-$4")
                  : "Unknown"
                // Snippet from transcript — first meaningful line after [AI]
                const snippet = call.transcript
                  ? call.transcript.replace(/\[BOOKING\]/g, "").split("\n").find(l => l.trim() && l.length > 20)?.slice(0, 80) + "…"
                  : null

                return (
                  <div
                    key={call.id}
                    style={{
                      background:     "var(--surface-2)",
                      border:         "1px solid var(--border)",
                      borderRadius:   10,
                      padding:        "12px 16px",
                      display:        "flex",
                      alignItems:     "flex-start",
                      gap:            12,
                    }}
                  >
                    {/* Badge */}
                    <div
                      style={{
                        width:        32,
                        height:       32,
                        borderRadius: "50%",
                        background:   call.booked
                          ? "rgba(16,185,129,0.12)"
                          : call.escalated
                          ? "rgba(245,158,11,0.12)"
                          : call.is_spam
                          ? "rgba(100,116,139,0.1)"
                          : "rgba(99,102,241,0.08)",
                        display:      "flex",
                        alignItems:   "center",
                        justifyContent: "center",
                        flexShrink:   0,
                        fontSize:     14,
                      }}
                    >
                      {call.booked ? "✅" : call.escalated ? "⚡" : call.is_spam ? "🚫" : "📞"}
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                          {callerDisplay}
                        </span>
                        {call.booked && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: "#10b981", background: "rgba(16,185,129,0.1)", borderRadius: 4, padding: "2px 6px" }}>
                            BOOKED
                          </span>
                        )}
                        {call.escalated && !call.booked && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: "#f59e0b", background: "rgba(245,158,11,0.1)", borderRadius: 4, padding: "2px 6px" }}>
                            ESCALATED
                          </span>
                        )}
                      </div>
                      {snippet && (
                        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {snippet}
                        </div>
                      )}
                      {call.message_taken && (
                        <div style={{ fontSize: 12, color: "var(--accent-light)", marginBottom: 3 }}>
                          📝 {call.message_taken}
                        </div>
                      )}
                    </div>

                    <div style={{ flexShrink: 0, textAlign: "right" }}>
                      <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600 }}>{dateStr}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>{timeStr}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{duration}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Analytics — weekly call trend (shown when there's any call history) */}
        {hasCallActivity && (
          <div
            style={{
              background:   "var(--surface)",
              border:       "1px solid var(--border)",
              borderRadius: 14,
              padding:      "22px 28px",
              marginBottom: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <TrendingUp size={16} color="var(--accent-light)" />
                <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>Analytics</span>
              </div>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>This week vs last week</span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Real calls trend */}
              <TrendRow
                label="Real Calls"
                thisWeek={callTrend.this_week_calls}
                lastWeek={callTrend.last_week_calls}
                color="#6366f1"
              />
              {/* Bookings trend */}
              <TrendRow
                label="Bookings"
                thisWeek={callTrend.this_week_booked}
                lastWeek={callTrend.last_week_booked}
                color="#10b981"
              />
              {/* Spam blocked */}
              <TrendRow
                label="Spam Blocked"
                thisWeek={callTrend.this_week_spam}
                lastWeek={0}
                color="#64748b"
                noCompare
              />
              {/* Booking rate */}
              <div
                style={{
                  background:   "var(--surface-2)",
                  border:       "1px solid var(--border)",
                  borderRadius: 10,
                  padding:      "12px 16px",
                  display:      "flex",
                  alignItems:   "center",
                  justifyContent: "space-between",
                }}
              >
                <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>Booking Rate (this week)</span>
                <span
                  style={{
                    fontSize:   18,
                    fontWeight: 800,
                    color:      callTrend.booking_rate_pct >= 30 ? "#10b981" : callTrend.booking_rate_pct >= 10 ? "#f59e0b" : "var(--muted)",
                    letterSpacing: "-0.02em",
                  }}
                >
                  {callTrend.booking_rate_pct}%
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Multi-location panel (Scale only) */}
        {isMultiLocation && (
          <div
            style={{
              background:   "var(--surface)",
              border:       "1px solid var(--border)",
              borderRadius: 14,
              padding:      "24px 28px",
              marginBottom: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <MapPin size={16} color="var(--accent-light)" />
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                All Locations ({locations.length})
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {locations.map((loc) => {
                const locStatus = STATUS_LABEL[loc.status] ?? { label: loc.status, color: "var(--muted)", icon: Clock }
                const LocIcon = locStatus.icon
                const locUrl = loc.cloudflare_url ?? loc.vercel_url
                return (
                  <div
                    key={loc.id}
                    style={{
                      background:   "var(--surface-2)",
                      border:       "1px solid var(--border)",
                      borderRadius: 10,
                      padding:      "14px 18px",
                      display:      "flex",
                      alignItems:   "center",
                      justifyContent: "space-between",
                      gap:          12,
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{loc.name}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                        {loc.city}, {loc.state}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <LocIcon size={13} color={locStatus.color} />
                        <span style={{ fontSize: 12, color: locStatus.color, fontWeight: 600 }}>{locStatus.label}</span>
                      </div>
                      {locUrl && (
                        <a
                          href={locUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            display: "flex", alignItems: "center", gap: 4,
                            color: "var(--accent-light)", fontSize: 12,
                            textDecoration: "none", fontWeight: 600,
                          }}
                        >
                          <Globe size={12} />
                          View
                        </a>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Vapi voice reception info (Scale only) */}
        {lead.vapi_phone_number && (
          <div
            style={{
              background:   "rgba(16,185,129,0.06)",
              border:       "1px solid rgba(16,185,129,0.2)",
              borderRadius: 14,
              padding:      "20px 24px",
              marginBottom: 20,
              display:      "flex",
              alignItems:   "center",
              gap:          14,
            }}
          >
            <div style={{ fontSize: 24 }}>📞</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#10b981", marginBottom: 2 }}>
                AI Voice Reception Active
              </div>
              <div style={{ fontSize: 13, color: "var(--muted)" }}>
                Dedicated number: <strong style={{ color: "var(--text)" }}>{lead.vapi_phone_number}</strong>
                {" · "}Calls answered 24/7 by AI
              </div>
            </div>
          </div>
        )}

        {/* GSC Traffic section */}
        {hasGscData && latestGsc && (
          <div
            style={{
              background:   "var(--surface)",
              border:       "1px solid var(--border)",
              borderRadius: 14,
              padding:      "22px 28px",
              marginBottom: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Globe size={16} color="var(--accent-light)" />
                <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>Google Search Traffic</span>
              </div>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>28-day period</span>
            </div>

            {/* Latest snapshot stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 18 }}>
              {[
                { label: "Clicks",      value: latestGsc.total_clicks.toLocaleString(),      color: "#10b981" },
                { label: "Impressions", value: latestGsc.total_impressions.toLocaleString(), color: "#6366f1" },
                { label: "CTR",         value: latestGsc.ctr_pct != null ? `${latestGsc.ctr_pct}%` : "—", color: "#8b5cf6" },
                { label: "Avg Position",value: latestGsc.avg_position != null ? `#${latestGsc.avg_position}` : "—", color: "#f59e0b" },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 700, marginBottom: 6 }}>{label}</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color, letterSpacing: "-0.03em", lineHeight: 1 }}>{value}</div>
                </div>
              ))}
            </div>

            {/* Weekly clicks trend bars */}
            {gscSnapshots.length > 1 && (
              <div>
                <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Click Trend</div>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 48 }}>
                  {[...gscSnapshots].reverse().map((snap, i) => {
                    const maxClicks = Math.max(...gscSnapshots.map(s => s.total_clicks), 1)
                    const h = Math.max(4, Math.round((snap.total_clicks / maxClicks) * 48))
                    const isLatest = i === gscSnapshots.length - 1
                    return (
                      <div key={snap.id} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 3 }}>
                        <div
                          style={{
                            width: "100%", height: h,
                            background: isLatest ? "#10b981" : "rgba(16,185,129,0.25)",
                            borderRadius: 3,
                            transition: "height 0.3s ease",
                          }}
                        />
                        <div style={{ fontSize: 9, color: "var(--muted)", whiteSpace: "nowrap" }}>
                          {new Date(snap.period_start).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Top keywords */}
            {latestGsc.top_keywords && latestGsc.top_keywords.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Top Keywords</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {latestGsc.top_keywords.slice(0, 5).map((kw, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", background: "var(--surface-2)", borderRadius: 6, border: "1px solid var(--border)" }}>
                      <span style={{ fontSize: 12, color: "var(--text)", fontWeight: 500 }}>{kw.keyword}</span>
                      <span style={{ fontSize: 12, color: "#10b981", fontWeight: 700 }}>{kw.clicks} clicks</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Google Reviews feed */}
        {hasReviews && (
          <div
            style={{
              background:   "var(--surface)",
              border:       "1px solid var(--border)",
              borderRadius: 14,
              padding:      "22px 28px",
              marginBottom: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <Star size={16} color="var(--warning)" fill="var(--warning)" />
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>Google Reviews</span>
              <span style={{ fontSize: 11, color: "var(--muted)", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 20, padding: "2px 8px" }}>
                {reviews.length} recent
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {reviews.map((review) => {
                const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating)
                const dateStr = review.review_date
                  ? new Date(review.review_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                  : null
                return (
                  <div
                    key={review.id}
                    style={{
                      background:   "var(--surface-2)",
                      border:       "1px solid var(--border)",
                      borderRadius: 10,
                      padding:      "14px 16px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                          {review.reviewer_name ?? "Anonymous"}
                        </span>
                        <span style={{ fontSize: 13, color: "var(--warning)", letterSpacing: 1 }}>{stars}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {review.our_reply && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: "#10b981", background: "rgba(16,185,129,0.1)", borderRadius: 4, padding: "2px 6px" }}>
                            REPLIED
                          </span>
                        )}
                        {dateStr && <span style={{ fontSize: 11, color: "var(--muted)" }}>{dateStr}</span>}
                      </div>
                    </div>
                    {review.comment && (
                      <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
                        {review.comment.length > 180 ? review.comment.slice(0, 180) + "…" : review.comment}
                      </p>
                    )}
                    {review.our_reply && (
                      <div style={{ borderLeft: "2px solid rgba(99,102,241,0.4)", paddingLeft: 10, marginTop: 6 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--accent-light)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                          Your AI Reply
                        </div>
                        <p style={{ margin: 0, fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
                          {review.our_reply.length > 160 ? review.our_reply.slice(0, 160) + "…" : review.our_reply}
                        </p>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Billing self-serve */}
        <BillingCard
          hasStripe={!!lead.stripe_customer_id}
          subscriptionActive={lead.subscription_active ?? false}
          subscriptionPlan={lead.subscription_plan ?? lead.client_plan ?? "launch"}
          paid={lead.paid ?? false}
        />

        {/* Change request */}
        <ChangeRequestForm leadId={lead.id} email={email} />
      </div>
    </div>
  )
}

function ChangeRequestForm({ leadId, email }: { leadId: string; email: string }) {
  return (
    <div
      style={{
        background:   "var(--surface)",
        border:       "1px solid var(--border)",
        borderRadius: 14,
        padding:      "24px 28px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <MessageSquare size={16} color="var(--accent-light)" />
        <span
          style={{
            fontSize:   14,
            fontWeight: 700,
            color:      "var(--text)",
          }}
        >
          Request a Change
        </span>
      </div>
      <ChangeRequestFormClient leadId={leadId} email={email} />
    </div>
  )
}

// Inline client component for the form
import { ChangeRequestFormClient } from "@/components/change-request-form"

// ── Billing card (client component — needs onClick for portal redirect) ────────
import { BillingCard } from "@/components/billing-card"

function TrendRow({
  label,
  thisWeek,
  lastWeek,
  color,
  noCompare = false,
}: {
  label: string
  thisWeek: number
  lastWeek: number
  color: string
  noCompare?: boolean
}) {
  const max   = Math.max(thisWeek, lastWeek, 1)
  const delta = thisWeek - lastWeek
  const pct   = thisWeek > 0 ? Math.round((thisWeek / max) * 100) : 0
  const lastPct = lastWeek > 0 ? Math.round((lastWeek / max) * 100) : 0

  return (
    <div
      style={{
        background:   "var(--surface-2)",
        border:       "1px solid var(--border)",
        borderRadius: 10,
        padding:      "12px 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {!noCompare && lastWeek > 0 && (
            <span style={{ fontSize: 11, color: "var(--muted)" }}>
              last week: {lastWeek}
            </span>
          )}
          <span style={{ fontSize: 15, fontWeight: 800, color, letterSpacing: "-0.02em" }}>
            {thisWeek}
          </span>
          {!noCompare && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: delta > 0 ? "#10b981" : delta < 0 ? "#ef4444" : "var(--muted)",
              }}
            >
              {delta > 0 ? `↑${delta}` : delta < 0 ? `↓${Math.abs(delta)}` : "—"}
            </span>
          )}
        </div>
      </div>
      {/* This week bar */}
      <div style={{ height: 4, borderRadius: 2, background: "var(--border-2)", overflow: "hidden", marginBottom: noCompare ? 0 : 4 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 2, transition: "width 0.4s ease" }} />
      </div>
      {/* Last week bar (ghost) */}
      {!noCompare && (
        <div style={{ height: 3, borderRadius: 2, background: "var(--border-2)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${lastPct}%`, background: `${color}40`, borderRadius: 2 }} />
        </div>
      )}
    </div>
  )
}
