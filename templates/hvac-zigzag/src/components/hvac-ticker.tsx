"use client"

import type { SiteConfig } from "@core/web/types"

interface Props { config: SiteConfig }

// Every item here must be derived from real config data — this file used to
// ship with entirely hardcoded, fabricated marketing claims ("Average
// Response: 45 Min", "312 Google Reviews", "NATE Certified Technicians",
// "EMERGENCY DISPATCH ACTIVE") baked into every hvac-zigzag build regardless
// of the actual business, with no pipeline step ever replacing them unless
// someone manually edited this file per client. Zero-fabrication rule — see
// CLAUDE.md's redesign skill notes.
function buildTickerItems(config: SiteConfig): Array<{ label: string; accent?: boolean }> {
  const { business, trustBadges } = config
  const items: Array<{ label: string; accent?: boolean }> = []

  if (business.license) items.push({ label: `License #${business.license}`, accent: true })
  if (business.google_rating && business.review_count) {
    items.push({ label: `${business.google_rating}★ Google Rating — ${business.review_count} Reviews` })
  }
  for (const badge of trustBadges ?? []) {
    // Skip badges that just restate the license/rating already shown above
    if (badge.includes(business.license ?? '\0') || badge.includes(business.google_rating ?? '\0')) continue
    items.push({ label: badge })
  }
  if (business.serviceAreas?.length) {
    items.push({ label: `Serving ${business.serviceAreas.slice(0, 2).join(" & ")}` })
  }

  return items
}

function TickerItem({ label, accent }: { label: string; accent?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-5 shrink-0 px-2"
      style={{ fontFamily: "var(--font-display)", fontWeight: 600, letterSpacing: "0.1em" }}
    >
      <span
        className="text-xs uppercase"
        style={{ color: accent ? "#4F46E5" : "rgba(11,14,26,0.55)" }}
      >
        {label}
      </span>
      <span
        className="w-1 h-1 rounded-full shrink-0"
        style={{ background: accent ? "#4F46E5" : "rgba(11,14,26,0.2)" }}
      />
    </span>
  )
}

export default function HvacTicker({ config }: Props) {
  const items = buildTickerItems(config)
  if (!items.length) return null
  const repeated = [...items, ...items] // double for seamless loop

  return (
    <div
      className="relative overflow-hidden py-3"
      style={{
        background: "linear-gradient(90deg, #F1F2F8 0%, #FFFFFF 50%, #F1F2F8 100%)",
        borderTop:    "1px solid rgba(11,14,26,0.05)",
        borderBottom: "1px solid rgba(11,14,26,0.05)",
      }}
    >
      {/* Left fade mask */}
      <div
        className="absolute left-0 top-0 bottom-0 w-24 z-10 pointer-events-none"
        style={{ background: "linear-gradient(90deg, #F1F2F8, transparent)" }}
      />
      {/* Right fade mask */}
      <div
        className="absolute right-0 top-0 bottom-0 w-24 z-10 pointer-events-none"
        style={{ background: "linear-gradient(-90deg, #F1F2F8, transparent)" }}
      />

      <div className="ticker-track">
        {repeated.map((item, i) => (
          <TickerItem key={i} {...item} />
        ))}
      </div>
    </div>
  )
}
