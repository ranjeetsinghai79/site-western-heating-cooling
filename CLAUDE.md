# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## AUTO-INVOKE RULE (read first, every session)

**If the task involves ANY of the following — invoke `/cinematic-build` skill BEFORE doing anything else:**
- Building or editing any file under `templates/*/`
- Creating or modifying any React component, section, or hook
- Any animation work (GSAP, Lenis, ScrollTrigger, loading screen, cursor)
- Any design decision (colors, layout, typography, spacing)
- Any new niche template or config.ts generation
- Running `npm run dev:<niche>` to test

This skill loads the full $25k quality stack context automatically. Do not skip it.

## External Design Resources (react-bits, lenis, GSAP, Vanta, Seesaw — scraped 2026-07-19)

Read `design-resources/REFERENCE.md` before pulling in any new animated component, background effect, cursor, or gallery pattern. Distills: react-bits' ~100-component catalog (Backgrounds/TextAnimations/Components/Animations, `ts-tailwind` variant matches our stack), Lenis upgrade options (`lenis/react`, `lenis/snap`), GSAP's full free plugin surface (Flip, Draggable, MotionPath — all unlocked, no Club GSAP anymore), why Vanta is skipped (Three.js version conflict — use react-bits' `ogl` Backgrounds instead), and Seesaw as an inspiration-only gallery. Full react-bits + lenis repo clones live in `design-resources/` (gitignored, re-clone command in the doc) — copy-paste components from there, don't `npm install` them as a package.

## Scroll-Sequence Hero (frame-by-frame scrub — verified 2026-07-17)

Working demo: `templates/medspa/src/components/scroll-sequence-hero.tsx` + route `/scroll-demo` (`npm run dev:medspa` → localhost:3102/scroll-demo/). Canvas frame-sequence scrub per cinematic-build skill pattern: 143 JPG frames in `templates/medspa/public/frames/` (Pexels video #9335760 → `ffmpeg -vf "fps=7,scale=1280:-2" -q:v 4`, 6.9MB total), GSAP ScrollTrigger pin 250% + scrub 0.5, prefers-reduced-motion guard, preload counter.
- Stock media keys ALL present in `pipeline/.env`: `PEXELS_API_KEY` (images+videos, 200 req/hr), `PIXABAY_API_KEY`, `UNSPLASH_ACCESS_KEY` (images only).
- Frame recipe: ~7fps, 1280w, q:v 4 → ~50KB/frame; keep total ≤10MB per hero.
- 21st.dev MCP: TWO servers installed at user scope 2026-07-17 — `magic` (stdio, `npx @21st-dev/magic`) + `21st` (HTTP, `https://21st.dev/api/mcp`, x-api-key header, key from `admin/.env.local` 21STDEV_API_KEY). Both `✓ Connected`. HTTP server is richer: `search` (free), `get_component` (2/day free tier), `generate` (21st AI). Can also be driven session-independent via raw curl JSON-RPC POST to the HTTP endpoint.
- 21st components USED on scroll-demo page (retrieved via MCP, adapted to house rules — framer-motion→GSAP, shadcn deps stripped, CSS vars): `magic-treatment-menu.tsx` (from 21st #18963 pricing) + `magic-testimonials.tsx` (from 21st #7267 testimonials grid).

## Fable Brain — Reasoning Standards

Standing orders for rigorous judgment on every task. Read [`fable-brain.md`](./fable-brain.md) — it is the execution protocol for intent-reading, verification, self-attack, and fake-competence detection. Run the **Final Gate** checklist before any non-trivial output.

## What This Is

**MedSpaOS** — AI revenue operating system for independent med spas.
Pivot: This repo was previously a generic multi-niche website pipeline (WebCrew). It is now focused exclusively on med spas, skin clinics, and IV therapy clinics.

Core positioning: "We don't sell med spas more leads. We turn the leads and patients they already have into booked, completed, repeat revenue."

Three systems:

1. **Pipeline** — medspa-focused outreach engine (MEDSPAS + USA_SkinClinics + USA_IVTherapy tabs):
   - **Tier 1 (no website)** → MedSpaOS pitch email + SMS: "missed calls, no-shows, and consults that didn't book are costing you revenue"
   - **Tier 2 (has website)** → revenue recovery audit email + SMS: "what's your no-show rate right now?"
   Fully automated, zero human steps per lead. Default niche: `medspa`.
2. **Templates** — medspa template is primary. See `templates/medspa/` (TreatmentMenuSection built). Skin-clinic and iv-therapy also relevant for aesthetic vertical.
3. **AI Reception** — Gemini Live (native audio) + Twilio Media Streams. Answers inbound calls for deployed clients. Server: `pipeline/src/reception/` — deployed to GCP Cloud Run (`webcrew-501006`, `us-central1`). Live URL: `https://ai-reception-459352382653.us-central1.run.app` (verified 2026-07-20 via `gcloud run services list`)

## Monorepo Workspaces

```
packages/core        → @core/web — shared component library (sections, hooks, types, effects)
templates/*          → 12 niche Next.js sites — import from @core/web
pipeline/            → AI pipeline (Node/TypeScript, tsx runtime)
admin/               → internal dashboard — Neon DB stats, leads, funnel (Next.js, port 3010)
api/                 → Cloudflare Worker — contact form handler, SMS/email, Sheets write
my-website/          → WebsiteDeveloper marketing landing page (port 3001)
webcrew/             → Webcrew marketing site (port 3002)
```

## Commands

```bash
# Pipeline (run from monorepo root)
npm run pipeline:dry          # dry-run (no GitHub/Cloudflare/email)
npm run pipeline              # live run
npm run pipeline:auto         # auto-run loop (pipeline/src/auto-run.ts)
npm run retention --workspace=pipeline  # run GBP + reviews + analytics agents

# Scraping (run from pipeline/ or via workspace)
cd pipeline && npm run scrape                          # scrape Google Maps (env-driven niche/city)
cd pipeline && npm run scrape:daily                    # daily scrape script (writes to DB — not the sheet pipeline)
cd pipeline && npm run outreach                        # send outreach (email + SMS)
cd pipeline && npm run outreach:dry                    # dry-run outreach (SMS_DRY_RUN=true)
cd pipeline && npm run outreach:t1                     # tier-1 only
cd pipeline && npm run repair                          # fix stuck/errored leads
cd pipeline && npm run api:deploy                      # deploy api/ Cloudflare Worker

# ─── Sheet scraping — 15 tabs, APPEND ONLY ───────────────────────────────────
# All 15 tabs use scrape-universal.ts. Never clears existing rows.
# Header: 22 columns (A–V)
#   A  Date Added       B  Business Name     C  Niche / Category  D  City
#   E  State / Country  F  Timezone          G  Phone             H  Email
#   I  Has Website      J  Website URL       K  Address           L  Rating
#   M  Reviews          N  GBP Claimed       O  Open Now          P  Price Level
#   Q  Tier             R  Maps URL
#   S  Business Email   T  Owner Email       U  Phone Type        V  Can SMS
#
# S/T populated by extractEmailsFromWebsite() — fetches site + /contact + /about pages
# U/V populated by lookupPhoneType() (libphonenumber-js/max, offline, free)
#   Phone Type values: mobile | landline | voip | toll-free | unknown
#   Can SMS: YES (mobile/voip/unknown) | NO (landline/toll-free)
#   US numbers always "unknown" due to number portability — SMS attempted anyway
#   outreach.ts + sms-agent.ts skip SMS when can_sms === false
#
# Spreadsheet: https://docs.google.com/spreadsheets/d/1wwZX7eriuA0i37t6_VOetkmHcS7YKiHXI2DYj7gfa9A
#
# ── LEAD STATE (2026-07-10) ──────────────────────────────────────────────────
# Sheet: 80,745 rows across 22 tabs
# DB (scraped_places): 134,148 unique (place_id, tab) pairs — dedup source of truth
#   Sheet vs DB gap fixed: backfill-db-from-sheet.ts synced 63,550 missing records (2026-07-10)
#   No duplicates possible — DB is authoritative for dedup, not sheet
#
# Per-tab counts (sheet rows / DB tracked):
#   Local SMBs    : 20,275 / 35,168  MEDSPAS       : 13,840 / 23,744
#   USA_Restaurants: 11,429 / 19,740  USA_DentalOffices: 10,734 / 18,137
#   USA_BarberShops:  4,099 /  6,271  USA_Salons    :  3,852 /  6,190
#   USA_SkinClinics:  3,180 /  6,134  USA_NailStudios:  2,176 /  3,895
#   INDIA_DentalOffices: 1,882 / 2,034  USA_IVTherapy:   827 / 1,800+
#
# Remaining scraping capacity (~141k more unique leads in current city lists):
#   MEDSPAS        : 687 active combos × ~60 = ~41k leads left
#   USA_DentalOffices: 343 active       × ~60 = ~21k leads left
#   USA_Restaurants: 298 active         × ~60 = ~18k leads left
#   USA_NailStudios: 203 active (0% done) × 60 = ~12k leads left (fresh!)
#   USA_SkinClinics: 161 active         × ~60 = ~10k leads left
#   Others (Salons, BarberShops, SMBs, IVTherapy, LawFirms, India): ~39k
#
# ── LEAD TARGETS (400k total) ────────────────────────────────────────────────
# MEDSPAS          : cap ~102k → currently 13,840 → need +86k
# USA_Restaurants  : cap ~102k → currently 11,429 → need +89k
# USA_Financial    : cap ~102k → currently  1,635 → need +98k
# Local SMBs       : cap ~142k → currently 20,275 → need +80k
# TOTAL TARGET: 400k | Current: 80,745 | Gap: 319,255
# ETA (Mac only, $0): ~25 days at 13k/day via scrape-fast.sh
#
# ── GCP CLOUD SCHEDULER STATUS (2026-07-10) ──────────────────────────────────
# STATUS: ALL 22 PAUSED (since 2026-07-03)
# ROOT CAUSE: Email enrichment caused 3h+ timeouts (1h limit × 2 retries)
# FIX NEEDED: Add SKIP_EMAIL_ENRICHMENT=true + set max-retries=0 to all jobs
#             Then resume all paused schedulers
# COST: GCP Cloud Run at hourly frequency = ~$90/mo — NOT free
#       DECISION: Use Mac-only scraping ($0) instead of GCP
#
# ── MAC-LOCAL SCRAPING ($0, primary strategy) ────────────────────────────────
# launchd job: runs scrape-fast.sh 1000 daily at 2am
# Plist: ~/Library/LaunchAgents/com.webcrew.scrape-fast.plist (WRITTEN, NOT YET LOADED)
# To activate (run once — macOS Sonoma/Ventura use bootstrap, NOT load):
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.webcrew.scrape-fast.plist
# To check: launchctl list | grep webcrew
# To disable: launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.webcrew.scrape-fast.plist
# NOTE: launchctl load fails with I/O error on Sonoma — always use bootstrap/bootout
# Log: pipeline/scrape-fast-launchd.log
#
# scrape-fast.sh yields ~13k/day:
# S-tier (2000/tab): MEDSPAS, SkinClinics, IVTherapy   → 6k/day
# A-tier (1000/tab): Salons, BarberShops, NailStudios, LocalSMBs → 4k/day
# B-tier (1000/tab): Dental, Restaurants, Financial     → 3k/day
# Scraping cost: $0 (Google Maps Playwright, no API cost)
# IMPORTANT: SKIP_EMAIL_ENRICHMENT is already set in scrape-fast.sh (no timeout risk)
#
# ── DEDUP GUARANTEE ──────────────────────────────────────────────────────────
# place_id tracked in scraped_places per (place_id, tab) — ON CONFLICT DO NOTHING
# exhausted combos tracked in scraped_combos — won't re-visit dry city+niche
# backfill-db-from-sheet.ts run 2026-07-10: sheet→DB synced, 134k total protected
# Run again to re-sync after any manual sheet edits:
#   cd pipeline && node --env-file=.env --import=tsx/esm src/scripts/backfill-db-from-sheet.ts
#   (or: set -a && source <(grep -v '^#' .env | grep -v '^$' | sed 's/^/export /') && set +a && npx tsx src/scripts/backfill-db-from-sheet.ts)
#
# NICHE SLUGS (maps-scraper.ts NICHE_QUERY):
#   MEDSPAS     : medspa-usa, botox-clinic, aesthetic-clinic, cosmetic-dermatology, laser-clinic
#   Financial   : financial-advisor, insurance-agent, life-insurance, tax-advisor, mortgage-broker
#   Restaurants : restaurant, italian-restaurant, mexican-restaurant, asian-restaurant, bbq-steakhouse
#   Local SMBs  : hvac, roofing, plumbing, cleaning, landscaping, auto-detailing, remodeling
#
# Manual runs:
cd pipeline && SHEET_TAB="Local SMBs" npx tsx src/scripts/scrape-universal.ts
cd pipeline && SHEET_TAB="MEDSPAS" npx tsx src/scripts/scrape-universal.ts
cd pipeline && SHEET_TAB="USA_DentalOffices" npx tsx src/scripts/scrape-universal.ts
cd pipeline && SHEET_TAB="USA_LawFirms" npx tsx src/scripts/scrape-universal.ts
cd pipeline && SHEET_TAB="USA_SkinClinics" npx tsx src/scripts/scrape-universal.ts
cd pipeline && SHEET_TAB="USA_IVTherapy" npx tsx src/scripts/scrape-universal.ts
cd pipeline && SHEET_TAB="USA_NailStudios" npx tsx src/scripts/scrape-universal.ts
# (SHEET_TAB = any of the 15 tab names above)
cd pipeline && SCRAPE_TARGET=500 SHEET_TAB="MEDSPAS" npx tsx src/scripts/scrape-universal.ts  # bulk run

# Sheet management
cd pipeline && node --env-file=.env --import=tsx/esm src/scripts/sync-status-tab.ts   # LIVE sync: rebuilds Status tab dashboard from DB+sheet (run any time)
cd pipeline && npx tsx src/scripts/init-all-headers.ts          # write 22-col header to all tabs (safe, skips if already correct)
cd pipeline && SHEET_TAB="MEDSPAS" ENRICH_LIMIT=500 npx tsx src/scripts/enrich-existing-rows.ts   # backfill email+phone cols for existing rows
cd pipeline && ENRICH_CONCUR=10 ENRICH_LIMIT=99999 npx tsx src/scripts/enrich-existing-rows.ts   # backfill all tabs
cd pipeline && npx tsx src/scripts/redistribute-leads.ts        # re-route Local SMBs rows to correct niche tabs (safe to re-run)
cd pipeline && npx tsx src/scripts/list-tabs.ts                 # list all tabs in spreadsheet
cd pipeline && npx tsx src/scripts/format-sheet.ts             # format "Local SMBs" tab
cd pipeline && npx tsx src/scripts/rebuild-sheet.ts --confirm   # DESTRUCTIVE: rebuild Local SMBs from DB (requires --confirm)

# Individual template dev servers
npm run dev:hvac
npm run dev:roofing
npm run dev:dentist
# ... dev:<niche> for any of the 25 niches

# Other apps
npm run dev:admin             # admin dashboard → http://localhost:3010
npm run dev:landing           # my-website → http://localhost:3001
npm run dev:webcrew           # webcrew → http://localhost:3002

# Ad winners research ($0, Playwright vs Meta Ad Library — proven-winner filter)
# Filter: started ≥MIN_DAYS ago AND still active = market-validated ad
cd pipeline && npx tsx src/scripts/ad-winners.ts "med spa botox"        # → ad-research/<slug>-<date>.md + creative brief
cd pipeline && MIN_DAYS=90 MAX_ADS=50 npx tsx src/scripts/ad-winners.ts "hvac repair"
cd pipeline && HEADLESS=false npx tsx src/scripts/ad-winners.ts "..."   # watch browser

# RE walkthrough video (realestate upsell — listing photos → cinematic tour)
# Room type inferred from filename (01-exterior.jpg, kitchen.png...); Kling ~$0.098/room + ffmpeg stitch
cd pipeline && DRY_RUN=true npx tsx src/scripts/walkthrough.ts ./photos "142-maple-ave"  # plan + cost estimate
cd pipeline && npx tsx src/scripts/walkthrough.ts ./photos "142-maple-ave"               # live → listing-walkthroughs/<slug>/final/walkthrough-16x9.mp4

# Cost tracking
npm run costs                 # last 30 days spend by service
npm run costs:total           # all-time totals
cd pipeline && npx tsx src/scripts/costs.ts --days 7  # last 7 days

# Demo site deployment (niche showcase sites on CF Pages)
# Triggered automatically on push to main via .github/workflows/deploy-niche-demos.yml
# HVAC: profix-hvac-demo.pages.dev (.github/workflows/deploy-hvac-demo.yml)
# All other niches: demo-<niche>.pages.dev (matrix workflow)
# Manual trigger: gh workflow run deploy-niche-demos.yml

# Domain management
npm run domain check jazzheating.com
npm run domain suggest "Jazz Heating & Air" "Tracy"
npm run domain connect "jazz heating" jazzheating.com
npm run domain list
npm run add-domain            # attach custom domain to deployed CF Pages project

# Image regeneration (when AI images need a redo)
npm run regen-images          # usage: add name-fragment and optional shot-index

# Template hero/project image generation (fal.ai Flux Pro)
cd pipeline && node --env-file=.env --import=tsx/esm src/scripts/gen-hero-grid-images.ts              # all niches
cd pipeline && node --env-file=.env --import=tsx/esm src/scripts/gen-hero-grid-images.ts <niche>       # one niche
cd pipeline && node --env-file=.env --import=tsx/esm src/scripts/gen-hero-grid-images.ts <niche> <file> # one file
# Each shot can override size: 'portrait_4_3' (default) | 'landscape_16_9' — use landscape for hero bg images

# Pipeline TypeScript check
cd pipeline && node_modules/.bin/tsc --noEmit

# Test DB connection
cd pipeline && npx tsx src/scripts/test-db.ts

# Apply DB migrations (idempotent — run in order)
psql $DATABASE_URL -f pipeline/src/db/migration-v2.sql
psql $DATABASE_URL -f pipeline/src/db/migration-v3-audits.sql
psql $DATABASE_URL -f pipeline/src/db/migration-v4.sql
psql $DATABASE_URL -f pipeline/src/db/migration-v5.sql
psql $DATABASE_URL -f pipeline/src/db/migration-v6-growth-os.sql
psql $DATABASE_URL -f pipeline/src/db/migration-v7-launch-foundation.sql
psql $DATABASE_URL -f pipeline/src/db/migration-v8-ads-foundation.sql     # ad_campaign_drafts table
psql $DATABASE_URL -f pipeline/src/db/migration-v9-compliance-launch.sql
psql $DATABASE_URL -f pipeline/src/db/migration-v11-gbp-per-client.sql
psql $DATABASE_URL -f pipeline/src/db/migration-v12-lead-events.sql
psql $DATABASE_URL -f pipeline/src/db/migration-v24-ad-performance.sql  # ad_performance_daily — required for /api/ads/performance

# AI Reception (Gemini Live — GCP Cloud Run, port 3030)
npm run reception              # start reception server locally
npm run reception:migrate      # apply reception_configs table to Neon DB (run once)
npm run reception:setup        # provision reception for a business: npx tsx src/scripts/setup-reception.ts <url>
npm run reception:list         # list all provisioned receptions

# Reception server deploy (GCP Cloud Run — webcrew-501006, verified 2026-07-20)
# LIVE URL: https://ai-reception-459352382653.us-central1.run.app
# Redeploy after changes:
# 1. gcloud builds submit pipeline/ --tag us-central1-docker.pkg.dev/webcrew-501006/webcrew/ai-reception:latest --project=webcrew-501006
# 2. gcloud run deploy ai-reception --image=us-central1-docker.pkg.dev/webcrew-501006/webcrew/ai-reception:latest --region=us-central1 --project=webcrew-501006
# 3. Set Twilio phone webhook: POST https://ai-reception-459352382653.us-central1.run.app/voice/<configId>

# CF Worker env vars (for auto-provision on tier2 YES):
#   RECEPTION_SERVER_URL=https://ai-reception-459352382653.us-central1.run.app
#   RECEPTION_PROVISION_SECRET=wcreception-secret-2024

# Gemini Live model (bidiGenerateContent — confirmed working June 2026):
#   GEMINI_LIVE_MODEL=models/gemini-2.5-flash-native-audio-latest           # CURRENT DEFAULT — working
#   GEMINI_LIVE_MODEL=models/gemini-3.1-flash-live-preview                  # newer, untested
# WS endpoint: v1beta (NOT v1alpha). Old models removed: gemini-2.0-flash-live-001, gemini-2.5-flash-preview-native-audio-dialog
```

## Pipeline Architecture

`pipeline/src/orchestrator.ts` drives agents per lead, branching by tier:

**Tier 1 (no website) — full pipeline:**
```
lead-hunter    → Google Places API → tier1 (no website) + tier2 (has website) leads
brand-analyst  → Firecrawl scrape + Gemini → BrandData JSON (real photos, real reviews)
niche-brain    → Gemini → NicheProfile (unique visual style + cinematic prompts)
config-gen     → Gemini → TypeScript config.ts (real reviews as testimonials, niche copy)
image-gen      → real Google photos first; fal.ai Flux Pro fallback if < 4 real photos
video-gen      → Kling 1.6 Pro via fal.ai → 5s cinematic hero video
builder        → GitHub fork → writes config + uploads images + brand CSS injection
deployer       → Cloudflare Pages → polls until live
seo-agent      → sitemap.xml, robots.txt, schema JSON-LD
outreach       → Resend email + Twilio SMS: "here's your demo site — $299 one-time"
```

**Tier 2 (has website) — AI Reception outreach only:**
```
lead-hunter    → same as above
brand-analyst  → scrape for email/phone only
[everything else skipped]
outreach       → Resend email + Twilio SMS: "AI receptionist for [niche], test it: VAPI_DEMO_URL"
```

`Lead.status` full lifecycle:
`found → analyzed → config_generated → built → deployed → outreach_sent → sms_sent → conversation_active → meeting_scheduled → payment_link_sent → paid → handed_off`

Every step persists to Neon Postgres.

**Sheet-primary policy (2026-07-22):** the Google Sheet stays the primary lead store — reads/writes for outreach (`sheets-outreach.ts`, `sheets-sms-outreach.ts`) and scraping (`scrape-universal.ts`) go there directly. Neon's `leads` table is a secondary dedup/consent-lookup layer only, not the source of truth. Revisit once there are ≥10 paying clients. This does not apply to `consent_events`, `reception_configs`, or `call_logs` — those are compliance/live-client infrastructure that can't move to a sheet regardless of client count.

### Scale: Queue Worker (10-100 sites/day)

```bash
npm run worker:enqueue   # scan Google Maps + enqueue leads
npm run worker           # start N parallel workers (WORKER_CONCURRENCY=3)
npm run worker:status    # print queue depth
npm run worker:requeue   # retry stale leads
```

Uses `pg-boss` (Postgres-backed queue on Neon). `WORKER_CONCURRENCY` env controls parallelism.
Rate limits: Gemini 500 req/day free, fal.ai $0.04/img, Kling $0.05/video → ~$0.25/site total.

**Retention agents** (`pipeline/src/retention.ts`, run separately):
- `seo-agent` — generates sitemap.xml, robots.txt, schema JSON-LD, keyword list
- `gbp-agent` — posts weekly update to Google Business Profile via GMB API
- `reviews-agent` — fetches unanswered Google reviews, posts Gemini-generated replies
- `analytics-agent` — queries GSC for 28-day data, emails weekly summary to client
- `leads-agent` — handles contact form submissions → Neon + Google Sheets + Resend notify
- `video-agent` — Remotion 15s MP4 outreach video (install `@remotion/bundler @remotion/renderer remotion` first)

## packages/core (`@core/web`)

Shared library imported by every template. Never copy components between templates — extend core instead.

**Exports:**
```
@core/web            → sections + hooks + effects + types (barrel)
@core/web/sections   → Nav, Hero, HeroPhotoGrid, ScrollHero, Services, WhyUs,
                        Reviews, ServiceAreas, Contact, Footer, getIcon
@core/web/hooks      → useTextReveal, useEntranceReveal, useStaggerReveal,
                        useTilt, useParallax, useParticles, useScramble, useCounter
@core/web/types      → ThemeName, NicheName, Business, Service, Testimonial,
                        Stat, Reason, Property (all canonical config types)
@core/web/styles     → base CSS, tokens.css, utilities.css
```

**Hero variants:**
- `<Hero>` — cinematic full-bleed bg. Use `posterSrc="/hero-1.jpg"` for image bg, add `videoSrc` for video. Optional `posterBrightness` (0–1, default 0.45 — increase to 0.6–0.7 for portrait/people shots so subject is clearly visible). All niches now use this — no HeroPhotoGrid.
- `<ScrollHero>` — scroll-driven parallax hero (premium tier only)
- `<HeroPhotoGrid>` — deprecated for hero use. Do not use for new templates.

When adding a shared component, add to `packages/core/src/sections/` and export from `packages/core/src/sections/index.ts`.

## Template Architecture

Every template follows the same structure:
```
templates/<niche>/
  src/lib/config.ts          ← THE ONLY FILE that changes per client
  src/app/globals.css        ← @theme block with all CSS vars
  src/components/            ← nav, hero, services, why-us, reviews,
                                service-areas, contact, footer
  src/app/api/leads/route.ts ← POSTs to PIPELINE_API_URL/leads
```

**Design rules:**
- Tailwind v4 with `@theme {}` — ALL colors are CSS vars (`var(--color-*)`) never Tailwind color classes like `bg-green-500`
- GSAP only — no Framer Motion. Use `gsap.timeline()` for entrance sequences, `ScrollTrigger` for scroll-driven effects
- `EASE = [0.25, 0.46, 0.45, 0.94]` (or `"power3.out"`) everywhere for cinematic feel
- `next/link` is NOT used — plain `<a>` tags only
- Font weights `font-700`, `font-800`, `font-900` work as Tailwind utilities in v4

## Animation & UX Requirements (Draftly-standard)

Every template must implement ALL of the following. These are non-negotiable for award-winning feel.

### 1. Cinematic Loading Screen (`loading-screen.tsx`)
- Dark bg using `--brand-bg` gradient + aurora blobs
- Business name fades in → tagline fades in → progress bar fills → overlay slides up (yPercent: -100)
- Blocks body scroll (`overflow: hidden`) until complete
- Reference: `templates/hvac/src/components/loading-screen.tsx`

### 2. Scroll Progress Bar (`scroll-progress.tsx`)
- Fixed 2px bar at top of viewport
- Uses CSS var `--scroll-pct` driven by JS scroll listener
- Gradient: `--brand-accent` → `--brand-accent-light` with glow
- Reference: `templates/hvac/src/components/scroll-progress.tsx`

### 3. Lenis Smooth Inertia Scroll (`smooth-scroll.tsx`)
- `lerp: 0.1`, `smoothWheel: true`
- Must call `ScrollTrigger.update` on every Lenis scroll tick
- Already implemented — don't remove

### 4. GSAP Entrance Timelines (Hero)
Every hero must chain: label → badge → headline words → paragraph → CTAs → trust badges
```ts
const tl = gsap.timeline({ defaults: { ease: "power3.out" } })
tl.from(labelRef.current, { opacity: 0, y: -16, duration: 0.45 })
  .from(words, { yPercent: 110, opacity: 0, stagger: 0.045, duration: 0.75 }, "-=0.8")
  // ... continue chaining
```

### 5. Word-Split Headlines (ALL sections, not just hero)
Wrap headings in `<SplitText>` (word-wrap + word-inner pattern). Use `useTextReveal` hook:
```tsx
import { useTextReveal } from "@/hooks/use-text-reveal"
// in component:
useTextReveal(headingRef, { start: "top 85%" })
```
Reference: `templates/hvac/src/hooks/use-text-reveal.ts`

### 6. Multi-Layer Parallax (Hero)
Three speeds: background (yPercent: -25, scrub: 1.5), photo grid (yPercent: -15, scrub: 2), content fade (opacity → 0, scrub: 1)

### 7. Horizontal Pinned Scroll (Services)
Desktop only (matchMedia `min-width: 1024px`). Pin section, translate track by `-scrollWidth + vw`. Cards animate as they enter via `containerAnimation`. Mobile: standard vertical stagger.

### 8. GSAP quickTo 3D Tilt (Why-Us / Feature Cards)
```ts
const setRotX = gsap.quickTo(card, "rotationX", { duration: 0.4, ease: "power2.out" })
const setRotY = gsap.quickTo(card, "rotationY", { duration: 0.4, ease: "power2.out" })
gsap.set(card, { transformPerspective: 900, transformStyle: "preserve-3d" })
```
Dynamic box-shadow shifts with mouse position for depth illusion.

### 9. Staggered Card Entrances (ALL grid/card sections)
Use `useStaggerReveal` hook from `@/hooks/use-text-reveal`:
```tsx
useStaggerReveal(containerRef, ".service-card", { y: 48, scale: 0.95, stagger: 0.07 })
```

### 10. Particle Canvas (Hero background)
50 slow-moving dots, color from `--brand-particle` CSS var. Canvas resizes on window resize.

### 11. Aurora Blob Background (Hero + Loading Screen)
Two radial blobs using `--brand-blob-1` and `--brand-blob-2` with `filter: blur(80px)`. Animate with `@keyframes aurora-drift`.

### 12. Magnetic Cursor (`cursor.tsx`)
Custom cursor follows mouse with `lerp`. Already implemented — keep in all templates.

### 13. Premium Hover on ALL Interactive Elements
- Cards: `.hover-lift` class (translateY -6px + shadow on hover)
- Buttons: `.btn-primary` shimmer gradient animation (already in globals.css)
- Nav links: subtle accent underline slide-in
- Images: `scale(1.05)` on hover with `transition-transform duration-500`

### 14. Image Reveal Animation
Hero images and section images use `.img-reveal` wrapper. GSAP drives `clipPath: inset(0 100% 0 0)` → `inset(0 0% 0 0)` on scroll enter.

### 15. Scroll-Triggered Counter Animation (Stats)
Number counters animate from 0 to value when entering viewport. Use `gsap.to({ val: 0 }, { val: target, onUpdate: () => el.textContent = Math.round(obj.val) })`.

### 16. Section Entrance (every non-hero section)
All section headings/subheads use `useEntranceReveal` or `useTextReveal`. No section should just appear without animation.

---

### Animation Timing Reference
| Element | Duration | Ease | Delay |
|---------|----------|------|-------|
| Hero label | 0.45s | power3.out | 0 |
| Hero words | 0.75s | power3.out | stagger 0.045 |
| Hero para | 0.6s | power3.out | overlap |
| Section heading | 0.65s | power3.out | scroll |
| Cards stagger | 0.65s | power3.out | 0.07 per card |
| Loading bar | 1.1s | power2.inOut | after name |
| Loading exit | 0.75s | power4.inOut | after bar |
| 3D tilt | 0.4s | power2.out | mouse move |

**Hero layout options:** cinematic bg (videoSrc/posterSrc) vs photo grid (`<HeroPhotoGrid>` from `@core/web`). Photo grid is for interior/service-heavy niches (cleaning, dentist, medspa). All others use video bg.

## Niche Signature Sections (Phase 2)

Each niche has a custom section replacing the generic Services component. All use CSS vars — no hardcoded colors.

| Niche | Component | File |
|-------|-----------|------|
| medspa | `TreatmentMenuSection` | `templates/medspa/src/components/treatment-menu.tsx` |
| lawfirm | `PracticeAreasSection` + `AttorneySection` | `templates/lawfirm/src/components/` |
| dentist | `SmileGallerySection` | `templates/dentist/src/components/smile-gallery.tsx` |
| cleaning | `GuaranteeSection` | `templates/cleaning/src/components/guarantee-section.tsx` |
| roofing | `MaterialsSection` | `templates/roofing/src/components/materials-section.tsx` |
| remodeling | `ProjectGallerySection` | `templates/remodeling/src/components/project-gallery.tsx` |
| junk-removal | `ProcessSection` | `templates/junk-removal/src/components/process-section.tsx` |
| daycare | `CurriculumSection` | `templates/daycare/src/components/curriculum-section.tsx` |
| auto-detailing | `PackagesSection` | `templates/auto-detailing/src/components/packages-section.tsx` |
| hvac | `BrandStorySection` + `HeroThermostat` | already existed, no change |
| restaurant | custom sections | already existed, no change |
| luxury-realestate | custom sections | already existed, no change |
| skin-clinic | `SkinMenuSection` | `templates/skin-clinic/src/components/skin-menu.tsx` |
| iv-therapy | `DripMenuSection` | `templates/iv-therapy/src/components/drip-menu.tsx` |
| nail-studio | `NailMenuSection` | `templates/nail-studio/src/components/nail-menu.tsx` |
| epoxy-flooring | `FinishShowcaseSection` | `templates/epoxy-flooring/src/components/finish-showcase.tsx` |

## Theme System

`packages/core/src/styles/tokens.css` defines all themes via CSS custom properties.

| Theme | Used by | Accent |
|-------|---------|--------|
| `clean` | all service templates + nail-studio (pink accent override) | indigo `#6366F1` |
| `slate` | medspa, skin-clinic (rose accent override `#E879A0`) | violet `#8B5CF6` |
| `dubai` | luxury-realestate | gold `#C9A96E` |
| `noir` | — (pipeline assigns to lawfirm) | white |
| `ocean` | dentist, iv-therapy | cyan `#06B6D4` |
| `forest` | — (pipeline assigns to daycare) | emerald |
| `ember` | — (pipeline assigns to restaurant) | amber |

Each template's `globals.css` sets `:root { --font-display: ...; --font-body: ...; }` to override the clean theme's Inter fallback with the niche-appropriate font (Playfair for lawfirm, Cormorant for medspa, Montserrat for roofing, etc.).

**config.ts exports:** `BUSINESS`, `SERVICES`, `TESTIMONIALS`, `TRUST_BADGES` — all template components read only from these.

When adding a new niche template, also update:
- `pipeline/src/types.ts` — add to `PipelineConfig.niche` union
- `pipeline/src/agents/builder.ts` — add to `NICHE_TEMPLATE_DIR`
- `pipeline/src/agents/config-generator.ts` — add fallback services
- `package.json` root — add `dev:<niche>` script

## New Modules (committed July 2026)

| Module | Path | Status |
|--------|------|--------|
| **Ads planner** | `pipeline/src/ads/` | Wired into orchestrator (auto-generates Google Search + Meta + Instagram draft campaigns per lead). Admin approval UI live at `admin/src/app/ads/` (approve/reject/publish). Live publish: Google Ads real (creates PAUSED budget+campaign+adgroup+keywords+ad via Google Ads API, gated `ADS_PUBLISH_LIVE=true`), Meta real but partial (creates PAUSED campaign shell only — no ad set/creative yet). TikTok Ads: no integration exists. `GOOGLE_ADS_CLIENT_ID` set in `admin/.env.local` (reuses main Google OAuth client). `META_APP_ID` still missing — create app at developers.facebook.com. Google Ads API access level (test vs Standard) unconfirmed — Standard requires manual Google review before real client accounts can be used. |
| **Ads performance sync** | `admin/src/lib/ad-reporting.ts` | Pulls last 30 days spend/impressions/clicks/conversions from Google Ads (GAQL `googleAds:search`) + Meta (Graph API `/insights`) for published campaigns, upserts into `ad_performance_daily` (migration v24). Trigger: `POST /api/ads/performance/sync` (optional `{draftId}` body for one campaign) or "Sync Performance" button on `admin/src/app/ads/`. Read: `GET /api/ads/performance?draft_id=xxx&days=30` → totals (spend, CTR, cost-per-lead) + daily series. No auto-schedule yet — manual trigger only, wire into a cron/GCP Scheduler hit on the sync endpoint if this needs to run unattended. Shared OAuth/token logic (Google refresh, Meta account lookup) factored into `admin/src/lib/ad-connections.ts`, reused by both `ad-publisher.ts` and `ad-reporting.ts`. |
| **Growth OS** | `pipeline/src/growth/` | Growth brain + DB layer for per-client growth plans |
| **Compliance** | `pipeline/src/compliance/` | TCPA/ad policy checker + `getLaunchReadiness()` — blocked on `PUBLIC_PRIVACY_URL` + `PUBLIC_TERMS_URL` env |
| **Cal.com booking** | `pipeline/src/reception/cal-booking.ts` | LIVE — `check_availability` + `book_appointment` tools in Gemini Live. Key: `CAL_DIY_API_KEY`. Event type: `CAL_EVENT_TYPE_ID` (default `6126925`) |
| **GCP auth** | `pipeline/src/tools/gcp-auth.ts` | Vertex AI JWT auth |
| **Gemini client** | `pipeline/src/tools/gemini.ts` | Vertex AI Gemini client (alternative to google-ai-studio) |
| **Sheets SMS outreach** | `pipeline/src/scripts/sheets-sms-outreach.ts` | SMS outreach directly from Google Sheets rows |
| **Ad winners research** | `pipeline/src/ads/winners.ts` | $0 Meta Ad Library scraper — proven winners (60+ days AND still active). `winnersToCreativeBrief()` feeds planner/Gemini. Pattern from advertising-ops repo (evaluated 2026-07-13, not installed) |
| **RE walkthrough** | `pipeline/src/walkthrough/` | Listing photos → per-room Kling clips (room→camera-move map in `camera-moves.ts`) → ffmpeg stitch. Upsell for realestate niche. Pattern from re-walkthrough-pro repo (not installed; used own fal.ai stack, no Apify/Higgsfield) |

### TS Errors (5, non-fatal at runtime)
All in reception — `BusinessBrain | fallback` union not narrowed before passing to `buildSystemPrompt()` in `server.ts:286-287`, `setup-reception.ts:53-57`, and `FunctionDeclaration[]` mismatch in `gemini-live.ts:66`.
Fix: add `if (!brain || 'error' in brain) return fallbackBrain` guard before each call.

## Key Files

| File | Purpose |
|------|---------|
| `pipeline/src/types.ts` | `Lead`, `BrandData`, `PipelineConfig`, `AgentResult<T>` — all shared types |
| `pipeline/src/orchestrator.ts` | Main pipeline loop, sequential agent chaining |
| `pipeline/src/run.ts` | Entry point, reads env vars into `PipelineConfig` |
| `pipeline/src/retention.ts` | Retention loop — GBP, reviews, analytics for deployed clients |
| `pipeline/src/db/supabase.ts` | DB layer — uses `pg` + `DATABASE_URL` (Neon Postgres, not Supabase) |
| `pipeline/src/db/schema.sql` | DB schema — run once to initialize |
| `pipeline/src/db/migration-v2.sql` | Adds Places API v1 expanded fields + sales-funnel columns (idempotent) |
| `pipeline/src/tools/cost-tracker.ts` | `logCost()` — call from agents after paid API calls; query with `costs` script |
| `pipeline/src/tools/domain-registrar.ts` | Domain availability (RDAP) + CF Registrar integration + domain suggestions |
| `pipeline/src/tools/google-sheets.ts` | Sheets API — `appendSheetRow`, `clearSheet`, `writeSheetRows`, `listSheetTabs`, `batchUpdateSheet` |
| `pipeline/src/scripts/scrape-universal.ts` | **Master scraper** — all tabs, append-only, 22-column header. Runs email+phone enrichment per lead automatically. Use `SHEET_TAB=<tab>` env |
| `pipeline/src/scripts/enrich-existing-rows.ts` | Backfill email+phone cols for existing rows. Resume-safe. `SHEET_TAB`, `ENRICH_LIMIT`, `ENRICH_CONCUR` env |
| `pipeline/src/tools/email-extractor.ts` | Fetches website + /contact + /about, extracts business_email + owner_email via regex. 7s timeout, no API cost |
| `pipeline/src/tools/phone-lookup.ts` | Classifies phone as mobile/landline/voip/toll-free/unknown using libphonenumber-js/max (offline, free). Sets can_sms flag |
| `pipeline/src/scripts/rebuild-sheet.ts` | Rebuild "Local SMBs" from DB. **DESTRUCTIVE** — requires `--confirm` flag |
| `pipeline/src/scripts/list-tabs.ts` | List all tabs in the Google Spreadsheet |
| `pipeline/src/scripts/format-sheet.ts` | Apply professional formatting (header, widths, filters) to "Local SMBs" |
| `pipeline/src/scripts/regen-images.ts` | Regenerate fal.ai hero images for a lead by name fragment |
| `pipeline/src/scripts/add-domain.ts` | Attach custom domain to a deployed CF Pages project + update DB |
| `pipeline/src/scripts/domain.ts` | CLI for domain check / suggest / connect / list |
| `pipeline/src/scripts/costs.ts` | View spend by service (daily or all-time) |
| `pipeline/src/scripts/deps-tracker.ts` | Checks tracked deps via GitHub API |
| `packages/core/src/sections/index.ts` | Barrel — all shared section components |
| `packages/core/src/types/config.ts` | Canonical types: ThemeName, NicheName, Business, Service, etc. |
| `packages/core/src/hooks/index.ts` | Barrel — all animation hooks |
| `admin/src/app/page.tsx` | Dashboard home — reads live stats/leads/funnel from Neon |
| `admin/src/lib/db.ts` | Admin DB queries (read-only, no pg-boss) |
| `admin/src/lib/pool.ts` | CF Workers-compatible pg pool (no `pg` native bindings) |
| `admin/src/lib/edge-crypto.ts` | HMAC token signing for CF Workers (Web Crypto API) |
| `admin/Dockerfile` | Admin containerized deploy (for GCP Cloud Run if needed) |
| `admin/wrangler.toml` | Admin CF Worker deploy config |
| `api/src/index.ts` | CF Worker entry — contact form → Resend + Twilio + Google Sheets |
| `api/wrangler.toml` | Worker config — routes to api.webcrew.app |
| `pipeline/src/ads/planner.ts` | Generate Google/Meta/Instagram ad campaign drafts per lead |
| `pipeline/src/ads/store.ts` | Persist ad drafts to `ad_campaign_drafts` table |
| `pipeline/src/ads/export.ts` | Export drafts in platform-native API format |
| `pipeline/src/compliance/readiness.ts` | `getLaunchReadiness()` — full env/infra checklist |
| `pipeline/src/compliance/policy.ts` | TCPA/SMS/ad compliance policy checks |
| `pipeline/src/growth/brain.ts` | Growth plan generator (Gemini) |
| `pipeline/src/reception/cal-booking.ts` | Cal.com v2 — slot availability + booking creation |

## Security Hardening (2026-07-13)

Audit fixes applied — read before touching auth/webhooks:
- **Client portal cookie is now signed** (`admin/src/lib/client-session.ts`). `client_email` = `<email>.<hmac>`. Set via `signClientEmail`, verify via `verifyClientCookie` (middleware, dashboard page, billing-portal). Was plaintext = anyone could forge it and read any client's dashboard + Stripe billing.
- **Admin session secret** no longer falls back to the constant `webcrew-admin-secret`. Order: `SESSION_SECRET` → `ADMIN_PASSWORD` → dev-only string. **Set `SESSION_SECRET` (or at least `ADMIN_PASSWORD`) in prod** or admin tokens are forgeable. If `ADMIN_PASSWORD` is unset, the whole admin is still open by design — always set it.
- **Twilio webhooks now verify `X-Twilio-Signature`** (worker `/sms/reply` + `/call-status`, admin `/api/webhooks/sms`) — SHA-1 HMAC per Twilio spec. Blocks forged inbound SMS → toll fraud. Fails **open** if `TWILIO_AUTH_TOKEN` unset; escape hatch `SKIP_TWILIO_VALIDATION=true`. If real inbound SMS breaks at launch, the URL Twilio signs must exactly match `req.url` — set `SKIP_TWILIO_VALIDATION=true` to unblock, then debug.
- **Stripe webhook** compare is now timing-safe + rejects events >5 min old (replay).

Still open (not code-fixed): public `/leads` + `/audit` accept attacker-controlled `businessOwnerPhone` with no rate-limit/captcha → SMS toll-fraud vector; add Turnstile. Notification emails interpolate unescaped user input (low risk, internal recipient).

## TCPA SMS Consent Gate (2026-07-13)

**All outbound marketing SMS is consent-gated. Cold leads are EMAIL-ONLY.**
- Gate: `pipeline/src/tools/sms-consent.ts` — `hasSmsConsent(phone)` / `loadSmsConsentSet()` query `consent_events` (channel='sms', revoked_at IS NULL), matched on last-10-digits. **Fail-closed** (no DB / error / no row → no send). Override: `ALLOW_COLD_SMS=true` (accepts $500–$1,500/text TCPA exposure — don't).
- Gated senders: `sheets-sms-outreach.ts` (bulk consent set, exits early if 0 consents), `agents/outreach.ts` (all 3 SMS blocks), `agents/sms-outreach.ts` (`runSMSOutreachAgent` guard + throw backstop inside `sendSMS`), `agents/sms-agent.ts` (`runSmsAgent`), `tools/sms.ts` (`sendOutreachSMS`), `scripts/drip-followup.ts` (gated 2026-07-20, see below).
- Consent capture (CF Worker `api/src/index.ts` → `recordSmsConsent()`): inserts into `consent_events` on (1) `/leads` form submit with phone (express_written), (2) `/audit` form with phone (express_written), (3) any non-STOP inbound SMS reply (inbound_reply). STOP still revokes. Dedup: skips insert if active consent exists. **Worker must be redeployed (`npm run api:deploy`) for capture to go live** — until then gate blocks all SMS (safe default).
- Cold outreach channel = `sheets-outreach.ts` (email, CAN-SPAM opt-out regime — but do NOT send cold email via Resend at scale; Resend TOS prohibits cold outreach. Use dedicated cold-email tool + separate lookalike domains). SMS unlocks per-lead after form submit or inbound reply.
- **There is no "check a TCPA registry, then send" shortcut.** TCPA isn't a number database — it's a consent requirement on the sender. Absence from a DNC list or litigator list is not consent. Don't build outbound logic that treats "not on a blocklist" as "safe to text."

## SMS Drip / Follow-Up / Missed-Call Recovery (rebuilt 2026-07-20)

**One follow-up system, not three.** Previously had 3 competing implementations (DB-based `drip-followup.ts`, sheet-based `sms-followup.ts`, and a dead `follow_up` SmsType in `sms-agent.ts` never invoked by any caller). Consolidated to one:
- `pipeline/src/scripts/drip-followup.ts` — the only follow-up drip. Day-3 (FU1) + day-10 (FU2) SMS to leads with `status IN ('sms_sent','outreach_sent')` and no reply. Now consent-gated (`loadSmsConsentSet`/`consentSetAllows`, hard requirement) + optional litigator-list scrub layer (`tools/tcpa-litigator-check.ts`, see below) + E.164 phone normalization before every Twilio send (raw `leads.phone` is stored in mixed formats like `(415) 606-0079`).
- Retired: `scripts/sms-followup.ts` (sheet-based, read a `SMS-SENT` marker column that only `sheets-sms-outreach.ts` writes, was scheduled daily via launchd but had zero direct consent check of its own — deleted along with its plist/runner script). Retired: `follow_up` SmsType + `buildFollowUpSms` in `agents/sms-agent.ts` (unreachable — only `runSmsAgent(lead, 'initial')` is ever called, from `queue-worker.ts`).
- Cron: `com.webcrew.drip-followup` launchd job, daily 9:30am (`~/.webcrew-jobs/run-drip-followup.sh` → `npx tsx src/scripts/drip-followup.ts`). Manual: `npm run drip` / `npm run drip:dry`.
- **Litigator-list scrub** (`pipeline/src/tools/tcpa-litigator-check.ts`) — supplementary safety layer, NOT a consent substitute. Runs only on numbers that already passed the consent gate; reduces odds of texting a known serial TCPA plaintiff. Vendor: tcpalitigatorlist.com single-phone scrub API. Env: `TCPA_LITIGATOR_API_USERNAME` / `TCPA_LITIGATOR_API_PASSWORD` (unset → skipped with a warning, doesn't block sends — no vendor account provisioned yet, get creds at tcpalitigatorlist.com if this layer is wanted live). `TCPA_LITIGATOR_STRICT=true` treats a vendor lookup error as "listed" (blocks) instead of failing open.
- **Missed-call recovery** — `api/src/index.ts` `handleCallStatus()` (`POST /call-status`) was already fully built and consent-gated (checks `consent_events` before sending, logs to `missed_calls` table either way) but had never fired: number-provisioning never set `StatusCallback` on the purchased Twilio number, so Twilio had nowhere to POST the no-answer/busy/failed event. Fixed 2026-07-20 in both provisioning paths — `reception/server.ts` `buyLocalTwilioNumber()` and `scripts/provision-client.ts` `findAndBuyNumber()` — both now set `StatusCallback` to `${API_BASE_URL}/call-status?configId=...&biz=...&flow=inbound` when buying a number. Existing numbers backfilled via `pipeline/src/scripts/backfill-call-status-webhook.ts` (`DRY_RUN=true` first) — ran 2026-07-20, updated both live numbers (+19182555151 WebCrew, +14134667303 MH).
- Inbound SMS reply handling: live webhook is `POST https://api.webcrew.app/sms/reply` (confirmed via Twilio Messaging Service `inbound_request_url`) → `pipeline/src/agents/sms-reply-handler.ts` (Gemini-driven, handles STOP/opt-out + YES/interest + general conversation). `admin/src/app/api/webhooks/sms/route.ts` is a second, simpler inbound handler (keyword auto-replies, no STOP/opt-out handling at all) that is NOT wired to any live Twilio number or the Messaging Service — dead code, do not point new numbers at it as-is since it would silently ignore opt-out requests.

## LLM

Pipeline uses **Gemini 2.5 Flash** (`@google/generative-ai`) — not Claude. Free tier: 1,500 req/day for brand extraction, 500 req/day for config generation. Key: `GOOGLE_AI_API_KEY`.

## Environment Variables

Required in `pipeline/.env` (see `pipeline/.env.example`):

```
GOOGLE_AI_API_KEY          # Gemini 2.5 Flash — brand analysis + config generation
GOOGLE_PLACES_API_KEY      # lead discovery + PageSpeed
FIRECRAWL_URL              # https://api.firecrawl.dev (cloud) or http://localhost:3002 (self-hosted)
FIRECRAWL_API_KEY          # firecrawl.dev API key, or "local" for self-hosted
GITHUB_TOKEN               # ranjeetsinghai79 classic PAT with repo scope
CLOUDFLARE_TOKEN           # API token with Pages:Edit permission
CLOUDFLARE_ACCOUNT_ID      # from dash.cloudflare.com → Workers & Pages sidebar
DATABASE_URL               # Neon Postgres connection string (neon.tech)
PIPELINE_API_URL           # hosted pipeline API URL (for contact form lead capture)
RESEND_API_KEY
OUTREACH_FROM_EMAIL        # e.g. hello@yourdomain.com
GOOGLE_SERVICE_ACCOUNT_FILE  # path to service account JSON file (used in this setup)
# OR: GOOGLE_SERVICE_ACCOUNT_JSON  # inline JSON blob (alternative to FILE)
GBP_ACCOUNT_ID / GBP_LOCATION_ID
LEADS_SHEET_ID
BUSINESS_OWNER_EMAIL

# Pipeline run config
NICHE=hvac                 # any of the 12 niche values
LOCATION=Tracy, CA
CITY=Tracy
STATE=CA
COUNT=10
DRY_RUN=true
TEMPLATE_OWNER=ranjeetsinghai79
TEMPLATE_REPO=websitedeveloper
DEPLOY_OWNER=ranjeetsinghai79
```

Deployed templates read `BUSINESS_NAME`, `BUSINESS_NICHE`, `PIPELINE_API_URL` from their Cloudflare Pages env.

## Google APIs Auth

Sheets, GMB (Google My Business), and GSC all use the same service account. Auth is JWT-based via `crypto.createSign('RSA-SHA256')` — no OAuth flow. Set `GOOGLE_SERVICE_ACCOUNT_FILE` to the path of the JSON key file from GCP Console → Service Accounts → Keys → JSON. Alternatively set `GOOGLE_SERVICE_ACCOUNT_JSON` to the inline JSON blob — the tools check `FILE` first, then `JSON`.

## Git Remotes

```
webcrew  → github.com/ranjeetsinghai79/webcrew           (PRIMARY deploy — push here first)
origin   → github.com/ranjeetsinghai79/websitedeveloper  (legacy backup)
pavan    → github.com/pavankumarharati/websitedeveloper   (personal backup)
```

Push: `git push webcrew main && git push origin main && git push pavan main`

## webcrew/ — Marketing Site (webcrew.app)

Separate git repo at `webcrew/` (gitignored by monorepo root `.gitignore`).
Remotes: `deploy` → ranjeetsinghai79/webcrew (CF Pages auto-deploy), `origin` → pavankumarharati/webcrew.
Push: `git -C webcrew push deploy main` (only `deploy` remote works with ranjeet's token).

**Design system:** Electric blue + purple (`#2563EB → #7C3AED`). No dark theme. Bright/light background.
Font: Plus Jakarta Sans (display) + Inter (body).
Palette tokens: `--color-blue`, `--color-purple`, `--color-indigo`, `--color-bg`, `--color-surface`.
Class: `.gradient-brand` = blue→purple gradient text.

**Pricing model (single source of truth):**
- FREE demo site built overnight (Tier 1 — no website)
- $299 one-time — pay only if you love it (site ownership)
- $49/mo — AI team: AI call answering (Gemini Live), GBP posts, review replies, GSC weekly report, lead SMS alerts
- Custom — multi-location, e-commerce, booking, CRM integrations

**Outreach strategy:**
- Tier 1 (no website) SMS: "We built your {niche} business in {city} a FREE website overnight. See it → webcrew.app Pay $299 only if you love it."
- Tier 2 (has website) SMS: "AI receptionist for {niche} in {city} — answers calls 24/7, $49/mo. Try free → webcrew.app"
- Outreach channel: SMS ONLY (Twilio 10DLC, $0.0079/SMS). AI Reception = inbound product, NOT outbound call tool.
- CTA destination: webcrew.app → contact form → books call or triggers pipeline
- Cal.com booking: integrated in AI Reception (check_availability + book_appointment via CAL_DIY_API_KEY)
- Batch: start 200/day, ramp to 1000/day (Week 2), max 3600/day (10DLC standard limit)

**Contact form flows:**
- Tab 1 "No Website" → `POST https://api.webcrew.app/leads` → Tier 1 pipeline
- Tab 2 "Upgrade My Site" → same endpoint with `flowType: 'upgrade'` + currentUrl
- Tab 3 "Free Audit" → `POST https://api.webcrew.app/audit` → Firecrawl + PageSpeed + Gemini → HTML report email in 5 min
  - Phone is REQUIRED (mandatory) on audit form
  - Audit consent includes SMS opt-in for follow-up

**Twilio 10DLC compliance (A2P):**
- Consent model: inbound-only — users opt in via website form checkbox
- Consent copy: "I agree to receive text messages from WebCrew regarding my website demo... Consent is not a condition of purchase."
- Privacy policy at `/privacy`: includes exact carrier clause — "No mobile information will be shared with third parties/affiliates for marketing/promotional purposes..."
- SMS section states explicitly: "We do not engage in unsolicited cold texting."
- `webcrew/src/app/privacy/page.tsx` — carrier clause in Data Sharing section

**SEO/AEO/VSO (layout.tsx):**
- JSON-LD: FAQPage (6 Q&As), HowTo (3 steps), Organization, Service schemas
- Title targets: "AI builds your local business website overnight free"
- HowTo schema for voice search: 3-step process (sign up → AI builds → wake up to leads)
- FAQPage for AEO: answers ChatGPT/Perplexity/Claude queries about WebCrew pricing, speed, niches

**Dev:** `npm run dev:webcrew` → `http://localhost:3002`
**Deploy:** push to `deploy` remote triggers CF Pages build (Next.js static export)

## Business Brain (Firecrawl per-business LLM context)

`pipeline/src/tools/firecrawl.ts` exports `crawlBusinessSite(url, opts) → BusinessBrain`

BusinessBrain is the persistent LLM context for each client. Powers:
- **audit-report**: PageSpeed + Firecrawl + Gemini → HTML grade report (attached to outreach email)
- **brand-analyst**: extract services, pricing, team, colors, testimonials, USPs
- **config-generator**: hyper-personalized config.ts with real business data
- **image-generator**: use brain.media.gallery_images + hero_images from existing site
- **ai-reception**: knowledge base (services, hours, pricing, FAQs) for the AI receptionist
- **blog-generator** (retention): Gemini uses brain.full_text to write SEO posts in client's voice
- **ai-growth**: GBP posts written using real business context from brain

Media extraction from brain:
- `brain.media.images` — all image URLs across site
- `brain.media.hero_images` — og:image + above-fold images
- `brain.media.gallery_images` — portfolio/work photos
- `brain.media.before_after` — [{before, after, caption}] pairs
- `brain.media.youtube_embeds` — YouTube video IDs
- `brain.media.video_testimonials` — videos near review/testimonial context
- `brain.media.logo_url` — business logo

Brain is persisted to `leads.business_brain` (JSONB) in Neon DB.

## GCP Infrastructure

`ai-reception` confirmed live on project `webcrew-501006` / `us-central1` (verified 2026-07-20 via `gcloud run services list` — this is the only Cloud Run service currently deployed under this project/account). The `gen-lang-client-0844283339` project id below is unverified as of 2026-07-20 — it does not appear in `gcloud projects list` for the currently authenticated account, so firecrawl/scraper deployment location needs reconfirming before relying on it:
- `ai-reception` — Gemini Live + Twilio Media Streams (live, `webcrew-501006`)
- `firecrawl` — self-hosted Firecrawl API + Redis sidecar (deployed via `pipeline/firecrawl/`) — project unverified
- Scraper Cloud Run Jobs — 12 jobs, triggered by Cloud Scheduler (see `pipeline/deploy-gcp.sh`) — project unverified

Firecrawl URL after deploy: set `FIRECRAWL_URL` to Cloud Run service URL
Deploy Firecrawl: `bash pipeline/deploy-gcp.sh`
Deploy scraper jobs: same script (section 4)

## Firecrawl

Cloud API only: `FIRECRAWL_URL=https://api.firecrawl.dev` + `FIRECRAWL_API_KEY` (free 500 scrapes/month at firecrawl.dev). Used only by `brand-analyst` agent — falls back to Google Places data if unavailable.

## Active Claude Skills (invoke before web design work)

### MANDATORY: Cinematic Build Master Skill
**Before ANY template work, component creation, animation, or design decision — invoke `/cinematic-build` first.**
This is the single entry point that loads all GSAP patterns, quality gates, MCP server usage, and the full stack context.
Never start building without it.

### Skill Reference Table

| Trigger | Skill | What it activates |
|---------|-------|-------------------|
| **ANY template/component/animation work** | `/cinematic-build` | **MASTER** — full stack context, all GSAP patterns, 16-point gate, MCP usage |
| Complex ScrollTrigger / pinned sections | `gsap-scrolltrigger` | Pin, scrub, trigger config, Lenis integration |
| GSAP plugins (SplitText, Flip, Draggable) | `gsap-plugins` | Plugin registration, SplitText word split, Flip state |
| Timeline sequencing / stagger choreography | `gsap-timeline` | Position parameter, nesting, `add()`, labels |
| Animation performance / 60fps / jank | `gsap-performance` | will-change, batching, compositor-only transforms |
| React/Next.js useGSAP hook / cleanup | `gsap-react` | useGSAP, contextSafe, scope, SSR guards |
| Next.js bundle / data fetching / LCP | `react-best-practices` | Server components, bundle split, image optimization |
| Vercel cost / function count / caching | `vercel-optimize` | Edge config, ISR, function invocation reduction |
| Route transitions / shared element anim | `react-view-transitions` | ViewTransition API, addTransitionType, CSS pseudo-els |
| Design system audit / accessibility | `web-design-guidelines` | WCAG, contrast, spacing, hierarchy |
| New niche theme / color system | `brand-guidelines` | Color tokens, font pairing, visual language |
| Canvas FX / particle systems / WebGL | `canvas-design` | Aurora blobs, particle canvas, shader effects |
| Before CF Pages / GCP deploy | `web-perf` | LCP < 2s, zero CLS, composited-only animations |
| Frontend component / CSS / token systems | `frontend-design` | Tailwind v4 patterns, CSS custom properties |
| Premium UX / spacing / visual hierarchy | `ui-ux-pro-max` | Spacing systems, interaction design, premium patterns |
| Contact forms / API routes / auth | `owasp-security` | XSS, CSRF, injection — $25k clients require this |
| Post-build QA of interactions | `webapp-testing` | Every hover, scroll trigger, mobile breakpoint |

### MCP Servers (active now)
- **21st Magic** (`/ui <description>`) — Generate polished React components from natural language. Always specify "Next.js, Tailwind v4, CSS vars, cinematic luxury feel".
- **shadcn-ui** — Query component source/docs for forms, dialogs, tables, interactive UI. Use for Contact section forms and admin components.

## Luxury Design Quality Gates ($20k Standard)

Every template must pass ALL before merge/deploy:

### Visual
- [ ] Cinematic loading screen with progress bar — dark bg, brand aurora blobs, name → tagline → bar → overlay exit
- [ ] Custom magnetic cursor (`cursor.tsx`) — context-aware, follows with lerp
- [ ] Zero hardcoded colors — CSS vars only (`var(--color-*)`, never `bg-green-500`)
- [ ] Word-split reveals on ALL headings (not just hero) — `useTextReveal` hook
- [ ] Scroll progress bar — fixed 2px top, gradient accent with glow

### Animation
- [ ] Hero entrance timeline chains: label → badge → headline words → paragraph → CTAs → trust badges
- [ ] 3D tilt on feature/why-us cards — `gsap.quickTo` rotationX/Y + dynamic shadow
- [ ] Horizontal pinned scroll on Services (desktop ≥1024px) — mobile vertical stagger
- [ ] Image reveals — `clipPath: inset(0 100% 0 0)` → `inset(0 0%)` on scroll enter
- [ ] Stats counters animate 0 → value on viewport enter
- [ ] All card grids use `useStaggerReveal` — no section appears without animation

### Performance
- [ ] LCP ≤ 2.5s (measure with PageSpeed or Lighthouse)
- [ ] CLS = 0 — no layout shift on font load or image load
- [ ] `will-change: transform` on animated elements, removed after animation completes
- [ ] Hero images use `next/image` with `priority` + correct `sizes`
- [ ] Lenis + ScrollTrigger wired: `ScrollTrigger.update` called on every Lenis tick

### Mobile
- [ ] Horizontal scroll section degrades to vertical stagger on mobile
- [ ] Custom cursor hidden on touch devices
- [ ] Loading screen exit ≤ 1.5s on 3G (don't block on heavy assets)
- [ ] All GSAP `matchMedia` guards in place for desktop-only effects

## npm Packages for $20k Luxury Feel

Already in stack: `gsap`, `@studio-freight/lenis`. Add if needed:

```bash
# WebGL / 3D backgrounds (luxury real estate, medspa, skin-clinic)
npm install three @types/three
npm install @react-three/fiber @react-three/drei

# Noise texture shaders (organic luxury feel)
npm install glsl-noise

# Premium icon set (beyond lucide — for luxury niches)
npm install @phosphor-icons/react
```

Three.js is optional — use only for `luxury-realestate`, `medspa`, `skin-clinic` where WebGL hero adds value. All other niches: canvas particle system sufficient.
