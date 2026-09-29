import http from 'http'
import { WebSocketServer } from 'ws'
import { attachTwilioRelay } from './twilio-relay.js'
import { buildBrain, buildSystemPrompt } from './brain-builder.js'
import { saveReceptionConfig, getReceptionConfig, getReceptionConfigById, updateTwilioPhone } from './db.js'
import { WEBCREW_SYSTEM_PROMPT } from './webcrew-prompt.js'

const WEBCREW_URL = 'https://webcrew.app'
import { callMeta } from './call-context.js'
import { GeminiLiveSession } from './gemini-live.js'
import { registerPending, type WarmCallEntry } from './call-warmup.js'

// A bug in one call's async tool-call handling must never kill the whole
// process — that would drop every other concurrent call on this instance.
process.on('unhandledRejection', (err) => console.error('[Server] Unhandled rejection:', err))
process.on('uncaughtException',  (err) => console.error('[Server] Uncaught exception:', err))

// Reception server routes:
//   POST /voice/:configId       → TwiML (Twilio inbound/outbound webhook)
//   POST /amd-status            → AMD callback (machine → redirect to voicemail)
//   GET  /voicemail/:configId   → TwiML voicemail message
//   GET  /transfer-twiml        → TwiML live transfer (?to=+1xxx)
//   POST /call-status           → Call lifecycle logging
//   POST /call                  → Initiate outbound call (Bearer auth)
//   POST /warm-trigger          → Outbound to warm lead (email click / SMS reply)
//   POST /provision             → Auto-provision reception config
//   GET  /health                → Health check

const PORT     = parseInt(process.env.RECEPTION_PORT ?? process.env.PORT ?? '3030')
const BASE_URL = process.env.RECEPTION_BASE_URL ?? `http://localhost:${PORT}`

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export function startReceptionServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

    // ── Health ────────────────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'ai-reception', port: PORT }))
      return
    }

    // ── Twilio inbound/outbound webhook: POST /voice/:configId ────────────────
    if (req.method === 'POST' && url.pathname.startsWith('/voice/')) {
      const configId = url.pathname.slice('/voice/'.length)
      if (!configId) { res.writeHead(400); res.end('Missing config ID'); return }

      let body = ''
      req.on('data', c => { body += c })
      req.on('end', async () => {
        const caller   = extractFormParam(body, 'From')
        const callSid  = extractFormParam(body, 'CallSid')
        const wsScheme = BASE_URL.startsWith('https') ? 'wss' : 'ws'
        const wsHost   = BASE_URL.replace(/^https?:\/\//, '')

        // Call metadata travels with Twilio instead of living only in this
        // process. The HTTP webhook and WebSocket may land on different Cloud
        // Run instances when the service scales.
        const outbound   = url.searchParams.get('outbound') === '1'
        const leadName   = url.searchParams.get('leadName') ?? ''
        const demoUrl    = url.searchParams.get('demoUrl') ?? ''
        const trigger    = url.searchParams.get('triggerType') ?? ''
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">WebCrew AI receptionist. This call is recorded for training and quality. Continuing means you consent. Please hold.</Say>
  <Connect>
    <Stream url="${wsScheme}://${wsHost}/ws">
      <Parameter name="caller" value="${xmlEscape(caller)}"/>
      <Parameter name="config" value="${xmlEscape(configId)}"/>
      <Parameter name="outbound" value="${outbound ? '1' : '0'}"/>
      <Parameter name="leadName" value="${xmlEscape(leadName)}"/>
      <Parameter name="demoUrl" value="${xmlEscape(demoUrl)}"/>
      <Parameter name="triggerType" value="${xmlEscape(trigger)}"/>
    </Stream>
  </Connect>
</Response>`

        console.log(`[Server] ${caller ? 'Inbound' : 'Outbound connected'} → config ${configId} | caller ${caller}`)
        res.writeHead(200, { 'Content-Type': 'text/xml' })
        res.end(twiml)

        // Fire-and-forget: pre-warm Gemini while Twilio plays Say (overlaps ~2s)
        if (callSid && configId) {
          registerPending(callSid, (async (): Promise<WarmCallEntry> => {
            const configData = await getReceptionConfigById(configId)
            if (!configData) throw new Error(`config ${configId} not found`)
            const session = new GeminiLiveSession({
              onReady:    () => {},
              onAudio:    () => {},
              onText:     () => {},
              onToolCall: async () => {},
              onError:    (e) => console.error(`[Warmup] ${callSid} Gemini error:`, e.message),
              onClose:    () => {},
            })
            await session.connect(configData.system_prompt, configData.website_url)
            console.log(`[Warmup] Gemini ready for ${callSid}`)
            return { session, configData }
          })())
        }
      })
      return
    }

    // ── AMD status callback: POST /amd-status ─────────────────────────────────
    // Twilio fires async after answering machine detection on outbound calls.
    // AnsweredBy: human | machine_start | machine_end_beep | machine_end_silence | fax | unknown
    if (req.method === 'POST' && url.pathname === '/amd-status') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', async () => {
        const callSid    = extractFormParam(body, 'CallSid')
        const answeredBy = extractFormParam(body, 'AnsweredBy')
        console.log(`[AMD] ${callSid} → ${answeredBy}`)
        res.writeHead(204); res.end()

        // Machine detected — redirect call to voicemail TwiML
        if (answeredBy === 'machine_end_beep' || answeredBy === 'machine_end_silence') {
          const meta     = callMeta.get(callSid)
          const configId = meta?.configId ?? url.searchParams.get('configId') ?? undefined
          if (!configId) { console.log(`[AMD] No configId for ${callSid} — skipping voicemail`); return }

          const sid  = process.env.TWILIO_ACCOUNT_SID
          const auth = process.env.TWILIO_AUTH_TOKEN
          if (!sid || !auth) return

          // Redirect call to voicemail TwiML
          await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callSid}.json`, {
            method:  'POST',
            headers: {
              Authorization:  `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              Url:    `${BASE_URL}/voicemail/${configId}`,
              Method: 'GET',
            }).toString(),
          }).catch(e => console.error('[AMD] redirect failed:', e.message))
        }
      })
      return
    }

    // ── Voicemail TwiML: GET /voicemail/:configId ─────────────────────────────
    // Plays a short voicemail message after machine detected.
    if (req.method === 'GET' && url.pathname.startsWith('/voicemail/')) {
      const configId = url.pathname.slice('/voicemail/'.length)
      let businessName = 'us'
      let callbackNum  = process.env.TWILIO_PHONE_NUMBER ?? ''

      try {
        const config = await getReceptionConfigById(configId)
        if (config) {
          businessName = config.business_name
          callbackNum  = config.brain?.phone ?? callbackNum
        }
      } catch { /* use defaults */ }

      const message = callbackNum
        ? `Hi there! This is an AI assistant for ${businessName}. We tried reaching you to discuss how we can help your business. Please give us a call back at ${callbackNum.split('').join(', ')} and we'd love to connect. Have a wonderful day!`
        : `Hi there! This is an AI assistant for ${businessName}. We tried reaching you — please call us back when you get a chance. Have a wonderful day!`

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${message}</Say>
  <Hangup/>
</Response>`

      res.writeHead(200, { 'Content-Type': 'text/xml' })
      res.end(twiml)
      return
    }

    // ── Live transfer TwiML: GET /transfer-twiml ──────────────────────────────
    // Used by escalate_to_human to dial owner directly.
    // Query: ?to=+1xxx&announce=0|1
    if (url.pathname === '/transfer-twiml') {
      const to       = url.searchParams.get('to') ?? ''
      const announce = url.searchParams.get('announce') !== '0'

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${announce ? '<Say voice="Polly.Joanna-Neural">Please hold while I connect you with a team member.</Say>' : ''}
  <Dial timeout="30" action="${BASE_URL}/transfer-complete">${to}</Dial>
</Response>`

      res.writeHead(200, { 'Content-Type': 'text/xml' })
      res.end(twiml)
      return
    }

    // ── Transfer complete (Dial fallback): POST /transfer-complete ────────────
    if (req.method === 'POST' && url.pathname === '/transfer-complete') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const status = extractFormParam(body, 'DialCallStatus')
        console.log(`[Transfer] Dial complete — status: ${status}`)
        const twiml = status === 'completed' || status === 'answered'
          ? `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`
          : `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">I'm sorry, no one is available right now. Please leave a message after the tone.</Say><Record maxLength="120"/></Response>`
        res.writeHead(200, { 'Content-Type': 'text/xml' })
        res.end(twiml)
      })
      return
    }

    // ── Call status logging: POST /call-status ────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/call-status') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const sid      = extractFormParam(body, 'CallSid')
        const status   = extractFormParam(body, 'CallStatus')
        const duration = extractFormParam(body, 'CallDuration')
        console.log(`[CallStatus] ${sid} → ${status}${duration ? ` (${duration}s)` : ''}`)
        if (status === 'completed' || status === 'failed' || status === 'no-answer') {
          callMeta.delete(sid)
        }
        res.writeHead(204); res.end()
      })
      return
    }

    // ── Auth check helper (shared by /call, /warm-trigger, /provision) ────────
    const isAuthed = (authHeader: string) => {
      const secret = process.env.RECEPTION_PROVISION_SECRET
      return !secret || authHeader === `Bearer ${secret}`
    }

    // ── Outbound call: POST /call ─────────────────────────────────────────────
    // Body: { to, configId, from? }
    if (req.method === 'POST' && url.pathname === '/call') {
      if (!isAuthed(req.headers.authorization ?? '')) { res.writeHead(401); res.end('Unauthorized'); return }

      let body = ''
      req.on('data', c => { body += c })
      req.on('end', async () => {
        try {
          const { to, configId, from } = JSON.parse(body)
          if (!to || !configId) { res.writeHead(400); res.end(JSON.stringify({ error: 'to and configId required' })); return }
          const result = await initiateCall({ to, configId, from })
          if (!result.ok) { res.writeHead(500); res.end(JSON.stringify({ error: result.error })); return }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e: any) {
          console.error('[Server] /call error:', e.message)
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    // ── Warm trigger: POST /warm-trigger ──────────────────────────────────────
    // Called when lead clicks email link, replies to SMS, or submits form.
    // Fires outbound call within seconds; relay uses outbound-aware greeting.
    // Body: { to, configId, leadName?, demoUrl?, triggerType?, from? }
    if (req.method === 'POST' && url.pathname === '/warm-trigger') {
      if (!isAuthed(req.headers.authorization ?? '')) { res.writeHead(401); res.end('Unauthorized'); return }

      let body = ''
      req.on('data', c => { body += c })
      req.on('end', async () => {
        try {
          const { to, configId, leadName, demoUrl, triggerType, from } = JSON.parse(body)
          if (!to || !configId) { res.writeHead(400); res.end(JSON.stringify({ error: 'to and configId required' })); return }

          const result = await initiateCall({ to, configId, from, meta: { configId, leadName, demoUrl, triggerType, isOutbound: true } })
          if (!result.ok) { res.writeHead(500); res.end(JSON.stringify({ error: result.error })); return }

          console.log(`[WarmTrigger] ${triggerType ?? 'unknown'} → calling ${to}${leadName ? ` (${leadName})` : ''}`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e: any) {
          console.error('[Server] /warm-trigger error:', e.message)
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    // ── Provision: POST /provision ────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/provision') {
      if (!isAuthed(req.headers.authorization ?? '')) { res.writeHead(401); res.end('Unauthorized'); return }

      let body = ''
      req.on('data', c => { body += c })
      req.on('end', async () => {
        try {
          const { websiteUrl: suppliedWebsite, businessName, leadId, phone, email, industry, city, paymentConfirmed } = JSON.parse(body)
          if (!leadId || !businessName) { res.writeHead(400); res.end(JSON.stringify({ error: 'leadId and businessName required' })); return }
          const websiteUrl = suppliedWebsite || `https://onboarding.webcrew.app/client/${leadId}`

          // Idempotency: an Admin retry must reuse the same receptionist and
          // Twilio number instead of purchasing another number.
          const existing = await getReceptionConfig(websiteUrl)
          if (existing?.twilio_phone) {
            const messaging = paymentConfirmed === true
              ? await ensureTwilioNumberMessagingReady(existing.twilio_phone)
              : { messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID ?? null, messagingReady: false }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              ok: true, reused: true, configId: existing.id,
              businessName: existing.business_name, twilioNumber: existing.twilio_phone,
              twilioWebhook: `${BASE_URL}/voice/${existing.id}`,
              ...messaging,
              forwardingNote: `Client forwards their business number to: ${existing.twilio_phone}`,
            }))
            return
          }

          console.log(`[Provision] Building reception brain for: ${websiteUrl}`)
          // WebCrew's own number uses a hand-crafted sales prompt, not a scraped brain
          const isWebCrew    = websiteUrl.replace(/\/$/, '') === WEBCREW_URL
          const isPlaceholder = !suppliedWebsite
          const brain        = isWebCrew
            ? { name: 'WebCrew', type: 'AI web agency', email: 'hello@webcrew.app', hours: {}, services: [], faqs: [] } as unknown as import('./types.js').BusinessBrain
            : isPlaceholder
              ? { name: businessName, type: industry || 'local business', phone: phone || undefined, email: email || undefined, address: city || undefined, hours: {}, services: [], faqs: [], special_notes: 'New client onboarding is incomplete. Capture caller details accurately and escalate any unanswered business-specific question for human follow-up.' } as unknown as import('./types.js').BusinessBrain
              : await buildBrain(websiteUrl)
          const systemPrompt = isWebCrew ? WEBCREW_SYSTEM_PROMPT : buildSystemPrompt(brain)
          const config       = await saveReceptionConfig(websiteUrl, businessName ?? brain.name, brain, systemPrompt, leadId)
          const webhookUrl   = `${BASE_URL}/voice/${config.id}`

          console.log(`[Provision] Done: ${config.business_name} | ${config.id}`)
          console.log(`[Provision] Twilio webhook: ${webhookUrl}`)

          // Auto-buy a local Twilio number and wire it to this config
          let twilioNumber: string | null = null
          let twilioSid: string | null = null
          let messagingServiceSid: string | null = null
          let messagingReady = false
          try {
            if (paymentConfirmed !== true) {
              throw new Error('Stripe payment confirmation is required before purchasing a Twilio number')
            }
            const result = await buyLocalTwilioNumber(brain.phone ?? null, webhookUrl, config.id, config.business_name)
            if (result) {
              twilioNumber = result.phoneNumber
              twilioSid    = result.sid
              messagingServiceSid = result.messagingServiceSid
              messagingReady = result.messagingReady
              await updateTwilioPhone(config.id, twilioNumber)
              console.log(`[Provision] Twilio number provisioned: ${twilioNumber}`)
            }
          } catch (e: any) {
            console.warn(`[Provision] Twilio number buy failed (non-fatal): ${e.message}`)
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ok: true,
            configId:      config.id,
            businessName:  config.business_name,
            twilioWebhook: webhookUrl,
            twilioNumber,   // local number to give to client for call forwarding
            twilioSid,
            messagingServiceSid,
            messagingReady,
            forwardingNote: twilioNumber
              ? `Client forwards their business number to: ${twilioNumber}`
              : 'Twilio number not provisioned — set webhook manually',
            servicesCount: brain.services.length,
            faqsCount:     brain.faqs.length,
          }))
        } catch (e: any) {
          console.error('[Provision] Error:', e.message)
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    // ── Pipeline trigger: POST /pipeline-trigger ──────────────────────────────
    // Body: { leadId, niche?, config? }
    // Kicks off full pipeline for an existing DB lead (skips lead-hunter).
    if (req.method === 'POST' && url.pathname === '/pipeline-trigger') {
      if (!isAuthed(req.headers.authorization ?? '')) { res.writeHead(401); res.end('Unauthorized'); return }

      let body = ''
      req.on('data', c => { body += c })
      req.on('end', async () => {
        try {
          const { leadId, config } = JSON.parse(body)
          if (!leadId) { res.writeHead(400); res.end(JSON.stringify({ error: 'leadId required' })); return }

          // Return immediately — pipeline runs async in background
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, leadId, message: 'Pipeline started' }))

          // Fire-and-forget
          const { runPipelineForLead } = await import('../orchestrator.js')
          runPipelineForLead(leadId, config ?? {}).catch((e: any) => {
            console.error(`[PipelineTrigger] Failed for ${leadId}:`, e.message)
          })
        } catch (e: any) {
          console.error('[Server] /pipeline-trigger error:', e.message)
          if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })) }
        }
      })
      return
    }

    // ── Retention: POST /retention ────────────────────────────────────────────
    // Called daily by GCP Cloud Scheduler at 7am PST.
    if (req.method === 'POST' && url.pathname === '/retention') {
      if (!isAuthed(req.headers.authorization ?? '')) { res.writeHead(401); res.end('Unauthorized'); return }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, message: 'Retention run started' }))

      import('../scripts/run-retention-all.js').catch(() =>
        import('../retention.js').then(({ default: runRetention }) => runRetention())
      ).catch((e: any) => console.error('[Retention] failed:', e.message))
      return
    }

    // ── Drip follow-up: POST /drip ────────────────────────────────────────────
    // Called daily at 9am PST. Day-3 + Day-10 follow-ups for non-replying leads.
    if (req.method === 'POST' && url.pathname === '/drip') {
      if (!isAuthed(req.headers.authorization ?? '')) { res.writeHead(401); res.end('Unauthorized'); return }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, message: 'Drip run started' }))

      import('../scripts/drip-followup.js').catch((e: any) =>
        console.error('[Drip] Import failed:', e.message)
      )
      return
    }

    // ── Review requests: POST /review-requests ────────────────────────────────
    // Called hourly. Sends review SMS 60min after appointment ends.
    if (req.method === 'POST' && url.pathname === '/review-requests') {
      if (!isAuthed(req.headers.authorization ?? '')) { res.writeHead(401); res.end('Unauthorized'); return }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, message: 'Review requests run started' }))

      import('../scripts/send-review-requests.js').catch((e: any) =>
        console.error('[ReviewReq] Import failed:', e.message)
      )
      return
    }

    res.writeHead(404); res.end('Not found')
  })

  const wss = new WebSocketServer({ server, path: '/ws' })
  attachTwilioRelay(wss)

  server.listen(PORT, () => {
    console.log(`\n[Reception Server] Running on port ${PORT}`)
    console.log(`  Health:       GET  ${BASE_URL}/health`)
    console.log(`  Inbound:      POST ${BASE_URL}/voice/:configId`)
    console.log(`  Stream:       WS   ${BASE_URL.replace('http', 'ws')}/ws`)
    console.log(`  Outbound:     POST ${BASE_URL}/call`)
    console.log(`  Warm trigger: POST ${BASE_URL}/warm-trigger`)
    console.log(`  Provision:    POST ${BASE_URL}/provision\n`)
  })

  return server
}

// ─── Shared outbound call initiator ──────────────────────────────────────────

interface InitiateCallOpts {
  to: string
  configId: string
  from?: string
  meta?: import('./call-context.js').CallMeta
}

async function initiateCall(opts: InitiateCallOpts): Promise<{ ok: boolean; callSid?: string; to?: string; from?: string; status?: string; error?: string }> {
  const sid  = process.env.TWILIO_ACCOUNT_SID
  const auth = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !auth) return { ok: false, error: 'Twilio credentials not configured' }

  const fromNumber = opts.from ?? process.env.TWILIO_PHONE_NUMBER
  if (!fromNumber) return { ok: false, error: 'from number required (or set TWILIO_PHONE_NUMBER)' }

  const voiceUrl = new URL(`${BASE_URL}/voice/${opts.configId}`)
  if (opts.meta?.isOutbound) voiceUrl.searchParams.set('outbound', '1')
  if (opts.meta?.leadName) voiceUrl.searchParams.set('leadName', opts.meta.leadName)
  if (opts.meta?.demoUrl) voiceUrl.searchParams.set('demoUrl', opts.meta.demoUrl)
  if (opts.meta?.triggerType) voiceUrl.searchParams.set('triggerType', opts.meta.triggerType)

  const statusUrl = new URL(`${process.env.API_BASE_URL ?? 'https://api.webcrew.app'}/call-status`)
  statusUrl.searchParams.set('configId', opts.configId)
  statusUrl.searchParams.set('biz', 'WebCrew')
  statusUrl.searchParams.set('flow', 'outbound_outreach')

  const callBody = new URLSearchParams({
    To:                        opts.to,
    From:                      fromNumber,
    Url:                       voiceUrl.toString(),
    Method:                    'POST',
    StatusCallback:            statusUrl.toString(),
    StatusCallbackMethod:      'POST',
    StatusCallbackEvent:       'initiated ringing answered completed',
    MachineDetection:          'Enable',
    AsyncAmdStatusCallback:    `${BASE_URL}/amd-status?configId=${encodeURIComponent(opts.configId)}`,
    AsyncAmdStatusCallbackMethod: 'POST',
  })

  const twilioRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method:  'POST',
    headers: {
      Authorization:  `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: callBody.toString(),
  })

  const result = await twilioRes.json() as any
  if (!twilioRes.ok) return { ok: false, error: result.message ?? 'Twilio call failed' }

  // Store metadata for AMD callback and relay greeting
  callMeta.set(result.sid, opts.meta ?? { configId: opts.configId })
  console.log(`[Server] Outbound call → ${opts.to} | SID: ${result.sid}`)

  return { ok: true, callSid: result.sid, to: opts.to, from: fromNumber, status: result.status }
}

// ─── Auto-provision Twilio local number ───────────────────────────────────────
// Buys a local US number matching the business area code, wires voice webhook.
// Returns null if Twilio creds not set or no numbers available.

async function buyLocalTwilioNumber(
  businessPhone: string | null,
  voiceWebhookUrl: string,
  configId: string,
  businessName: string
): Promise<{ phoneNumber: string; sid: string; messagingServiceSid: string | null; messagingReady: boolean } | null> {
  const sid  = process.env.TWILIO_ACCOUNT_SID
  const auth = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !auth) return null

  // Extract area code from business phone (US: +1AAANXXXXXX → AAA)
  const areaCode = businessPhone?.replace(/\D/g, '').slice(-10, -7) ?? null
  const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`
  const headers = { Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}` }

  // Search for available local numbers (area code match first, fallback to any US)
  const searchUrl = areaCode
    ? `${base}/AvailablePhoneNumbers/US/Local.json?AreaCode=${areaCode}&VoiceEnabled=true&Limit=1`
    : `${base}/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&InRegion=CA&Limit=1`

  const searchRes = await fetch(searchUrl, { headers })
  const searchData = await searchRes.json() as any
  const available  = searchData.available_phone_numbers ?? []
  if (!available.length) {
    // Fallback: any US number
    const fallback = await fetch(`${base}/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&Limit=1`, { headers })
    const fd = await fallback.json() as any
    available.push(...(fd.available_phone_numbers ?? []))
  }
  if (!available.length) throw new Error('No available Twilio numbers found')

  const numberToBuy = available[0].phone_number

  // Missed-call recovery (api/src/index.ts handleCallStatus) needs this fired
  // on no-answer/busy/failed — without it, calls that never reach the AI are
  // never followed up.
  const statusCallbackUrl = new URL(`${process.env.API_BASE_URL ?? 'https://api.webcrew.app'}/call-status`)
  statusCallbackUrl.searchParams.set('configId', configId)
  statusCallbackUrl.searchParams.set('biz', businessName)
  statusCallbackUrl.searchParams.set('flow', 'inbound')

  // Buy the number and set the voice + status-callback webhooks
  const buyRes = await fetch(`${base}/IncomingPhoneNumbers.json`, {
    method:  'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      PhoneNumber:          numberToBuy,
      VoiceUrl:             voiceWebhookUrl,
      VoiceMethod:          'POST',
      StatusCallback:       statusCallbackUrl.toString(),
      StatusCallbackMethod: 'POST',
    }).toString(),
  })
  const bought = await buyRes.json() as any
  if (!buyRes.ok) throw new Error(bought?.message ?? 'Twilio buy failed')

  // All WebCrew-branded messaging numbers share the verified WebCrew sender
  // pool. This happens only after the caller has passed the Stripe payment gate.
  const { messagingServiceSid, messagingReady } = await attachTwilioNumberToMessagingService(bought.sid, headers)

  return { phoneNumber: bought.phone_number, sid: bought.sid, messagingServiceSid, messagingReady }
}

async function attachTwilioNumberToMessagingService(
  phoneNumberSid: string,
  headers: Record<string, string>
): Promise<{ messagingServiceSid: string | null; messagingReady: boolean }> {
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID ?? null
  if (!messagingServiceSid) {
    console.warn('[Provision] TWILIO_MESSAGING_SERVICE_SID is not configured; SMS remains pending')
    return { messagingServiceSid: null, messagingReady: false }
  }
  const attachRes = await fetch(
    `https://messaging.twilio.com/v1/Services/${messagingServiceSid}/PhoneNumbers`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ PhoneNumberSid: phoneNumberSid }).toString(),
    }
  )
  if (attachRes.ok) return { messagingServiceSid, messagingReady: true }
  const error = await attachRes.json().catch(() => ({})) as any
  if (error?.code === 21710 || /already exists/i.test(error?.message ?? '')) {
    return { messagingServiceSid, messagingReady: true }
  }
  console.warn(`[Provision] Messaging Service association failed: ${error?.message ?? attachRes.status}`)
  return { messagingServiceSid, messagingReady: false }
}

async function ensureTwilioNumberMessagingReady(phoneNumber: string) {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const auth = process.env.TWILIO_AUTH_TOKEN
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID ?? null
  if (!sid || !auth || !messagingServiceSid) return { messagingServiceSid, messagingReady: false }
  const headers = { Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}` }
  const lookup = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}&PageSize=1`,
    { headers }
  )
  const data = await lookup.json() as any
  const phoneSid = data?.incoming_phone_numbers?.[0]?.sid
  if (!lookup.ok || !phoneSid) return { messagingServiceSid, messagingReady: false }
  return attachTwilioNumberToMessagingService(phoneSid, headers)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractFormParam(body: string, param: string): string {
  try {
    const decoded = decodeURIComponent(body.replace(/\+/g, ' '))
    const match   = decoded.match(new RegExp(`(?:^|&)${param}=([^&]*)`, 'i'))
    return match?.[1] ?? ''
  } catch {
    return ''
  }
}
