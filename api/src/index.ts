/**
 * Webcrew API — Cloudflare Worker
 * Deploy: cd api && npx wrangler deploy
 * Domain: api.webcrew.app
 *
 * Routes:
 *   POST /leads          — contact form submissions from all deployed sites
 *   POST /sms/reply      — Twilio inbound SMS webhook + Gemini reply agent
 *   GET  /hitl           — HITL approval page (Ranjeet reviews + sends demo link)
 *   POST /hitl/send      — sends demo SMS + email to lead after approval
 *   GET  /health         — uptime check
 */

export interface Env {
  RESEND_API_KEY: string
  TWILIO_ACCOUNT_SID: string
  TWILIO_AUTH_TOKEN: string
  TWILIO_FROM_NUMBER: string
  LEADS_SHEET_ID: string
  GOOGLE_SERVICE_ACCOUNT_JSON: string
  NOTIFICATION_EMAIL: string       // pavan.harati@gmail.com
  CALENDLY_URL: string
  HITL_SECRET?: string             // shared secret for approval links (set via wrangler secret)
  NEON_DATABASE_URL?: string
  DATABASE_URL?: string
  VERTEX_PROJECT_ID?: string
  VERTEX_CREDITS_PROJECT_ID?: string
  VERTEX_SERVICE_ACCOUNT_JSON?: string
  GOOGLE_AI_API_KEY?: string       // fallback only — prefer GOOGLE_SERVICE_ACCOUNT_JSON + Vertex AI
  RECEPTION_SERVER_URL?: string
  RECEPTION_PROVISION_SECRET?: string
  CAL_WEBHOOK_SECRET?: string
  GOOGLE_REVIEW_URL_TEMPLATE?: string  // e.g. "https://g.page/r/{placeId}/review"
  SKIP_TWILIO_VALIDATION?: string      // set to 'true' only to bypass signature check (debug)
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException?(): void
}

const VOICE_SYSTEM_PROMPT = `You are WebCrew's friendly AI receptionist. Solve the caller's immediate problem first. Learn their name, business, biggest missed-call or follow-up pain, and desired next step. Explain only the WebCrew capability relevant to that pain. Ask one short question at a time. Never pressure the caller. Keep every spoken response under 160 characters.`

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function encodeVoiceHistory(history: ChatMessage[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(history.slice(-8)))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeVoiceHistory(value: string | null): ChatMessage[] {
  if (!value) return []
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes))
    return Array.isArray(parsed) ? parsed.slice(-8) : []
  } catch { return [] }
}

async function handleInboundVoice(req: Request, env: Env, configId: string, mode: 'inbound' | 'overflow' | 'outbound' = 'inbound'): Promise<Response> {
  const form = new URLSearchParams(await req.text())
  if (!(await validateTwilioSignature(env, req, form))) {
    return new Response('Invalid signature', { status: 403 })
  }

  const safeConfig = configId.replace(/[^a-zA-Z0-9_-]/g, '')
  const action = `https://api.webcrew.app/voice/continue/${safeConfig}?step=0`
  const leadName = new URL(req.url).searchParams.get('leadName')?.slice(0, 80) ?? ''
  const opening = mode === 'overflow'
    ? 'I am sorry for the brief delay. You reached WebCrew&apos;s recovery assistant. What were you calling about?'
    : mode === 'outbound'
      ? `Hi${leadName ? ` ${xmlEscape(leadName)}` : ''}, this is WebCrew&apos;s AI assistant following up about helping your business capture more leads. Is now a good time for one quick question?`
      : 'Hi, you reached WebCrew&apos;s AI receptionist. What would you like help solving in your business today?'
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" speechTimeout="auto" timeout="5" action="${xmlEscape(action)}" method="POST">
    <Say voice="Polly.Joanna-Neural">${opening}</Say>
  </Gather>
  <Say voice="Polly.Joanna-Neural">I did not hear a response. Please call back anytime. We are available twenty four seven.</Say>
</Response>`

  return new Response(twiml, { headers: { 'Content-Type': 'text/xml; charset=utf-8' } })
}

async function handleOutboundCall(req: Request, env: Env): Promise<Response> {
  if (!env.RECEPTION_PROVISION_SECRET || req.headers.get('Authorization') !== `Bearer ${env.RECEPTION_PROVISION_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }
  const payload = await req.json() as { to?: string; configId?: string; leadName?: string }
  if (!payload.to || !payload.configId) return new Response(JSON.stringify({ error: 'to and configId required' }), { status: 400 })

  const voiceUrl = new URL(`https://api.webcrew.app/voice/outbound/${encodeURIComponent(payload.configId)}`)
  if (payload.leadName) voiceUrl.searchParams.set('leadName', payload.leadName)
  const statusUrl = new URL('https://api.webcrew.app/call-status')
  statusUrl.searchParams.set('configId', payload.configId)
  statusUrl.searchParams.set('biz', 'WebCrew')
  statusUrl.searchParams.set('flow', 'outbound_outreach')
  const params = new URLSearchParams({
    To: payload.to,
    From: env.TWILIO_FROM_NUMBER,
    Url: voiceUrl.toString(),
    Method: 'POST',
    StatusCallback: statusUrl.toString(),
    StatusCallbackMethod: 'POST',
    StatusCallbackEvent: 'initiated ringing answered completed',
    MachineDetection: 'Enable',
  })
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  })
  const result: any = await response.json()
  return new Response(JSON.stringify(response.ok ? { ok: true, callSid: result.sid, status: result.status } : { ok: false, error: result.message }), {
    status: response.ok ? 200 : response.status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleVoiceContinue(req: Request, env: Env, configId: string, url: URL): Promise<Response> {
  const form = new URLSearchParams(await req.text())
  if (!(await validateTwilioSignature(env, req, form))) return new Response('Invalid signature', { status: 403 })

  const speech = (form.get('SpeechResult') ?? '').trim()
  const step = Math.min(Number(url.searchParams.get('step') ?? '0') || 0, 6)
  const history = decodeVoiceHistory(url.searchParams.get('history'))
  const done = step >= 5 || /\b(goodbye|bye|that is all|that's all|no thank you)\b/i.test(speech)
  const reply = speech
    ? await geminiSMSReply(env, VOICE_SYSTEM_PROMPT, history, speech).catch(() => '')
    : 'I did not catch that. Could you say it once more?'
  const spoken = reply || 'I can help with missed calls, lead follow-up, and appointment booking. What is the biggest problem you want to solve?'
  const nextHistory = [...history, { role: 'user' as const, text: speech }, { role: 'model' as const, text: spoken }]

  if (done) {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">${xmlEscape(spoken)} Thank you for calling WebCrew. We will follow up shortly.</Say><Hangup/></Response>`, { headers: { 'Content-Type': 'text/xml; charset=utf-8' } })
  }

  const action = `https://api.webcrew.app/voice/continue/${configId}?step=${step + 1}&history=${encodeURIComponent(encodeVoiceHistory(nextHistory))}`
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" speechTimeout="auto" timeout="6" action="${xmlEscape(action)}" method="POST">
    <Say voice="Polly.Joanna-Neural">${xmlEscape(spoken)}</Say>
  </Gather>
  <Say voice="Polly.Joanna-Neural">Thank you for calling WebCrew. We will follow up shortly.</Say>
</Response>`
  return new Response(twiml, { headers: { 'Content-Type': 'text/xml; charset=utf-8' } })
}

// ─── Twilio webhook signature validation ────────────────────────────────────
// Without this, anyone can POST forged inbound SMS / call-status events to our
// public webhooks — triggering auto-replies (SMS toll fraud), fake build
// requests, and Gemini calls (cost). Twilio signs each request:
//   signature = base64( HMAC-SHA1( authToken, fullUrl + sorted(key+value)... ) )
async function validateTwilioSignature(env: Env, req: Request, params: URLSearchParams): Promise<boolean> {
  if (env.SKIP_TWILIO_VALIDATION === 'true') return true
  const authToken = env.TWILIO_AUTH_TOKEN
  if (!authToken) return true // not configured yet — fail open so setup isn't blocked

  const signature = req.headers.get('X-Twilio-Signature')
  if (!signature) return false

  // Reconstruct the exact URL Twilio signed. Behind Cloudflare this is the
  // public https URL; strip any cf/query noise Twilio would not have signed
  // for a form POST (Twilio signs the URL exactly as configured).
  const url = req.url

  const keys = [...params.keys()].sort()
  let data = url
  for (const k of keys) data += k + (params.get(k) ?? '')

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))

  // constant-time-ish compare
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return diff === 0
}

// ─── Contact form lead ────────────────────────────────────────────────────

interface ContactLead {
  firstName: string
  lastName?: string
  phone?: string
  email?: string
  currentWebsite?: string
  service?: string
  message?: string
  source: string
  businessName: string
  businessNiche: string
  businessOwnerPhone?: string   // injected by builder from lead data
  businessOwnerEmail?: string   // injected by builder from lead data
  submittedAt: string
  smsConsent?: boolean
  consentTimestamp?: string
  consentLanguage?: string
  painPoints?: string
  missedCalls?: string
  urgency?: string
  additionalNotes?: string
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function prepareLeadValuePlan(lead: ContactLead) {
  const selectedPain = lead.painPoints?.trim() || ''
  const prospectNotes = lead.additionalNotes?.replace(/\s+/g, ' ').trim() || ''
  // "Other" is a form control, not a useful description. Reflect the prospect's
  // own explanation when they supplied one, and fall back gracefully if not.
  const pain = selectedPain === 'Other'
    ? (prospectNotes.slice(0, 500) || 'a business challenge that needs a closer look')
    : (selectedPain || 'the pressure points in your front office')
  const plans: Record<string, { recommendation: string; firstValue: string; nextQuestion: string }> = {
    'Not getting enough qualified leads': {
      recommendation: 'Build a focused lead-generation system around the highest-value service, then connect every enquiry to immediate qualification and follow-up.',
      firstValue: 'Choose one profitable service, one ideal customer and one service area first. A narrow offer usually produces clearer demand than advertising everything at once.',
      nextQuestion: 'Which service creates the best combination of profit, close rate and repeat business?',
    },
    'Ad campaigns are not producing customers': {
      recommendation: 'Audit the offer, targeting, conversion page and follow-up together before increasing ad spend; the leak may be after the click rather than in the campaign.',
      firstValue: 'Compare ad clicks, real enquiries and booked customers for the same period. The biggest percentage drop identifies where to investigate first.',
      nextQuestion: 'Are you getting too few enquiries, poor-quality enquiries, or enquiries that never become appointments?',
    },
    'Missing calls while on jobs': {
      recommendation: 'Route unanswered calls to an AI receptionist that qualifies the caller and protects your focus while you are working.',
      firstValue: 'Start by listing the five questions every new caller asks. Those answers become the first version of your reception playbook.',
      nextQuestion: 'Which calls are most valuable—and which ones interrupt your team without becoming real jobs?',
    },
    'Calls going unanswered after hours': {
      recommendation: 'Add after-hours answering, qualification and next-day booking so good callers do not reach a competitor first.',
      firstValue: 'Review the last two weeks of calls by hour. That quickly shows the window where revenue is leaking.',
      nextQuestion: 'What should happen when an urgent caller reaches you after hours?',
    },
    'Slow lead follow-up': {
      recommendation: 'Respond immediately, preserve the conversation context and keep following up until the lead books or clearly declines.',
      firstValue: 'Measure the minutes between each new enquiry and the first useful response. That is the first number we should improve.',
      nextQuestion: 'Where do new enquiries arrive today—phone, forms, text, email or several places?',
    },
    'Not qualifying callers before booking': {
      recommendation: 'Use a short qualification flow before showing appointment options, so the calendar contains better opportunities.',
      firstValue: 'Write down the three facts that decide whether a caller is a strong fit. We can turn those into a consistent call flow.',
      nextQuestion: 'What must be true before a caller deserves time on your calendar?',
    },
    'Too much time spent answering repeat questions': {
      recommendation: 'Build a living business knowledge base so routine questions are answered consistently while unusual cases reach a person.',
      firstValue: 'Collect the ten questions your team repeats most. Automating those creates the fastest time savings.',
      nextQuestion: 'Which repeated question consumes the most time or creates the most confusion?',
    },
    'Leads disappearing before they schedule': {
      recommendation: 'Use context-aware follow-up and a simple booking handoff that removes delay and makes the next step obvious.',
      firstValue: 'Check where the last ten interested leads stopped responding. The common stopping point usually reveals the first workflow to fix.',
      nextQuestion: 'What normally happens between a prospect saying “interested” and receiving a confirmed appointment?',
    },
  }
  const selected = plans[selectedPain] ?? {
    recommendation: 'Map the customer journey first, then automate the highest-friction handoff without forcing your business into a generic workflow.',
    firstValue: 'Describe one recent customer you should have won but lost. That story usually reveals the best first automation.',
    nextQuestion: 'If we fixed one part of the business this month, which result would matter most?',
  }
  return { pain, ...selected }
}

// ─── Resend email ─────────────────────────────────────────────────────────

async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<void> {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'WebCrew <leads@webcrew.app>',
      reply_to: 'leads@webcrew.app',
      to,
      subject,
      html,
    }),
  })
}

// ─── Twilio SMS ───────────────────────────────────────────────────────────

async function sendSms(env: Env, to: string, body: string): Promise<void> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_FROM_NUMBER) return
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`
  const params = new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: body })
  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })
}

// Neon SQL-over-HTTP: POST https://<endpoint-host>/sql with Neon-Connection-String header.
// Response: { rows: [...], rowCount, command }
async function neonQuery(env: Env, query: string, params: unknown[] = []): Promise<any | null> {
  const cs = env.DATABASE_URL || env.NEON_DATABASE_URL
  if (!cs) return null
  try {
    const host = cs.replace(/^postgres(ql)?:\/\/[^@]+@/, '').split('/')[0].split('?')[0]
    const res = await fetch(`https://${host}/sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Neon-Connection-String': cs,
      },
      body: JSON.stringify({ query, params }),
    })
    if (!res.ok) {
      console.error(`[Neon] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return null
    }
    return await res.json()
  } catch (e: any) {
    console.error(`[Neon] fetch error: ${e?.message ?? e}`)
    return null
  }
}

// Records TCPA SMS consent (express_written from forms, inbound_reply from SMS).
// Pipeline senders check consent_events before any outbound SMS — without a row
// here the number is email-only. Dedup: skips if active consent already exists.
async function recordSmsConsent(
  env: Env,
  phone: string,
  consentType: 'express_written' | 'inbound_reply',
  source: string,
  consentText: string,
  req?: Request
): Promise<void> {
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 10) return
  const e164 = `+1${digits.slice(-10)}`
  await neonQuery(
    env,
    `INSERT INTO consent_events (channel, contact, consent_type, source, consent_text, ip_address, user_agent)
     SELECT 'sms', $1, $2, $3, $4, $5, $6
     WHERE NOT EXISTS (
       SELECT 1 FROM consent_events WHERE channel = 'sms' AND contact = $1 AND revoked_at IS NULL
     )`,
    [
      e164, consentType, source, consentText.slice(0, 500),
      req?.headers.get('CF-Connecting-IP') ?? null,
      req?.headers.get('User-Agent') ?? null,
    ]
  )
}

// Logs an inbound-SMS activity event against the matching lead's timeline.
async function logSmsEvent(
  env: Env,
  phone: string,
  eventType: 'sms_replied' | 'sms_opted_out',
  detail?: Record<string, unknown>
): Promise<void> {
  const lead = await neonQuery(
    env,
    `SELECT id FROM leads WHERE phone = $1 OR international_phone = $1 LIMIT 1`,
    [phone]
  )
  const leadId = lead?.rows?.[0]?.id
  if (!leadId) return
  await neonQuery(
    env,
    `INSERT INTO lead_events (lead_id, event_type, detail) VALUES ($1, $2, $3)`,
    [leadId, eventType, detail ? JSON.stringify(detail) : null]
  )
}

// ─── Google Sheets append ─────────────────────────────────────────────────

async function appendToSheets(env: Env, lead: ContactLead): Promise<void> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.LEADS_SHEET_ID) return
  try {
    const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON)
    // Simple JWT + Sheets append via REST — full impl in retention agent
    // Minimal version: just log, full version wired in pipeline retention.ts
    console.log(`[Sheets] Lead from ${lead.businessName}: ${lead.firstName} ${lead.phone || lead.email}`)
  } catch { /* non-blocking */ }
}

// ─── POST /leads handler ──────────────────────────────────────────────────

async function handleLeadSubmission(req: Request, env: Env): Promise<Response> {
  const lead: ContactLead = await req.json()
  const visitorName = `${lead.firstName}${lead.lastName ? ' ' + lead.lastName : ''}`
  const contact = lead.phone || lead.email || 'unknown'
  const valuePlan = prepareLeadValuePlan(lead)

  // 1. Notify us — every lead logged to our email
  await sendEmail(
    env,
    env.NOTIFICATION_EMAIL || 'leads@webcrew.app',
    `Website form lead · ${lead.businessName} — ${visitorName}`,
    `
    <h2>New contact form submission</h2>
    <table>
      <tr><td><b>Business:</b></td><td>${lead.businessName} (${lead.businessNiche})</td></tr>
      <tr><td><b>Visitor:</b></td><td>${visitorName}</td></tr>
      <tr><td><b>Phone:</b></td><td>${lead.phone || '—'}</td></tr>
      <tr><td><b>Email:</b></td><td>${lead.email || '—'}</td></tr>
      <tr><td><b>Current website:</b></td><td>${lead.currentWebsite || '—'}</td></tr>
      <tr><td><b>Service:</b></td><td>${lead.service || '—'}</td></tr>
      <tr><td><b>Message:</b></td><td>${lead.message || '—'}</td></tr>
      <tr><td><b>Pain point:</b></td><td>${lead.painPoints || '—'}</td></tr>
      <tr><td><b>Missed calls/week:</b></td><td>${lead.missedCalls || '—'}</td></tr>
      <tr><td><b>Urgency:</b></td><td>${lead.urgency || '—'}</td></tr>
      <tr><td><b>Prospect's own notes:</b></td><td>${lead.additionalNotes ? escapeHtml(lead.additionalNotes) : '—'}</td></tr>
      <tr><td><b>SMS consent:</b></td><td>${lead.smsConsent ? 'Yes' : 'No'}</td></tr>
      <tr><td><b>Source:</b></td><td>${lead.source}</td></tr>
      <tr><td><b>Time:</b></td><td>${lead.submittedAt}</td></tr>
    </table>
    <h3>Prepared response notes</h3>
    <p><b>Start by acknowledging:</b> ${escapeHtml(valuePlan.pain)}</p>
    <p><b>Likely solution:</b> ${escapeHtml(valuePlan.recommendation)}</p>
    <p><b>Value to provide immediately:</b> ${escapeHtml(valuePlan.firstValue)}</p>
    <p><b>Best next question:</b> ${escapeHtml(valuePlan.nextQuestion)}</p>
    `
  )

  // WebCrew prospects receive useful, problem-specific value immediately. This
  // is transactional email about their submitted enquiry, not a drip campaign.
  if (lead.email && lead.source === 'webcrew.app/missed-call-landing') {
    const businessName = lead.businessName?.trim() || 'your business'
    const bookingUrl = escapeHtml(env.CALENDLY_URL || 'https://webcrew.app')
    await sendEmail(
      env,
      lead.email,
      `${lead.firstName ? `${lead.firstName}, ` : ''}a practical next step for ${businessName}`,
      `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#172033;line-height:1.65">
        <h2>Thanks for telling us what is getting in the way.</h2>
        <p>Hi ${escapeHtml(lead.firstName)},</p>
        <p>You told us that <b>${escapeHtml(valuePlan.pain)}</b>. That is where we will start.</p>
        <div style="padding:18px 20px;background:#f6f7f9;border-left:4px solid #ff6b1a;border-radius:8px">
          <b>One useful first step</b><br>${escapeHtml(valuePlan.firstValue)}
        </div>
        <p><b>Our initial recommendation:</b> ${escapeHtml(valuePlan.recommendation)}</p>
        <p>Reply to this email with your answer to one question: <i>${escapeHtml(valuePlan.nextQuestion)}</i></p>
        <p style="margin:24px 0"><a href="${bookingUrl}" style="display:inline-block;padding:12px 18px;background:#172033;color:#fff;text-decoration:none;border-radius:7px;font-weight:700">Book a short consultation</a></p>
        <p>We will use your answer to make the conversation specific to ${escapeHtml(businessName)}.</p>
        <p>— The WebCrew team<br><a href="tel:+19182555151">Or call the live WebCrew receptionist: (918) 255-5151</a></p>
        <p style="color:#6b7280;font-size:12px">You received this email because you submitted an enquiry at webcrew.app.</p>
      </div>`
    )
  }

  // 2. SMS the business owner — "you just got a lead on your demo site!"
  // This is the killer hook. They see proof of value before paying.
  if (lead.businessOwnerPhone) {
    await sendSms(
      env,
      lead.businessOwnerPhone,
      `📲 ${lead.businessName}: New inquiry from ${visitorName} (${contact}) via your demo site!\n\nReply INTERESTED to claim this site — ${env.CALENDLY_URL || 'webcrew.app'}`
    )
  }

  // 3. Email the business owner (if we have their email)
  if (lead.businessOwnerEmail) {
    await sendEmail(
      env,
      lead.businessOwnerEmail,
      `You just got a new customer inquiry — ${lead.businessName}`,
      `
      <h2>Someone contacted your business through your demo website!</h2>
      <p><b>${visitorName}</b> just submitted a contact request:</p>
      <ul>
        <li>Phone: ${lead.phone || '—'}</li>
        <li>Email: ${lead.email || '—'}</li>
        <li>Looking for: ${lead.service || lead.message || '—'}</li>
      </ul>
      <p>This is what your website can do for you — 24/7, on autopilot.</p>
      <p><a href="${env.CALENDLY_URL || 'https://webcrew.app'}">Book a 15-min call to activate your site →</a></p>
      <hr>
      <p style="color:#999;font-size:12px">This demo was built by Webcrew. You're not live yet — <a href="${env.CALENDLY_URL}">get live today</a>.</p>
      `
    )
  }

  // 4. Google Sheets log
  await appendToSheets(env, lead)

  // 5. Record TCPA SMS consent — form checkbox is the express written consent
  if (lead.phone && lead.smsConsent === true && lead.consentLanguage) {
    await recordSmsConsent(
      env, lead.phone, 'express_written', lead.source || 'webcrew.app/contact',
      lead.consentLanguage,
      req
    ).catch(() => {})
    await sendSms(
      env,
      lead.phone,
      `WebCrew: Thanks${lead.firstName ? `, ${lead.firstName}` : ''}. We reviewed your ${lead.painPoints || 'business'} concern. First step: ${valuePlan.firstValue.slice(0, 90)} Reply STOP to opt out; HELP for help.`
    ).catch(() => {})
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}

// ─── SMS reply handler (Twilio webhook) ──────────────────────────────────────

const OPT_OUT_WORDS = ['stop', 'unsubscribe', 'quit', 'cancel', 'opt out', 'remove me']
const YES_WORDS = ['yes', 'yeah', 'yep', 'interested', 'sounds good', "let's do it", 'i want']

function isOptOut(text: string): boolean {
  const t = text.toLowerCase()
  return OPT_OUT_WORDS.some(w => t.includes(w))
}

function isYes(text: string): boolean {
  const t = text.toLowerCase().trim()
  return YES_WORDS.some(w => t.includes(w))
}

// ─── GCP Service Account → Vertex AI token (crypto.subtle RSA, CF Workers compatible) ───

async function getVertexToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson)
  const now = Math.floor(Date.now() / 1000)
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const payload = btoa(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  const signingInput = `${header}.${payload}`
  const pemBody = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')
  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0))
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  )
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const jwt = `${signingInput}.${sigB64}`

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
  })
  const tokenData: any = await tokenRes.json()
  return tokenData.access_token
}

type ChatMessage = { role: 'user' | 'model'; text: string }

async function geminiSMSReply(
  env: Env,
  systemPrompt: string,
  history: ChatMessage[],
  incomingMsg: string
): Promise<string> {
  // Build Gemini multi-turn contents — full conversation memory
  // History = previous turns. Append current user message last.
  const instruction = systemPrompt + '\n\nIMPORTANT: Reply in max 160 characters. Return ONLY the SMS text — no quotes, no labels, no formatting.'

  const contents = [
    ...history.map(m => ({ role: m.role, parts: [{ text: m.text }] })),
    { role: 'user', parts: [{ text: incomingMsg }] },
  ]

  const body = JSON.stringify({
    system_instruction: { parts: [{ text: instruction }] },
    contents,
    generationConfig: { maxOutputTokens: 200, temperature: 0.7 },
  })

  // ── PRIMARY: Vertex AI on credits project ($300, webcrew-501006) ──────────
  const vertexSa = env.VERTEX_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_JSON
  const vertexProjects = [
    env.VERTEX_CREDITS_PROJECT_ID || 'webcrew-501006',
    env.VERTEX_PROJECT_ID || 'gen-lang-client-0362421597',
  ]
  if (vertexSa) {
    const token = await getVertexToken(vertexSa).catch((e) => {
      console.error(`[Gemini] Vertex token error: ${e?.message ?? e}`)
      return null
    })
    if (token) {
      for (const vertexProject of vertexProjects) {
        try {
          const res = await fetch(
            `https://us-central1-aiplatform.googleapis.com/v1/projects/${vertexProject}/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent`,
            { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body }
          )
          const json: any = await res.json()
          if (res.ok && json.candidates?.[0]) {
            return json.candidates[0].content.parts[0].text?.trim() ?? ''
          }
          console.error(`[Gemini] Vertex(${vertexProject}) HTTP ${res.status} | ${json.error?.message?.slice(0, 150) ?? ''}`)
        } catch (e: any) {
          console.error(`[Gemini] Vertex(${vertexProject}) error: ${e?.message ?? e}`)
        }
      }
    }
  }

  // ── FALLBACK: AI Studio free tier (20 req/day) ────────────────────────────
  if (env.GOOGLE_AI_API_KEY) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GOOGLE_AI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
    )
    const json: any = await res.json()
    if (!res.ok || !json.candidates?.[0]) {
      console.error(`[Gemini] AI Studio HTTP ${res.status} | ${json.error?.message?.slice(0, 150) ?? ''}`)
      return ''
    }
    return json.candidates[0].content.parts[0].text?.trim() ?? ''
  }

  return ''
}

// ─── Async: look up lead by phone, provision Gemini Live reception ────────────

async function triggerReceptionProvision(env: Env, phone: string): Promise<void> {
  const data = await neonQuery(env,
    `SELECT id, name, website FROM leads WHERE phone = $1 AND tier = 'tier2' AND website IS NOT NULL LIMIT 1`,
    [phone])
  const lead = data?.rows?.[0]
  if (!lead?.website) {
    console.log(`[Provision] No tier2 lead with website found for ${phone}`)
    return
  }

  console.log(`[Provision] Triggering reception for ${lead.name}: ${lead.website}`)
  await fetch(`${env.RECEPTION_SERVER_URL}/provision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.RECEPTION_PROVISION_SECRET ? { Authorization: `Bearer ${env.RECEPTION_PROVISION_SECRET}` } : {}),
    },
    body: JSON.stringify({ websiteUrl: lead.website, businessName: lead.name, leadId: lead.id }),
  })
}

// ─── SMS Sales Agent helpers ──────────────────────────────────────────────────

function buildSalesPrompt(p: {
  leadName: string; leadNiche: string; leadCity: string; leadTier: string
  convStage: string; demoUrl: string; lastMessage: string; lastReply: string
  offeredPrice: number; calendlyUrl: string; historyLen: number
}): string {
  const name  = p.leadName  || 'the business owner'
  const niche = p.leadNiche || 'local business'
  const city  = p.leadCity  || 'your city'
  const cal   = p.calendlyUrl || 'webcrew.app'
  const exchanges = Math.floor(p.historyLen / 2)  // completed back-and-forth turns

  const stageBehavior: Record<string, string> = {
    initial:    `STAGE 1 — THEY'RE REPLYING TO OUR OUTREACH. Our outreach said: "We built ${name !== 'the business owner' ? name : 'them'} a brand-new website. No upfront or setup fees — if you love it, you pay whatever feels fair. If not, no big deal. Sounds like a plan? Reply YES to see it." Their reply is a reaction to THAT. If positive/curious → warmly confirm: "Reply YES and I'll send it over — takes me about 10 minutes to finish it up." If skeptical → reassure: zero risk, no fees, they only pay if they love it. If they ask a question → answer it honestly and short. DO NOT mention the calendar. DO NOT name any price.`,
    interested: `STAGE 2 — BUILDING TRUST. They're engaged but haven't said YES yet. Answer their questions honestly. Reassure: it's already built for their business specifically, seeing it costs nothing, no obligations. Goal: get them to reply YES to see their site. DO NOT mention the calendar. DO NOT name any price.`,
    qualifying: `STAGE 3 — STILL WARMING UP. They're talking but not committed. Ask ONE light question about their business ("How do most of your customers find you right now?") then tie it back: "That's exactly what the site fixes. Want to see it? Just reply YES." DO NOT mention the calendar.`,
    presenting: `STAGE 4 — SOFT CLOSE TO YES. Frame it zero-risk: "It's already built. Seeing it is free. You pay only if you love it — whatever feels fair to you." Ask: "Want me to send it over? Reply YES." Still NO calendar link unless they ask to talk.`,
    building:   `Their custom ${niche} site is being built right now with their real business info, photos, and reviews — takes ~10 minutes. Keep them excited. Ask what matters most to them (photo gallery, booking, reviews) so we highlight it.`,
    demo_sent:  `STAGE 5 — DEMO REVIEW. We sent their site${p.demoUrl ? ': ' + p.demoUrl : ''}. Ask if they had a chance to look and what they think. If they LIKE it → say "It's yours if you want it. What price feels comfortable for you?" (let THEM name the number — never anchor). If they want changes → "Easy — we handle customizations on a quick free call." DO NOT push.`,
    price_asked:`STAGE 6a — PRICE TALK. NEVER anchor a number first. Ask: "What price feels comfortable for you?" Let THEM name it. Whatever they say, treat it with respect.`,
    negotiating:`STAGE 6b — CLOSING THE DEAL. ${p.offeredPrice > 0 ? `They offered $${p.offeredPrice} — ACCEPT IT warmly, whatever it is.` : 'Waiting for their number — ask what feels comfortable.'} Once agreed: "Deal! It's yours. Any customizations or updates you want? We handle all of that on a quick free call — plus I'll get you set up." Then share: ${cal}. Never lose a deal over price. Monthly hosting exists ($29/mo+) but only mention if THEY ask what's ongoing.`,
    booking:    `STAGE 7 — BOOKING. They agreed or want to talk. Share the calendar: ${cal} — "Pick any time — 10 min, no prep needed. We'll finalize everything and handle any customizations." Our specialist Ranjeet joins the call to get them fully set up.`,
    booked:     `STAGE 8 — CONFIRMED. Call is scheduled. Confirm warmly: "Perfect — see you then! We'll walk through your site, make any tweaks you want, and get it live under your name." Keep it short.`,
    support:    `SUPPORT MODE. Existing customer with a question, issue, or complaint. Empathize FIRST ("I'm so sorry — let me look into this right now"), solve or escalate to Ranjeet second. No selling.`,
  }

  const behavior = stageBehavior[p.convStage] ?? `Stage: ${p.convStage}. Move them one step forward. One question per message.`

  return `You are Sofia, WebCrew's AI Front Office Manager & Account Manager. You are a woman — warm, sharp, confident, never pushy. You combine a world-class receptionist, an empathetic support agent, and a high-converting appointment setter. You handle the FULL customer journey: greeting → diagnosis → qualification → value → booking → confirmation → support.

LEAD: ${name} | ${niche} business | ${city}
CONVERSATION STAGE: ${p.convStage} (${exchanges} exchanges so far)
${p.demoUrl ? `DEMO SITE: ${p.demoUrl}` : 'NO DEMO BUILT YET'}

YOUR OBJECTIVE RIGHT NOW (follow this exactly — do not skip ahead):
${behavior}

THE LIFECYCLE (never skip stages):
1. REPLY TO OUTREACH — they respond to "we built you a website, pay what feels fair — sounds like a plan?"
2. TRUST — answer questions, zero-risk framing, get YES
3. BUILD — site built with their real photos/reviews, ~10 min
4. DEMO — they see it, react, own it emotionally
5. PRICE — THEY name the number; accept it warmly
6. CUSTOMIZE + BOOK — "changes handled on a quick free call" → calendar
7. CONFIRM — Ranjeet closes on the call

⛔ CALENDAR RULE (strict): NEVER share ${cal} unless (a) price agreed / deal confirmed, OR (b) they explicitly ask to talk/call/book. Sharing the calendar before they've seen their site is a FAILURE.
⛔ PRICING RULE (strict): NEVER state a price first. When it's time: "What price feels comfortable for you?" ACCEPT whatever they name — the deal matters more than the amount. Ranjeet upsells on the call.
⛔ LOCATION RULE: ${p.leadCity ? `Their city is ${p.leadCity}.` : `You DON'T know their city — say "your city" or "your area", NEVER guess or invent a city name.`}

WEBCREW PRODUCTS (context only — do not list these unprompted):
• Custom website built with their real business info — pay only if you love it, whatever feels fair
• Monthly hosting from $29/mo (mention ONLY if they ask about ongoing costs)
• $49/mo + AI answers ALL calls 24/7
• $79/mo + review replies + weekly SEO report
• $69/mo founding rate + AI Reception + appointment booking + SMS automation (all-inclusive)

OBJECTION HANDLING:
• "Not interested" → "Totally understand! Out of curiosity, what would need to change for it to make sense?"
• "I already have someone" → "That's great! I'd love to show you what's different — no pressure. What are they doing for you now?"
• "Send me info / email" → "Happy to! What matters most — more calls, reviews, or Google rankings? I'll tailor it."
• "Need to think" → "Makes sense. What's your main question? I'll answer it right now."
• "Too busy" → "Totally get it — this takes 2 min by text. What's the one thing you'd fix about how customers find you?"
• "Who is this?" → "This is Sofia from WebCrew! We build websites for local businesses. Reply STOP anytime to opt out."
• "How did you get my number?" → "Found it in public business directories — sorry for the cold text! Reply STOP anytime to opt out."
• Angry → acknowledge their exact concern first, then fix. Never defensive.
• Complex technical question → "Great question — our lead specialist will cover that on your setup call so you get the exact right answer."

TONE & FORMAT — non-negotiable:
• Human phrasing: "Got it," "Perfect," "I can definitely help with that" — never "Certainly, I can assist"
• Max 160 chars strongly preferred (1 SMS segment). Hard cap 300.
• Exactly ONE question or ONE call-to-action per message — never two asks
• No emojis unless they send one first
• Never repeat anything from your previous messages (you have the full history above)
• Never make up pricing, features, or timelines
• If you sign, ALWAYS put the signature on its own line, separated by a blank line:

— Sofia, WebCrew

• Sign ONLY your very first message; never sign again after that`
}

// Strip trailing "business/businesses" so "local business businesses" never happens
// business(es)? matches "business" OR "businesses"
function nicheLabel(niche: string): string {
  return (niche || 'local business').replace(/\s*business(es)?\s*$/i, '').trim() || 'local'
}

function buildFallback(
  msgBody: string, leadNiche: string, leadCity: string,
  convStage: string, historyLen: number, calendlyUrl?: string
): string {
  const cal   = calendlyUrl || 'webcrew.app'
  const niche = nicheLabel(leadNiche)

  if (/price|cost|how much|charge|fee|what.*(it|this) cost/i.test(msgBody))
    return `Whatever feels fair to you — seriously. You see the site first, then you decide. What price would feel comfortable?`
  if (/\b(book|schedule|call me|appointment|let'?s talk|set up a (call|time))\b/i.test(msgBody))
    return `Happy to chat! Here's my calendar: ${cal}\n\nPick any time — 10 min, no prep needed.`
  if (/complaint|issue|problem|not working|broken|fix|wrong/i.test(msgBody))
    return `I'm so sorry to hear that — let me fix this right away. What's going on?`
  if (/demo|site|website|link|see it/i.test(msgBody) && convStage === 'demo_sent')
    return `Did you get a chance to look at it yet?`

  // First contact (no history) — they're replying to our outreach
  if (historyLen === 0)
    return `Hi! Sofia here from WebCrew. We built your ${niche} business a new website — no upfront fees, pay what feels fair only if you love it. Reply YES to see it, or STOP to opt out.\n\n— Sofia, WebCrew`

  // They've replied before but Gemini failed — keep moving toward YES
  return `Totally fair question! The site's already built for your business — seeing it costs nothing. Reply YES and I'll send it over.`
}

function upgradeStage(msgBody: string, reply: string, currentStage: string, historyLen: number): string {
  const order = ['initial','interested','qualifying','presenting','building','demo_sent','price_asked','negotiating','booking','booked','support','closed']
  let next = currentStage
  const exchanges = Math.floor(historyLen / 2)

  // Gradual lifecycle progression — one stage per meaningful exchange
  if (currentStage === 'initial'    && msgBody.trim().length > 1) next = 'interested'   // they replied → diagnose
  if (currentStage === 'interested' && exchanges >= 2)            next = 'qualifying'   // pain shared → qualify
  if (currentStage === 'qualifying' && exchanges >= 3)            next = 'presenting'   // qualified → pitch value

  // Keyword jumps (override gradual flow)
  if (/price|cost|how much|charge|pay|fee/i.test(msgBody) && !['negotiating','booked','closed'].includes(currentStage)) next = 'price_asked'
  if (['price_asked','negotiating'].includes(currentStage) && /\$\s*\d+|\d+\s*(dollar|buck|month|\/mo)/i.test(msgBody)) next = 'negotiating'

  // Booking ONLY on explicit user intent — never because our reply mentioned it
  if (/\b(book|schedule|call me|appointment|let'?s talk|set up a (call|time)|when can (we|you))\b/i.test(msgBody)
      && !['booked','closed'].includes(currentStage)) next = 'booking'
  if (currentStage === 'booking' && /confirm|booked|scheduled|see you|talk soon/i.test(reply)) next = 'booked'

  const ci = order.indexOf(currentStage)
  const ni = order.indexOf(next)
  return ni > ci ? next : currentStage
}

// ─── SMS webhook handler ──────────────────────────────────────────────────────

async function handleSMSWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw     = await req.text()
  const params  = new URLSearchParams(raw)

  if (!await validateTwilioSignature(env, req, params)) {
    return new Response('Forbidden', { status: 403 })
  }

  const from    = params.get('From') ?? ''
  const msgBody = (params.get('Body') ?? '').trim()

  const twiml = (msg: string) => new Response(
    `<?xml version="1.0"?><Response><Message>${msg.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</Message></Response>`,
    { headers: { 'Content-Type': 'text/xml' } }
  )
  const emptyTwiml = () => new Response('<?xml version="1.0"?><Response/>', { headers: { 'Content-Type': 'text/xml' } })

  if (!from || !msgBody) return emptyTwiml()

  ctx.waitUntil(logSmsEvent(env, from, 'sms_replied', { body: msgBody }).catch(() => {}))

  // ── 1. STOP / opt-out (TCPA — hardcoded, never AI) ──────────────────────
  // TCPA requires: immediate stop, confirmation message, no further messages
  if (isOptOut(msgBody)) {
    ctx.waitUntil((async () => {
      await neonQuery(env, `UPDATE leads SET sms_opt_out=TRUE, updated_at=NOW() WHERE phone=$1 OR international_phone=$1`, [from]).catch(() => {})
      await neonQuery(env, `UPDATE consent_events SET revoked_at=NOW() WHERE channel='sms' AND contact=$1 AND revoked_at IS NULL`, [from]).catch(() => {})
      await neonQuery(env, `INSERT INTO sms_conversations (phone,stage,last_message) VALUES ($1,'closed',$2) ON CONFLICT(phone) DO UPDATE SET stage='closed', last_message=$2, updated_at=NOW()`, [from, msgBody]).catch(() => {})
    })())
    // TCPA-exact: must confirm unsubscribe, must say "no more messages"
    return twiml("WEBCREW: You have been unsubscribed and will receive no further messages from this number. Contact hello@webcrew.app if you need anything.")
  }

  // ── 1b. HELP keyword (10DLC / CTIA requirement — hardcoded, never AI) ────
  if (/^help\s*$/i.test(msgBody.trim())) {
    return twiml("WEBCREW: Sofia here from WebCrew — we build websites for local businesses. For support: hello@webcrew.app or webcrew.app. Reply STOP to opt out. Msg&Data rates may apply.")
  }

  // A caller may reply with an email while still speaking to the live
  // receptionist. Capture this before the normal SMS sales conversation.
  if (env.NEON_DATABASE_URL && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(msgBody)) {
    const pending = await neonQuery(env,
      `UPDATE reception_email_verifications
       SET email=$2, status='verified', verified_at=NOW()
       WHERE id=(SELECT id FROM reception_email_verifications
                 WHERE phone=$1 AND status='pending' AND expires_at>NOW()
                 ORDER BY created_at DESC LIMIT 1)
       RETURNING id`,
      [from, msgBody.toLowerCase()]
    ).catch(() => null)
    if (pending?.rows?.[0]) {
      return twiml('Thanks — your email was verified. Please stay on the call while the receptionist confirms it.')
    }
  }

  // ── 1c. Inbound reply = consent to continue the conversation (TCPA) ──────
  // Unlocks outbound SMS for this number in the pipeline's consent gate.
  ctx.waitUntil(recordSmsConsent(env, from, 'inbound_reply', 'sms_inbound', msgBody, req).catch(() => {}))

  // ── 2. Owner appointment confirmation (existing clients) ─────────────────
  if (env.NEON_DATABASE_URL) {
    const ownerRows = await neonQuery(env,
      `SELECT id, attendee_name, attendee_phone, business_name, review_link
       FROM cal_bookings WHERE business_owner_phone=$1
       AND host_confirmed IS NULL AND host_confirm_sent_at IS NOT NULL
       AND end_time > NOW() - INTERVAL '24 hours'
       ORDER BY end_time DESC LIMIT 1`,
      [from]
    )
    const ob = ownerRows?.rows?.[0]
    if (ob) {
      const ownerYes = /^(yes|y|yeah|yep|showed|attended|came)/i.test(msgBody.trim())
      const ownerNo  = /^(no|n|nope|didn'?t|no.?show|miss)/i.test(msgBody.trim())
      if (ownerYes || ownerNo) {
        ctx.waitUntil((async () => {
          if (ownerYes) {
            await neonQuery(env, `UPDATE cal_bookings SET host_confirmed=TRUE, host_confirmed_at=NOW() WHERE id=$1`, [ob.id]).catch(() => {})
            if (ob.attendee_phone) {
              const first = (ob.attendee_name || 'there').split(' ')[0]
              await sendSms(env, ob.attendee_phone, `Hi ${first}! Thanks for visiting ${ob.business_name}. Mind leaving a quick review? ${ob.review_link || 'https://webcrew.app/review'}`)
              await neonQuery(env, `UPDATE cal_bookings SET review_request_sent_at=NOW() WHERE id=$1`, [ob.id]).catch(() => {})
            }
          } else {
            await neonQuery(env, `UPDATE cal_bookings SET host_confirmed=FALSE, host_confirmed_at=NOW(), status='no_show' WHERE id=$1`, [ob.id]).catch(() => {})
            if (ob.attendee_phone) {
              const first = (ob.attendee_name || 'there').split(' ')[0]
              await sendSms(env, ob.attendee_phone, `Hi ${first}! Looks like you missed your appointment at ${ob.business_name}. Easy to rebook: ${env.CALENDLY_URL || 'webcrew.app'}`)
            }
          }
        })())
        return twiml(ownerYes
          ? `Got it! We'll send ${(ob.attendee_name || 'them').split(' ')[0]} a review request now. Thanks!`
          : `Got it — we'll reach out to help them reschedule. Thanks for letting us know!`)
      }
    }
  }

  // ── 3. Load full conversation context + history ───────────────────────────
  const [convRows, leadRows] = await Promise.all([
    neonQuery(env, `SELECT stage, demo_url, offered_price, last_message, last_reply, messages FROM sms_conversations WHERE phone=$1`, [from]),
    neonQuery(env, `SELECT name, niche, city, tier, cloudflare_url, vercel_url FROM leads WHERE phone=$1 ORDER BY created_at DESC LIMIT 1`, [from]),
  ])

  const conv = convRows?.rows?.[0] ?? convRows?.[0]
  const lead = leadRows?.rows?.[0] ?? leadRows?.[0]

  const convStage    = (conv?.stage        ?? 'initial') as string
  const demoUrl      = (conv?.demo_url     ?? lead?.cloudflare_url ?? lead?.vercel_url ?? '') as string
  const offeredPrice = (conv?.offered_price ?? 0) as number
  const lastMessage  = (conv?.last_message  ?? '') as string
  const lastReply    = (conv?.last_reply    ?? '') as string
  const leadName     = (lead?.name  ?? '') as string
  const leadNiche    = (lead?.niche ?? 'local business') as string
  const leadCity     = (lead?.city  ?? '') as string   // empty = unknown → Sofia says "your city", never guesses
  const leadTier     = (lead?.tier  ?? 'tier1') as string
  const cal          = env.CALENDLY_URL || 'webcrew.app'

  // Full chat history — last 20 turns (40 messages) to stay within context
  let history: ChatMessage[] = []
  try {
    const raw = typeof conv?.messages === 'string' ? JSON.parse(conv.messages) : (conv?.messages ?? [])
    history = Array.isArray(raw) ? raw.slice(-40) : []
  } catch {}

  // ── 4. YES → trigger build pipeline (hardcoded — always reliable) ────────
  const skipBuildStages = ['building', 'demo_sent', 'booked', 'closed', 'support']
  if (isYes(msgBody) && !skipBuildStages.includes(convStage)) {
    const confirmMsg = leadName
      ? `On it! I'm building a custom ${leadNiche} site for ${leadName} in ${leadCity} now. Ready in ~10 min — I'll text you the link! - Sofia`
      : `On it! Building your custom site now — should be ready in ~10 min. I'll text you the link! - Sofia`
    const updatedHistory: ChatMessage[] = [
      ...history,
      { role: 'user' as const, text: msgBody },
      { role: 'model' as const, text: confirmMsg },
    ].slice(-40)
    ctx.waitUntil((async () => {
      await neonQuery(env, `INSERT INTO build_requests (phone,name,niche,city,status) VALUES ($1,$2,$3,$4,'pending') ON CONFLICT DO NOTHING`, [from, leadName, leadNiche, leadCity]).catch(() => {})
      await neonQuery(env, `
        INSERT INTO sms_conversations (phone, stage, last_message, last_reply, messages)
        VALUES ($1, 'building', $2, $3, $4::jsonb)
        ON CONFLICT(phone) DO UPDATE SET
          stage='building', last_message=$2, last_reply=$3,
          messages=$4::jsonb, updated_at=NOW()
      `, [from, msgBody, confirmMsg, JSON.stringify(updatedHistory)]).catch(() => {})
      await neonQuery(env, `UPDATE leads SET status='conversation_active', updated_at=NOW() WHERE phone=$1`, [from]).catch(() => {})
      await notifyHITL(env, from, leadName, leadNiche, leadCity, '').catch(() => {})
    })())
    return twiml(confirmMsg)
  }

  // ── 5. Everything else → Gemini (Sofia SDR persona, synchronous, full memory) ──
  const systemPrompt = buildSalesPrompt({
    leadName, leadNiche, leadCity, leadTier,
    convStage, demoUrl, lastMessage, lastReply, offeredPrice, calendlyUrl: cal,
    historyLen: history.length,
  })
  const fallback = buildFallback(msgBody, leadNiche, leadCity, convStage, history.length, cal)

  let reply = fallback
  try {
    const aiReply = await geminiSMSReply(env, systemPrompt, history, msgBody)
    if (aiReply && aiReply.length > 5) {
      reply = aiReply
    } else {
      console.warn(`[Sofia] Gemini returned empty for ${from} | stage=${convStage} | msg="${msgBody.slice(0,40)}"`)
    }
  } catch (e: any) {
    console.error(`[Sofia] Gemini error for ${from}: ${e?.message ?? e}`)
  }

  // Append this turn to history, cap at 40 messages (~20 back-and-forth turns)
  const updatedHistory: ChatMessage[] = [
    ...history,
    { role: 'user' as const,  text: msgBody },
    { role: 'model' as const, text: reply   },
  ].slice(-40)

  const newStage = upgradeStage(msgBody, reply, convStage, history.length)

  // HITL: deal reached booking stage → email Ranjeet to jump in and close live
  if (newStage === 'booking' && convStage !== 'booking') {
    ctx.waitUntil(sendEmail(env, env.NOTIFICATION_EMAIL,
      `📞 HOT — booking stage: ${leadName || from} (${leadNiche})`,
      `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px">
        <h2 style="color:#16a34a">📞 Lead ready to book — jump in now</h2>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:6px 0;color:#666;width:90px"><b>Business</b></td><td>${leadName || '—'}</td></tr>
          <tr><td style="padding:6px 0;color:#666"><b>Niche</b></td><td>${leadNiche}</td></tr>
          <tr><td style="padding:6px 0;color:#666"><b>City</b></td><td>${leadCity || '—'}</td></tr>
          <tr><td style="padding:6px 0;color:#666"><b>Phone</b></td><td>${from}</td></tr>
          <tr><td style="padding:6px 0;color:#666"><b>Agreed $</b></td><td>${offeredPrice > 0 ? '$' + offeredPrice : '—'}</td></tr>
          <tr><td style="padding:6px 0;color:#666"><b>Demo</b></td><td>${demoUrl ? `<a href="https://${demoUrl.replace(/^https?:\/\//,'')}">${demoUrl}</a>` : '—'}</td></tr>
          <tr><td style="padding:6px 0;color:#666"><b>They said</b></td><td>"${msgBody.slice(0,120)}"</td></tr>
        </table>
        <p>Sofia sent them the calendar. Watch for the booking + close the deal on the call.</p>
      </div>`).catch(() => {}))
  }

  ctx.waitUntil(
    neonQuery(env, `
      INSERT INTO sms_conversations (phone, stage, demo_url, offered_price, last_message, last_reply, messages)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT(phone) DO UPDATE SET
        stage         = $2,
        demo_url      = COALESCE(NULLIF($3,''), sms_conversations.demo_url),
        offered_price = CASE WHEN $4 > 0 THEN $4 ELSE sms_conversations.offered_price END,
        last_message  = $5,
        last_reply    = $6,
        messages      = $7::jsonb,
        updated_at    = NOW()
    `, [from, newStage, demoUrl, offeredPrice, msgBody, reply, JSON.stringify(updatedHistory)]).catch(() => {})
  )

  return twiml(reply)
}

// ─── POST /audit handler ──────────────────────────────────────────────────

async function handleAuditRequest(req: Request, env: Env): Promise<Response> {
  const { name, email, phone, websiteUrl, source } = await req.json() as {
    name: string; email: string; phone?: string; websiteUrl: string; source?: string
  }

  if (!email || !websiteUrl) {
    return new Response(JSON.stringify({ error: 'email and websiteUrl required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }

  // 1. Notify us immediately
  await sendEmail(
    env,
    env.NOTIFICATION_EMAIL || 'pavan.harati@gmail.com',
    `🔍 Free Audit Request: ${name} — ${websiteUrl}`,
    `<p><b>${name}</b> requested a free audit for <a href="${websiteUrl}">${websiteUrl}</a></p>
     <p>Email: ${email}</p><p>Phone: ${phone || '—'}</p><p>Source: ${source || 'webcrew.app'}</p>`
  )

  // Record TCPA SMS consent — audit form requires phone + SMS opt-in checkbox
  if (phone) {
    await recordSmsConsent(
      env, phone, 'express_written', source || 'webcrew.app/audit',
      'Audit form SMS opt-in: agreed to receive follow-up texts from WebCrew about the website audit. Consent is not a condition of purchase.',
      req
    ).catch(() => {})
  }

  // 2. Run audit async (don't block response — use waitUntil pattern via background promise)
  runAuditAndEmail(env, { name, email, phone, websiteUrl }).catch(e =>
    console.error('[Audit] Failed:', e.message)
  )

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}

async function runAuditAndEmail(env: Env, opts: {
  name: string; email: string; phone?: string; websiteUrl: string
}): Promise<void> {
  const { name, email, websiteUrl } = opts

  // 1. PageSpeed (mobile) — free, no key needed for basic quota
  let speedScore = 0; let lcp = '—'; let cls = '—'; let fid = '—'
  try {
    const psUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(websiteUrl)}&strategy=mobile`
    const ps = await fetch(psUrl)
    if (ps.ok) {
      const psData: any = await ps.json()
      speedScore = Math.round((psData.lighthouseResult?.categories?.performance?.score ?? 0) * 100)
      lcp = psData.lighthouseResult?.audits?.['largest-contentful-paint']?.displayValue ?? '—'
      cls = psData.lighthouseResult?.audits?.['cumulative-layout-shift']?.displayValue ?? '—'
      fid = psData.lighthouseResult?.audits?.['total-blocking-time']?.displayValue ?? '—'
    }
  } catch { /* non-blocking */ }

  // 2. Fetch homepage HTML for basic SEO checks
  let hasTitle = false; let hasMeta = false; let hasH1 = false
  let hasSchema = false; let isHttps = websiteUrl.startsWith('https')
  let htmlSnippet = ''
  try {
    const pageRes = await fetch(websiteUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WebCrewBot/1.0)' } })
    const html = await pageRes.text()
    htmlSnippet = html.slice(0, 6000)
    hasTitle  = /<title[^>]*>[^<]+<\/title>/i.test(html)
    hasMeta   = /meta[^>]+name=["']description["'][^>]+content=["'][^"']{10,}/i.test(html)
    hasH1     = /<h1[^>]*>[^<]+<\/h1>/i.test(html)
    hasSchema = html.includes('application/ld+json')
  } catch { /* non-blocking */ }

  // 3. Gemini audit summary
  let auditSummary = ''; let grade = 'C'; let topFixes: string[] = []
  if (env.GOOGLE_AI_API_KEY) {
    try {
      const prompt = `You are a professional website auditor. Analyze this website: ${websiteUrl}

PageSpeed mobile score: ${speedScore}/100
LCP: ${lcp} | CLS: ${cls} | TBT: ${fid}
Has title tag: ${hasTitle} | Has meta description: ${hasMeta} | Has H1: ${hasH1}
Has schema markup: ${hasSchema} | HTTPS: ${isHttps}

Homepage HTML snippet:
${htmlSnippet}

Write a concise audit report in JSON format:
{
  "grade": "A/B/C/D/F",
  "overall_score": 0-100,
  "headline": "one punchy sentence about the site",
  "summary": "2-3 sentences on the biggest issues",
  "top_3_fixes": ["fix 1", "fix 2", "fix 3"],
  "wins": ["what they do well 1", "what they do well 2"]
}

Be honest and specific. If score < 50, be direct about the problems.`

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GOOGLE_AI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
      )
      const json: any = await res.json()
      const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
      const match = raw.match(/\{[\s\S]*\}/)
      if (match) {
        const parsed = JSON.parse(match[0])
        grade = parsed.grade ?? 'C'
        auditSummary = parsed.summary ?? ''
        topFixes = parsed.top_3_fixes ?? []
      }
    } catch { /* non-blocking */ }
  }

  const gradeColor = grade === 'A' ? '#16a34a' : grade === 'B' ? '#2563eb' : grade === 'C' ? '#d97706' : '#dc2626'
  const scoreColor = speedScore >= 80 ? '#16a34a' : speedScore >= 50 ? '#d97706' : '#dc2626'

  // 4. Send HTML email with audit results
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px">

    <!-- Header -->
    <div style="background:#111827;border-radius:16px;padding:32px;margin-bottom:24px;text-align:center">
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:800;font-size:1.4rem;color:#B5880E;margin-bottom:8px">WebCrew</div>
      <h1 style="color:#fff;font-size:1.6rem;font-weight:800;margin:0 0 8px;letter-spacing:-0.02em">Your FREE Website Audit</h1>
      <p style="color:rgba(255,255,255,0.6);margin:0;font-size:0.9rem">${websiteUrl}</p>
    </div>

    <!-- Grade card -->
    <div style="background:#fff;border-radius:16px;padding:28px;margin-bottom:20px;border:1px solid rgba(0,0,0,0.08);box-shadow:0 2px 20px rgba(0,0,0,0.06)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div>
          <div style="font-size:0.7rem;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#6b7280;margin-bottom:4px">OVERALL GRADE</div>
          <div style="font-size:3.5rem;font-weight:800;color:${gradeColor};line-height:1">${grade}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:0.7rem;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#6b7280;margin-bottom:4px">PAGESPEED (MOBILE)</div>
          <div style="font-size:3rem;font-weight:800;color:${scoreColor};line-height:1">${speedScore}<span style="font-size:1rem;color:#6b7280">/100</span></div>
        </div>
      </div>
      ${auditSummary ? `<p style="color:#374151;font-size:0.95rem;line-height:1.7;margin:0;padding:16px;background:#f9fafb;border-radius:8px;border-left:3px solid ${gradeColor}">${auditSummary}</p>` : ''}
    </div>

    <!-- Core vitals -->
    <div style="background:#fff;border-radius:16px;padding:24px;margin-bottom:20px;border:1px solid rgba(0,0,0,0.08)">
      <div style="font-size:0.75rem;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#6b7280;margin-bottom:16px">Core Web Vitals</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        ${[
          { label: 'LCP', val: lcp, tip: 'Largest Contentful Paint' },
          { label: 'CLS', val: cls, tip: 'Cumulative Layout Shift' },
          { label: 'TBT', val: fid, tip: 'Total Blocking Time' },
        ].map(v => `
          <div style="background:#f9fafb;border-radius:8px;padding:12px;text-align:center">
            <div style="font-size:0.6rem;color:#9ca3af;margin-bottom:4px">${v.tip}</div>
            <div style="font-size:1rem;font-weight:700;color:#111827">${v.val}</div>
            <div style="font-size:0.65rem;color:#6b7280;font-weight:700">${v.label}</div>
          </div>`).join('')}
      </div>
    </div>

    <!-- SEO checks -->
    <div style="background:#fff;border-radius:16px;padding:24px;margin-bottom:20px;border:1px solid rgba(0,0,0,0.08)">
      <div style="font-size:0.75rem;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#6b7280;margin-bottom:16px">SEO Checklist</div>
      ${[
        { label: 'Title Tag', ok: hasTitle },
        { label: 'Meta Description', ok: hasMeta },
        { label: 'H1 Heading', ok: hasH1 },
        { label: 'Schema Markup', ok: hasSchema },
        { label: 'HTTPS Secure', ok: isHttps },
      ].map(c => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f3f4f6">
          <div style="width:20px;height:20px;border-radius:50%;background:${c.ok ? '#dcfce7' : '#fee2e2'};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:11px">
            ${c.ok ? '✓' : '✗'}
          </div>
          <div style="font-size:0.88rem;color:${c.ok ? '#16a34a' : '#dc2626'};font-weight:${c.ok ? '500' : '600'}">${c.label} — ${c.ok ? 'Good' : 'Missing'}</div>
        </div>`).join('')}
    </div>

    ${topFixes.length ? `
    <!-- Top 3 fixes -->
    <div style="background:#fff;border-radius:16px;padding:24px;margin-bottom:20px;border:1px solid rgba(0,0,0,0.08)">
      <div style="font-size:0.75rem;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#6b7280;margin-bottom:16px">Top 3 Quick Wins</div>
      ${topFixes.map((fix, i) => `
        <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid #f3f4f6">
          <div style="width:24px;height:24px;border-radius:6px;background:#B5880E;color:#fff;font-weight:700;font-size:0.75rem;display:flex;align-items:center;justify-content:center;flex-shrink:0">${i+1}</div>
          <div style="font-size:0.88rem;color:#374151;line-height:1.5">${fix}</div>
        </div>`).join('')}
    </div>` : ''}

    <!-- CTA -->
    <div style="background:linear-gradient(135deg,#111827,#1f2937);border-radius:16px;padding:32px;text-align:center">
      <h2 style="color:#fff;font-size:1.3rem;font-weight:800;margin:0 0 12px;letter-spacing:-0.02em">Want us to fix all of this — FREE?</h2>
      <p style="color:rgba(255,255,255,0.7);font-size:0.9rem;margin:0 0 24px;line-height:1.6">We'll build you a completely new, high-performance website. You only pay if you love it.</p>
      <a href="https://webcrew.app/#contact" style="display:inline-block;background:#B5880E;color:#fff;font-weight:700;padding:14px 32px;border-radius:100px;text-decoration:none;font-size:0.95rem">
        Get My FREE Demo Site →
      </a>
    </div>

    <p style="text-align:center;color:#9ca3af;font-size:0.75rem;margin-top:24px">
      WebCrew · <a href="https://webcrew.app/privacy" style="color:#9ca3af">Privacy Policy</a> · <a href="https://webcrew.app/terms" style="color:#9ca3af">Terms</a>
    </p>
  </div>
</body>
</html>`

  await sendEmail(env, email, `Your FREE Website Audit — ${websiteUrl.replace(/https?:\/\//, '')}`, html)
  console.log(`[Audit] Report sent to ${email} for ${websiteUrl}`)
}

// ─── Survey handler ───────────────────────────────────────────────────────

async function appendSurveyToSheets(env: Env, row: string[]): Promise<void> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.LEADS_SHEET_ID) return
  try {
    const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON)
    // JWT auth for Sheets (same pattern as retention agent)
    const now = Math.floor(Date.now() / 1000)
    const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload = btoa(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }))
    // Note: full JWT signing not available in CF Workers without crypto.subtle RSA
    // Sheets write handled by pipeline retention agent; here we log only
    console.log(`[Survey] Sheets write queued: ${row.join(' | ')}`)
  } catch { /* non-blocking */ }
}

async function writeSurveyToNeon(env: Env, data: Record<string, string>): Promise<void> {
  await neonQuery(env,
    `INSERT INTO survey_responses (name, biz, phone, niche, pain, has_website, ai_want, budget)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      data.name || null, data.biz || null, data.phone || null,
      data.niche || null,
      Array.isArray(data.pain) ? (data.pain as unknown as string[]).join(', ') : (data.pain || null),
      data.has_website || null, data.ai_want || null, data.budget || null,
    ])
}

async function handleSurveySubmission(req: Request, env: Env): Promise<Response> {
  const data = await req.json() as Record<string, string>
  const { name, biz, phone, niche, pain, has_website, ai_want, budget } = data
  const painStr = Array.isArray(pain) ? (pain as unknown as string[]).join(', ') : (pain || '—')
  const dateStr = new Date().toISOString().split('T')[0]

  // 1. Email notification (instant)
  await sendEmail(
    env,
    env.NOTIFICATION_EMAIL || 'pavan.harati@gmail.com',
    `📋 Survey: ${name || '?'} — ${biz || 'Unknown'}`,
    `<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse;">
      <tr><td style="padding:6px 12px;color:#666"><b>Date</b></td><td style="padding:6px 12px">${dateStr}</td></tr>
      <tr><td style="padding:6px 12px;color:#666"><b>Name</b></td><td style="padding:6px 12px">${name || '—'}</td></tr>
      <tr><td style="padding:6px 12px;color:#666"><b>Business</b></td><td style="padding:6px 12px">${biz || '—'}</td></tr>
      <tr><td style="padding:6px 12px;color:#666"><b>Phone</b></td><td style="padding:6px 12px">${phone || '—'}</td></tr>
      <tr><td style="padding:6px 12px;color:#666"><b>Niche</b></td><td style="padding:6px 12px">${niche || '—'}</td></tr>
      <tr><td style="padding:6px 12px;color:#666"><b>Pain point</b></td><td style="padding:6px 12px">${painStr}</td></tr>
      <tr><td style="padding:6px 12px;color:#666"><b>Has website</b></td><td style="padding:6px 12px">${has_website || '—'}</td></tr>
      <tr><td style="padding:6px 12px;color:#666"><b>AI want</b></td><td style="padding:6px 12px">${ai_want || '—'}</td></tr>
      <tr><td style="padding:6px 12px;color:#666"><b>Budget</b></td><td style="padding:6px 12px">${budget || '—'}</td></tr>
    </table>`
  )

  // 2. Neon DB (persistent, queryable)
  await writeSurveyToNeon(env, data)

  // 3. Google Sheets (async log)
  appendSurveyToSheets(env, [dateStr, name||'', biz||'', phone||'', niche||'', painStr, has_website||'', ai_want||'', budget||'']).catch(() => {})

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}

// ─── HITL: approval page + send demo ─────────────────────────────────────

function hitlToken(secret: string, phone: string): string {
  // Simple token: first 16 chars of base64(secret+phone) — good enough for internal tool
  return btoa(`${secret}:${phone}`).slice(0, 24).replace(/[+/=]/g, 'x')
}

function handleHITLPage(url: URL, env: Env): Response {
  const phone   = url.searchParams.get('phone') ?? ''
  const name    = url.searchParams.get('name') ?? 'Business'
  const niche   = url.searchParams.get('niche') ?? ''
  const city    = url.searchParams.get('city') ?? ''
  const email   = url.searchParams.get('email') ?? ''
  const token   = url.searchParams.get('token') ?? ''
  const secret  = env.HITL_SECRET ?? 'webcrew-hitl-2024'

  if (!phone || token !== hitlToken(secret, phone)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const sendUrl = `/hitl/send?phone=${encodeURIComponent(phone)}&name=${encodeURIComponent(name)}&niche=${encodeURIComponent(niche)}&city=${encodeURIComponent(city)}&email=${encodeURIComponent(email)}&token=${token}`

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WebCrew HITL — Send Demo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px; padding: 32px; max-width: 480px; width: 100%; }
    h1 { font-size: 1.4rem; font-weight: 800; margin-bottom: 4px; }
    .sub { color: #888; font-size: 0.85rem; margin-bottom: 24px; }
    .lead-box { background: #111; border: 1px solid #2a2a2a; border-radius: 10px; padding: 16px; margin-bottom: 24px; }
    .lead-row { display: flex; gap: 8px; margin-bottom: 6px; font-size: 0.88rem; }
    .lead-label { color: #666; min-width: 60px; }
    label { display: block; font-size: 0.8rem; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
    input { width: 100%; background: #111; border: 1px solid #333; border-radius: 8px; padding: 12px 14px; color: #fff; font-size: 0.95rem; outline: none; margin-bottom: 20px; }
    input:focus { border-color: #7c3aed; }
    button { width: 100%; background: #7c3aed; color: #fff; font-weight: 700; font-size: 1rem; padding: 14px; border: none; border-radius: 10px; cursor: pointer; }
    button:hover { background: #6d28d9; }
    .warn { color: #f59e0b; font-size: 0.8rem; margin-top: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🚀 Send Demo to Lead</h1>
    <p class="sub">Paste the Cloudflare Pages URL below and hit send.</p>

    <div class="lead-box">
      <div class="lead-row"><span class="lead-label">Name</span><span>${name}</span></div>
      <div class="lead-row"><span class="lead-label">Niche</span><span>${niche}</span></div>
      <div class="lead-row"><span class="lead-label">City</span><span>${city}</span></div>
      <div class="lead-row"><span class="lead-label">Phone</span><span>${phone}</span></div>
      ${email ? `<div class="lead-row"><span class="lead-label">Email</span><span>${email}</span></div>` : ''}
    </div>

    <form method="POST" action="${sendUrl}">
      <label>Demo URL (Cloudflare Pages)</label>
      <input type="url" name="demoUrl" placeholder="https://their-business.pages.dev" required autofocus>
      <button type="submit">✅ Approve &amp; Send Demo</button>
    </form>
    <p class="warn">⚠ This sends an SMS${email ? ' + email' : ''} to the lead immediately.</p>
  </div>
</body>
</html>`

  return new Response(html, { headers: { 'Content-Type': 'text/html' } })
}

async function handleHITLSend(req: Request, url: URL, env: Env): Promise<Response> {
  const phone  = url.searchParams.get('phone') ?? ''
  const name   = url.searchParams.get('name') ?? 'there'
  const niche  = url.searchParams.get('niche') ?? 'local business'
  const city   = url.searchParams.get('city') ?? 'your area'
  const email  = url.searchParams.get('email') ?? ''
  const token  = url.searchParams.get('token') ?? ''
  const secret = env.HITL_SECRET ?? 'webcrew-hitl-2024'

  if (!phone || token !== hitlToken(secret, phone)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const formData = await req.formData()
  const demoUrl = formData.get('demoUrl')?.toString() ?? ''
  if (!demoUrl) return new Response('Missing demoUrl', { status: 400 })

  const label = name.length > 20 ? name.slice(0, 18) + '…' : name

  // SMS to lead
  const smsBody = `Hi ${label}! Your free ${niche} website is live → ${demoUrl}\n\nLove it? Keep it for $299 one-time. Reply STOP to opt out. -WebCrew`
  await sendSms(env, phone, smsBody)

  // Email to lead (if available)
  if (email && env.RESEND_API_KEY) {
    await sendEmail(env, email, `Your free ${niche} demo site is live! 🚀`,
      `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,sans-serif">
      <div style="max-width:560px;margin:0 auto;padding:40px 20px">
        <div style="background:#111827;border-radius:16px;padding:32px;text-align:center;margin-bottom:24px">
          <div style="font-weight:800;font-size:1.2rem;color:#B5880E;margin-bottom:8px">WebCrew</div>
          <h1 style="color:#fff;font-size:1.5rem;font-weight:800;margin:0 0 8px">Your Free Demo Site is Live! 🎉</h1>
          <p style="color:rgba(255,255,255,0.6);margin:0;font-size:0.9rem">${niche} · ${city}</p>
        </div>
        <div style="background:#fff;border-radius:16px;padding:28px;border:1px solid rgba(0,0,0,0.08);text-align:center">
          <p style="color:#374151;font-size:1rem;margin:0 0 24px;line-height:1.6">Hi ${name}! We built your <b>${niche}</b> business in <b>${city}</b> a complete demo website — for free. See it below:</p>
          <a href="${demoUrl}" style="display:inline-block;background:#7c3aed;color:#fff;font-weight:700;padding:14px 32px;border-radius:100px;text-decoration:none;font-size:1rem;margin-bottom:20px">View Your Demo Site →</a>
          <p style="color:#6b7280;font-size:0.85rem;margin:0">Love it? Keep it forever for just <b>$299 one-time</b>.<br>We also offer a 24/7 AI team — reception, booking, SMS follow-up, GBP posts, review replies — for just $69/mo as a founding member.</p>
        </div>
        <p style="text-align:center;color:#9ca3af;font-size:0.75rem;margin-top:20px">
          WebCrew · <a href="https://webcrew.app/privacy" style="color:#9ca3af">Privacy</a> · Reply STOP to opt out of SMS
        </p>
      </div></body></html>`
    )
  }

  // Confirm to Ranjeet
  await sendEmail(env, env.NOTIFICATION_EMAIL,
    `✅ Demo sent: ${name} (${niche}, ${city})`,
    `<p>Demo sent to <b>${name}</b> (${phone}${email ? ' / ' + email : ''}) for <b>${niche}</b> in <b>${city}</b>.</p><p>Demo URL: <a href="${demoUrl}">${demoUrl}</a></p>`
  )

  return new Response(`<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
    <div style="text-align:center;padding:40px">
      <div style="font-size:3rem;margin-bottom:16px">✅</div>
      <h2 style="margin:0 0 8px">Demo sent to ${name}!</h2>
      <p style="color:#888;margin:0">SMS${email ? ' + email' : ''} delivered. Good luck 🚀</p>
    </div>
  </body></html>`, { headers: { 'Content-Type': 'text/html' } })
}

// ─── Send HITL notification to Ranjeet when lead says YES ──────────────────

async function notifyHITL(env: Env, phone: string, name: string, niche: string, city: string, email: string): Promise<void> {
  const secret = env.HITL_SECRET ?? 'webcrew-hitl-2024'
  const token  = hitlToken(secret, phone)
  const approveUrl = `https://api.webcrew.app/hitl?phone=${encodeURIComponent(phone)}&name=${encodeURIComponent(name)}&niche=${encodeURIComponent(niche)}&city=${encodeURIComponent(city)}&email=${encodeURIComponent(email)}&token=${token}`

  await sendEmail(env, env.NOTIFICATION_EMAIL,
    `⚡ YES received — Build needed: ${name} (${niche}, ${city})`,
    `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px">
      <h2 style="color:#7c3aed">⚡ New YES — Action Required</h2>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:6px 0;color:#666;width:80px"><b>Name</b></td><td>${name}</td></tr>
        <tr><td style="padding:6px 0;color:#666"><b>Niche</b></td><td>${niche}</td></tr>
        <tr><td style="padding:6px 0;color:#666"><b>City</b></td><td>${city}</td></tr>
        <tr><td style="padding:6px 0;color:#666"><b>Phone</b></td><td>${phone}</td></tr>
        ${email ? `<tr><td style="padding:6px 0;color:#666"><b>Email</b></td><td>${email}</td></tr>` : ''}
      </table>
      <p style="background:#f3f4f6;padding:12px;border-radius:8px;font-family:monospace;font-size:0.85rem">
        cd /Users/pavanharati/Documents/WebsiteDeveloper/pipeline<br>
        LEAD_PHONE=${phone} npm run pipeline
      </p>
      <p style="margin-top:20px">Once built, approve &amp; send the demo:</p>
      <a href="${approveUrl}" style="display:inline-block;background:#7c3aed;color:#fff;font-weight:700;padding:14px 28px;border-radius:10px;text-decoration:none;font-size:1rem;margin-top:8px">
        🚀 Approve &amp; Send Demo
      </a>
      <p style="color:#999;font-size:0.75rem;margin-top:16px">Link expires never. Token: ${token}</p>
    </div>`
  )
}

// ─── POST /call-status — Twilio missed-call recovery ─────────────────────────
// Set this as statusCallback on the client's Twilio number in reception/server.ts
// Twilio fires when CallStatus = no-answer | busy | failed

async function handleCallStatus(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await req.text()
  const p = new URLSearchParams(body)

  if (!await validateTwilioSignature(env, req, p)) {
    return new Response('Forbidden', { status: 403 })
  }

  const callStatus = p.get('CallStatus') ?? ''
  const caller     = p.get('From') ?? ''
  const to         = p.get('To') ?? ''
  const callSid    = p.get('CallSid') ?? ''
  const url        = new URL(req.url)
  const configId   = url.searchParams.get('configId') ?? ''
  const businessName = decodeURIComponent(url.searchParams.get('biz') ?? 'us')
  const flow       = url.searchParams.get('flow') ?? 'inbound'

  // Outbound outreach and recovery calls must never recursively trigger
  // another recovery attempt. Their lifecycle is still available in Twilio.
  if (flow === 'outbound_outreach' || flow === 'recovery') {
    return new Response('ok', { status: 200 })
  }

  // Only recover no-answer / busy / failed calls
  if (!['no-answer', 'busy', 'failed'].includes(callStatus) || !caller) {
    return new Response('ok', { status: 200 })
  }

  console.log(`[MissedCall] ${callStatus} from ${caller} → ${businessName} (${configId})`)

  ctx.waitUntil((async () => {
    if (!env.NEON_DATABASE_URL) return

    // Always log the missed call, but only send an SMS when there is an active
    // consent record. A caller ID alone is not SMS consent.
    const optOutCheck = await neonQuery(
      env,
      `SELECT sms_opt_out FROM leads WHERE phone = $1 OR international_phone = $1 LIMIT 1`,
      [caller]
    )
    // Log to missed_calls table
    await neonQuery(
      env,
      `INSERT INTO missed_calls (config_id, caller, business_name, call_sid, call_status, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT DO NOTHING`,
      [configId || null, caller, businessName, callSid || null, callStatus]
    )

    // Update last_missed_call_at on lead (if matched)
    await neonQuery(
      env,
      `UPDATE leads SET last_missed_call_at = NOW()
       WHERE phone = $1 OR international_phone = $1`,
      [caller]
    )

    const consentCheck = await neonQuery(
      env,
      `SELECT 1 FROM consent_events WHERE channel='sms' AND contact=$1 AND revoked_at IS NULL LIMIT 1`,
      [caller]
    )
    if (optOutCheck?.rows?.[0]?.sms_opt_out || !consentCheck?.rows?.length) {
      console.log(`[MissedCall] ${caller} has no active SMS consent — logged only`)
      return
    }

    // Send recovery SMS only to an opted-in caller
    const smsBody = `Hi! You just called ${businessName} but we missed you. How can we help? Reply here or call us back at ${to}. We'll get back to you ASAP!`
    await sendSms(env, caller, smsBody)

    // Mark SMS sent in missed_calls
    await neonQuery(
      env,
      `UPDATE missed_calls SET sms_sent = TRUE, sms_sent_at = NOW()
       WHERE call_sid = $1`,
      [callSid]
    )

    // Update lead record too
    await neonQuery(
      env,
      `UPDATE leads SET missed_call_sms_sent_at = NOW()
       WHERE phone = $1 OR international_phone = $1`,
      [caller]
    )

    console.log(`[MissedCall] Recovery SMS sent to ${caller}`)
  })())

  return new Response('ok', { status: 200 })
}

// ─── POST /cal-webhook — Cal.com booking lifecycle webhook ───────────────────
// Configure in Cal.com → Settings → Developer → Webhooks → add URL:
//   https://api.webcrew.app/cal-webhook
// Subscribe to ALL events:
//   BOOKING_CREATED, BOOKING_CANCELLED, BOOKING_RESCHEDULED, BOOKING_NO_SHOW

async function handleCalWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const payload: any = await req.json()
  const trigger = (payload.triggerEvent ?? payload.trigger ?? '').toUpperCase()
  const booking = payload.payload ?? payload

  const HANDLED = ['BOOKING_CREATED','BOOKING_CONFIRMED','BOOKING_CANCELLED',
                   'BOOKING_RESCHEDULED','BOOKING_REJECTED','BOOKING_NO_SHOW',
                   'MEETING_ENDED']
  if (!HANDLED.includes(trigger)) {
    return new Response('ignored', { status: 200 })
  }

  const uid           = booking.uid ?? booking.bookingId ?? ''
  const startTime     = booking.startTime ?? ''
  const endTime       = booking.endTime ?? ''
  const attendee      = booking.attendees?.[0] ?? {}
  const atName        = attendee.name ?? ''
  const atEmail       = attendee.email ?? ''
  const atPhone       = booking.metadata?.phone ?? attendee.phone ?? ''
  const eventTypeId   = String(booking.eventTypeId ?? '')
  const hostName      = booking.organizer?.name ?? booking.user?.name ?? ''
  const businessName  = booking.metadata?.businessName ?? hostName
  const rescheduleUid = booking.rescheduleUid ?? null  // new uid after reschedule
  const organizerEmail = booking.organizer?.email ?? booking.user?.email ?? ''
  const organizerPhone = booking.organizer?.phone ?? ''

  if (!uid) return new Response('missing uid', { status: 400 })

  ctx.waitUntil((async () => {
    if (!env.NEON_DATABASE_URL) return

    // Resolve business owner phone — try Cal.com payload first, then leads table by organizer email
    let businessOwnerPhone: string | null = organizerPhone || null
    if (!businessOwnerPhone && organizerEmail) {
      const bizMatch = await neonQuery(
        env,
        `SELECT COALESCE(international_phone, phone) AS phone FROM leads
         WHERE email = $1 OR business_email = $1 LIMIT 1`,
        [organizerEmail]
      )
      businessOwnerPhone = bizMatch?.rows?.[0]?.phone || null
    }

    // Match to lead by email or phone (attendee — for analytics linkage)
    let leadId: string | null = null
    if (atEmail || atPhone) {
      const match = await neonQuery(
        env,
        `SELECT id FROM leads WHERE email = $1 OR phone = $2 OR international_phone = $2 LIMIT 1`,
        [atEmail || null, atPhone || null]
      )
      leadId = match?.rows?.[0]?.id ?? null
    }

    // ── BOOKING_CREATED / BOOKING_CONFIRMED ──────────────────────────────────
    if (['BOOKING_CREATED','BOOKING_CONFIRMED'].includes(trigger)) {
      if (!startTime) return

      await neonQuery(
        env,
        `INSERT INTO cal_bookings
           (booking_uid, lead_id, attendee_name, attendee_email, attendee_phone,
            business_name, event_type_id, start_time, end_time, status, business_owner_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10)
         ON CONFLICT (booking_uid) DO UPDATE SET
           status = 'confirmed',
           attendee_phone = COALESCE(EXCLUDED.attendee_phone, cal_bookings.attendee_phone),
           business_owner_phone = COALESCE(EXCLUDED.business_owner_phone, cal_bookings.business_owner_phone),
           start_time = EXCLUDED.start_time,
           end_time   = EXCLUDED.end_time`,
        [uid, leadId, atName||null, atEmail||null, atPhone||null,
         businessName||null, eventTypeId||null, startTime, endTime, businessOwnerPhone||null]
      )
      console.log(`[Cal] CONFIRMED ${uid} → ${atName} at ${startTime}`)

      // Confirmation SMS to attendee
      if (atPhone && env.TWILIO_ACCOUNT_SID) {
        const dtStr = new Date(startTime).toLocaleString('en-US',
          { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit',
            timeZone: 'America/Los_Angeles' })
        await sendSms(env, atPhone,
          `Your appointment with ${businessName} is confirmed for ${dtStr}. Reply CANCEL to cancel.`)
      }

      if (env.NOTIFICATION_EMAIL) {
        await sendEmail(env, env.NOTIFICATION_EMAIL,
          `📅 Booking: ${atName} → ${businessName}`,
          `<p><b>${atName}</b> booked with <b>${businessName}</b> for ${startTime}</p>
           <p>Phone: ${atPhone||'—'} | Email: ${atEmail||'—'}</p>`)
      }
    }

    // ── BOOKING_RESCHEDULED ───────────────────────────────────────────────────
    else if (trigger === 'BOOKING_RESCHEDULED') {
      // Mark old booking rescheduled, upsert new booking uid
      await neonQuery(
        env,
        `UPDATE cal_bookings SET status = 'rescheduled' WHERE booking_uid = $1`,
        [uid]
      )
      if (rescheduleUid && startTime) {
        await neonQuery(
          env,
          `INSERT INTO cal_bookings
             (booking_uid, lead_id, attendee_name, attendee_email, attendee_phone,
              business_name, event_type_id, start_time, end_time, status, business_owner_phone)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10)
           ON CONFLICT (booking_uid) DO UPDATE SET
             status = 'confirmed',
             business_owner_phone = COALESCE(EXCLUDED.business_owner_phone, cal_bookings.business_owner_phone),
             start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time`,
          [rescheduleUid, leadId, atName||null, atEmail||null, atPhone||null,
           businessName||null, eventTypeId||null, startTime, endTime, businessOwnerPhone||null]
        )
      }
      console.log(`[Cal] RESCHEDULED ${uid} → ${rescheduleUid} at ${startTime}`)

      // Reschedule confirmation SMS
      if (atPhone && env.TWILIO_ACCOUNT_SID && startTime) {
        const dtStr = new Date(startTime).toLocaleString('en-US',
          { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit',
            timeZone: 'America/Los_Angeles' })
        await sendSms(env, atPhone,
          `Your appointment with ${businessName} has been rescheduled to ${dtStr}. See you then!`)
      }
    }

    // ── BOOKING_CANCELLED / BOOKING_REJECTED ─────────────────────────────────
    else if (['BOOKING_CANCELLED','BOOKING_REJECTED'].includes(trigger)) {
      await neonQuery(
        env,
        `UPDATE cal_bookings SET status = 'cancelled' WHERE booking_uid = $1`,
        [uid]
      )
      console.log(`[Cal] CANCELLED ${uid} (${atName})`)

      // Rebook SMS — send 24h later via send-review-requests pattern
      // For now, send immediately with a soft rebook nudge
      if (atPhone && env.TWILIO_ACCOUNT_SID) {
        const bookUrl = env.CALENDLY_URL || 'webcrew.app'
        await sendSms(env, atPhone,
          `Your appointment with ${businessName} was cancelled. Want to rebook? Pick a new time here: ${bookUrl}`)
      }
    }

    // ── BOOKING_NO_SHOW ───────────────────────────────────────────────────────
    else if (trigger === 'BOOKING_NO_SHOW') {
      await neonQuery(
        env,
        `UPDATE cal_bookings SET status = 'no_show' WHERE booking_uid = $1`,
        [uid]
      )
      console.log(`[Cal] NO_SHOW ${uid} (${atName})`)

      // Re-engagement SMS
      if (atPhone && env.TWILIO_ACCOUNT_SID) {
        const bookUrl = env.CALENDLY_URL || 'webcrew.app'
        await sendSms(env, atPhone,
          `Hi ${atName.split(' ')[0]}! We missed you at your ${businessName} appointment. Easy to rebook here: ${bookUrl}`)
      }
    }

    // ── MEETING_ENDED — review request is handled by send-review-requests.ts ─
    else if (trigger === 'MEETING_ENDED') {
      await neonQuery(
        env,
        `UPDATE cal_bookings SET status = 'completed' WHERE booking_uid = $1`,
        [uid]
      )
      console.log(`[Cal] MEETING_ENDED ${uid}`)
    }
  })())

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

// ─── Main worker ──────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)
    const method = req.method

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      })
    }

    if (url.pathname === '/leads' && method === 'POST') {
      return handleLeadSubmission(req, env)
    }

    if (url.pathname === '/audit' && method === 'POST') {
      return handleAuditRequest(req, env)
    }

    // Survey submissions from webcrew.app/survey
    if (url.pathname === '/survey' && method === 'POST') {
      return handleSurveySubmission(req, env)
    }

    // Twilio inbound SMS webhook
    if (url.pathname === '/sms/reply' && method === 'POST') {
      return handleSMSWebhook(req, env, ctx)
    }

    // Twilio inbound voice webhook. This small edge endpoint keeps TwiML valid
    // and connects the call to the existing Cloud Run WebSocket relay.
    if (url.pathname.startsWith('/voice/continue/') && method === 'POST') {
      const configId = url.pathname.slice('/voice/continue/'.length)
      if (!configId) return new Response('Missing config ID', { status: 400 })
      return handleVoiceContinue(req, env, configId, url)
    }
    if (url.pathname.startsWith('/voice/overflow/') && method === 'POST') {
      const configId = url.pathname.slice('/voice/overflow/'.length)
      if (!configId) return new Response('Missing config ID', { status: 400 })
      return handleInboundVoice(req, env, configId, 'overflow')
    }
    if (url.pathname.startsWith('/voice/outbound/') && method === 'POST') {
      const configId = url.pathname.slice('/voice/outbound/'.length)
      if (!configId) return new Response('Missing config ID', { status: 400 })
      return handleInboundVoice(req, env, configId, 'outbound')
    }
    if (url.pathname.startsWith('/voice/') && method === 'POST') {
      const configId = url.pathname.slice('/voice/'.length)
      if (!configId) return new Response('Missing config ID', { status: 400 })
      return handleInboundVoice(req, env, configId)
    }

    if (url.pathname === '/outbound/call' && method === 'POST') {
      return handleOutboundCall(req, env)
    }

    // HITL approval flow
    if (url.pathname === '/hitl' && method === 'GET') {
      return handleHITLPage(url, env)
    }
    if (url.pathname === '/hitl/send' && method === 'POST') {
      return handleHITLSend(req, url, env)
    }

    // Twilio call-status webhook (missed call recovery)
    if (url.pathname === '/call-status' && method === 'POST') {
      return handleCallStatus(req, env, ctx)
    }

    // Cal.com booking webhook
    if (url.pathname === '/cal-webhook' && method === 'POST') {
      return handleCalWebhook(req, env, ctx)
    }

    if (url.pathname === '/health' && method === 'GET') {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response('Not found', { status: 404 })
  },
}
