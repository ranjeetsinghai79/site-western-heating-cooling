import type { WebSocketServer } from 'ws'
import WebSocket from 'ws'
import { GeminiLiveSession } from './gemini-live.js'
import { twilioToGeminiAudio, geminiToTwilioAudio } from './audio-codec.js'
import { getReceptionConfigById, insertCallLog, upsertReceptionLead, getRecentCallerContext, startEmailVerification, getVerifiedEmail, getMonthlyVoiceMinutes, markCapAlertSent } from './db.js'
import { sendSMS } from '../agents/sms-outreach.js'
import { getAvailableSlots, createBooking } from './cal-booking.js'
import { callMeta } from './call-context.js'
import { consumePending } from './call-warmup.js'
import { logCost } from '../tools/cost-tracker.js'

const CAL_EVENT_TYPE_ID = parseInt(process.env.CAL_EVENT_TYPE_ID ?? '6126925')
const CAL_TIMEZONE      = process.env.CAL_TIMEZONE ?? 'America/Los_Angeles'
const BASE_URL          = process.env.RECEPTION_BASE_URL ?? 'http://localhost:3030'
const VOICE_CAP_MINUTES = parseInt(process.env.RECEPTION_VOICE_CAP_MINUTES ?? '100')

/** Fire-and-forget internal alert — same raw Resend pattern as agents/leads-agent.ts. */
async function sendCapAlertEmail(businessName: string, configId: string, minutesUsed: number, cap: number): Promise<void> {
  const ownerEmail = process.env.BUSINESS_OWNER_EMAIL
  const apiKey = process.env.RESEND_API_KEY
  if (!ownerEmail || !apiKey) { console.warn('[VoiceCap] alert not sent — BUSINESS_OWNER_EMAIL/RESEND_API_KEY not set'); return }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.OUTREACH_FROM_EMAIL || 'alerts@webcrew.app',
        to: ownerEmail,
        subject: `[Voice cap] ${businessName} used ${minutesUsed}/${cap} min this month`,
        html: `<p><strong>${businessName}</strong> (config ${configId}) has used <strong>${minutesUsed} minutes</strong> of AI Reception voice this month — over the ${cap}-minute included cap.</p><p>No action taken automatically (soft alert only, call was not interrupted). Review usage and confirm an overage agreement if this continues.</p>`,
      }),
    })
  } catch (e: any) {
    console.error('[VoiceCap] alert email failed:', e.message)
  }
}

/** Logs real per-call cost and checks the monthly voice-minute cap. Fire-and-forget — never blocks call teardown. */
async function trackCallCostAndCap(configId: string, businessName: string, leadId: string | null | undefined, leadName: string, durationSec: number): Promise<void> {
  const minutes = durationSec / 60
  await Promise.all([
    logCost({ service: 'twilio_voice_leg', units: minutes, leadId: leadId ?? undefined, leadName, note: `config ${configId}` }),
    logCost({ service: 'gemini_live_voice', units: minutes, leadId: leadId ?? undefined, leadName, note: `config ${configId}`, force: true }),
  ]).catch(e => console.error('[VoiceCap] cost logging failed:', e.message))

  try {
    const monthlyMinutes = await getMonthlyVoiceMinutes(configId)
    if (monthlyMinutes > VOICE_CAP_MINUTES) {
      const firstAlertThisMonth = await markCapAlertSent(configId, monthlyMinutes)
      if (firstAlertThisMonth) await sendCapAlertEmail(businessName, configId, monthlyMinutes, VOICE_CAP_MINUTES)
    }
  } catch (e: any) {
    console.error('[VoiceCap] cap check failed:', e.message)
  }
}

function normalizeCallerPhone(value: string | null): string | null {
  if (!value || value.startsWith('client:')) return null
  const digits = value.replace(/\D/g, '')
  return digits.length >= 10 ? `+1${digits.slice(-10)}` : null
}

// Bridges Twilio Media Streams ↔ Gemini Live
// Flow: inbound call → TwiML <Stream> → WebSocket here → Gemini Live → audio back to Twilio

export function attachTwilioRelay(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req) => {
    const params = new URL(req.url ?? '/', 'http://localhost').searchParams
    let configId = params.get('config')

    let gemini: GeminiLiveSession | null = null
    let streamSid: string | null = null
    let callSid: string | null = null
    let callerPhone: string | null = null
    let configData: Awaited<ReturnType<typeof getReceptionConfigById>> = null
    let callStart: number = Date.now()
    let transcript: string[] = []
    let escalated = false
    let takenMessage: string | undefined
    let greetingReady = false
    let callEnding = false
    let callerAudioReceived = false  // true only after real caller audio bytes arrive
    let callLeadId: string | undefined
    let callerUtterance = ''
    let latestCallerTurn = ''
    let aiSinceLastCaller = ''
    let leadCaptured = false
    let bookingOfferSpoken = false
    let appointmentBooked = false
    let verifiedSmsEmail: string | null = null
    let emailVerificationPolling = false
    let pricingLookupCompleted = false
    let transferTimer: ReturnType<typeof setTimeout> | null = null

    // Idle detection — prompt caller after silence, end call if no response
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const IDLE_WARN_MS = Number(process.env.CALLER_IDLE_CHECKIN_MS ?? 30_000)
    const IDLE_END_MS  = Number(process.env.CALLER_IDLE_CLOSE_MS ?? 60_000)
    const SPEECH_RMS_THRESHOLD = Number(process.env.CALLER_SPEECH_RMS_THRESHOLD ?? 350)

    function clearIdle() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    }

    function scheduleIdle() {
      clearIdle()
      idleTimer = setTimeout(() => {
        if (callEnding) return
        gemini?.sendText('The caller has been silent. Briefly ask if they are still there, then wait without ending the call.')
        idleTimer = setTimeout(() => {
          if (callEnding) return
          gemini?.sendText('The caller has remained silent after a check-in. Say a warm goodbye, invite them to call back anytime, then use the end_call tool.')
        }, IDLE_END_MS)
      }, IDLE_WARN_MS)
    }

    // Twilio keepalive — send mark event every 30s to prevent 60s WebSocket timeout
    let twilioKeepalive: ReturnType<typeof setInterval> | null = null

    function startTwilioKeepalive() {
      twilioKeepalive = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN || !streamSid || callEnding) return
        ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'keepalive' } }))
      }, 30_000)
    }

    function stopAll() {
      clearIdle()
      if (transferTimer) { clearTimeout(transferTimer); transferTimer = null }
      if (twilioKeepalive) { clearInterval(twilioKeepalive); twilioKeepalive = null }
    }

    ws.on('message', async (raw: Buffer) => {
      let msg: any
      try { msg = JSON.parse(raw.toString()) } catch { return }

      switch (msg.event) {
        case 'connected':
          console.log(`[Relay] Twilio connected — config: ${configId}`)
          break

        case 'start': {
          streamSid   = msg.start?.streamSid ?? null
          callSid     = msg.start?.callSid ?? null
          callerPhone = normalizeCallerPhone(msg.start?.customParameters?.caller ?? null)
          if (!configId) configId = msg.start?.customParameters?.config ?? null

          if (!configId) {
            console.error('[Relay] No configId in start event — missing <Parameter name="config">')
            ws.close()
            return
          }

          callStart = Date.now()
          transcript = []
          escalated = false
          takenMessage = undefined
          greetingReady = false
          callEnding = false

          const streamParams = msg.start?.customParameters ?? {}
          const inProcessMeta = callSid ? callMeta.get(callSid) : undefined
          const meta = inProcessMeta ?? (streamParams.outbound === '1' ? {
            configId,
            isOutbound: true,
            leadName: streamParams.leadName || undefined,
            demoUrl: streamParams.demoUrl || undefined,
            triggerType: streamParams.triggerType || undefined,
          } : undefined)

          // Callbacks defined here — reference outer let-variables by closure
          const callbacks = {
            onReady: async () => {
              console.log(`[Relay] Gemini ready — ${configData!.business_name}`)

              // Start call recording via Twilio REST API (works with Media Streams)
              const sid  = process.env.TWILIO_ACCOUNT_SID
              const auth = process.env.TWILIO_AUTH_TOKEN
              if (sid && auth && callSid) {
                fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callSid}/Recordings.json`, {
                  method:  'POST',
                  headers: {
                    Authorization:  `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                  },
                  body: 'RecordingChannels=dual',
                }).then(r => {
                  if (r.ok) console.log('[Relay] Recording started')
                  else r.json().then((e: any) => console.warn('[Relay] Recording start failed:', e?.message))
                }).catch(e => console.warn('[Relay] Recording start error:', e.message))
              }

              let greeting: string
              if (meta?.isOutbound) {
                const nameCtx  = meta.leadName ? ` You're calling ${meta.leadName}.` : ''
                const demoCtx  = meta.demoUrl  ? ` Their demo site is at ${meta.demoUrl}.` : ''
                const trigCtx  = meta.triggerType === 'email_click' ? ' They clicked our email, so they showed interest.'
                               : meta.triggerType === 'sms_reply'   ? ' They replied to our SMS, so they showed interest.'
                               : meta.triggerType === 'form_submit' ? ' They just submitted our contact form.'
                               : ''
                greeting = `You just placed an outbound call.${nameCtx}${demoCtx}${trigCtx} Introduce yourself warmly as an AI assistant from ${configData!.business_name}, mention you're following up on their interest, and ask how you can help. Keep it natural and brief.`
              } else {
                // Caller heard "Hi there! Please hold for just a moment." via Twilio Say — don't repeat it
                const phoneCtx = callerPhone ? ` Caller ID from Twilio: ${callerPhone}. Treat it as the callback number, but confirm it with the caller before using it.` : ''
                const history = callerPhone ? await getRecentCallerContext(callerPhone, configData!.id) : ''
                const memoryCtx = history ? ` Previous conversation context (use only to avoid repeating questions; confirm anything important):\n${history}` : ' No previous conversation is available.'
                greeting = `[CALL CONNECTED] Say your opening line NOW. Wait for their response before doing anything else.${phoneCtx}${memoryCtx}`
              }
              gemini?.sendText(greeting)
              // 800ms gate: enough for Gemini's first audio chunk before forwarding caller audio
              setTimeout(() => { greetingReady = true }, 800)
              // Start Twilio keepalive immediately; delay idle detection so the
              // opening question has time to finish playing.
              startTwilioKeepalive()
              setTimeout(() => scheduleIdle(), 12_000)
            },

            onClose:    () => console.log(`[Relay] Gemini closed`),
            onError:    (e: Error) => console.error(`[Relay] Gemini error: ${e.message}`),
            onText:     (text: string) => {
              aiSinceLastCaller += text
              if (leadCaptured && /(?:free\s+)?15[ -]?minute|schedule (?:a )?(?:call|demo)|book (?:a )?(?:call|demo)/i.test(aiSinceLastCaller)) {
                bookingOfferSpoken = true
              }
              transcript.push(`AI: ${text}`)
            },
            onInputText: (text: string) => {
              callerUtterance += text
              latestCallerTurn = text.trim()
              aiSinceLastCaller = ''
              transcript.push(`Caller: ${text}`)
              if (transferTimer && /^(?:no|nope|cancel|don't|do not|never mind|nevermind)\b/i.test(latestCallerTurn)) {
                clearTimeout(transferTimer)
                transferTimer = null
                escalated = false
                gemini?.sendText('The caller cancelled the transfer. Acknowledge that briefly, continue helping, and do not end the call.')
              }
            },
            onInterrupted: () => {
              if (ws.readyState === WebSocket.OPEN && streamSid) {
                // Drop audio Twilio already buffered from the interrupted AI
                // turn so the caller is heard immediately.
                ws.send(JSON.stringify({ event: 'clear', streamSid }))
              }
            },

            onAudio: (pcm24Base64: string) => {
              if (ws.readyState !== WebSocket.OPEN || !streamSid || callEnding) return
              const mulaw = geminiToTwilioAudio(pcm24Base64)
              ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: mulaw } }))
            },

            onToolCall: async (name: string, args: Record<string, unknown>, callId: string) => {
              console.log(`[Relay] Tool: ${name}`, args)

              if (name === 'get_webcrew_pricing') {
                pricingLookupCompleted = true
                gemini?.respondToTool(callId, name, {
                  success: true,
                  currency: 'USD',
                  plans: [
                    { name: 'Starter', monthly: 49, includes: ['custom mobile-ready website', 'hosting, SSL, and performance maintenance', 'custom domain connection', 'instant lead SMS and email alerts', 'weekly Google Business Profile posts', 'Google review reply assistance', 'monthly search performance report'], excludes: ['AI phone receptionist', 'AI appointment booking'] },
                    { name: 'Growth', monthly: 99, includes: ['everything in Starter', '24/7 AI phone receptionist', 'lead qualification', 'appointment booking', 'call recording, transcripts, and summaries', 'up to 100 AI voice minutes per month', 'SMS automation and missed-call recovery'] },
                  ],
                  cancellation: 'Month-to-month; cancel anytime.',
                  founderProgram: 'For the first 10 paying customers, the locked founding rate is $69/month for the Growth plan (not open negotiation below that). Use build_founder_offer to confirm scope, but do not quote or accept anything under $69/month for Growth.',
                  commercialPolicy: 'Negotiation is allowed only through build_founder_offer, and only at or above the $69/month founding floor for Growth. Never invent a price, usage allowance, discount, or permanent rate, and never go below the floor.',
                  speakingInstruction: 'State that $99/month is the standard Growth plan; founding members (first 10) lock in $69/month for life. Starter is $49/month but does not include AI reception or booking.',
                })
                return
              }

              if (name === 'build_founder_offer') {
                pricingLookupCompleted = true
                const requested = Number((args as any).comfortable_monthly_budget)
                if (!Number.isFinite(requested) || requested <= 0) {
                  gemini?.respondToTool(callId, name, { success: false, message: 'Ask what monthly amount in US dollars would feel comfortable, then try again.' })
                  return
                }

                const common = ['24/7 AI phone receptionist', 'lead capture and qualification', 'appointment booking', 'call recording, transcript, and summary']
                // Founding Growth Pilot floor is $69/mo — the locked founding rate for the
                // all-inclusive bundle (hosting + GBP + reviews + AI reception + booking + SMS).
                // Below that, only the phone-only Voice Pilot is available.
                const offer = requested >= 99
                  ? { name: 'Growth', monthly: 99, voiceMinutes: 100, estimatedCogsCeiling: 9, includes: ['everything in Starter', ...common], excludes: [] }
                  : requested >= 69
                    ? { name: 'Founding Growth Pilot', monthly: Math.floor(requested), voiceMinutes: 100, estimatedCogsCeiling: 9, includes: ['custom mobile-ready website and hosting', ...common, 'SMS and email lead alerts', 'weekly Google Business Profile posts', 'Google review reply assistance'], excludes: ['advertising management'] }
                    : requested >= 59
                      ? { name: 'Founding Voice Pilot', monthly: Math.floor(requested), voiceMinutes: 25, estimatedCogsCeiling: 5.5, includes: common, excludes: ['website build and hosting', 'marketing content', 'advertising management'] }
                      : { name: 'Founding Voice Pilot', monthly: 59, voiceMinutes: 25, estimatedCogsCeiling: 5.5, includes: common, excludes: ['website build and hosting', 'marketing content', 'advertising management'] }

                const marginTarget = Math.round((1 - offer.estimatedCogsCeiling / offer.monthly) * 100)
                gemini?.respondToTool(callId, name, {
                  success: true,
                  firstTenCustomersOnly: true,
                  offer: { ...offer, currency: 'USD', billing: 'monthly', cancelAnytime: true, pilotDays: 60, estimatedGrossMarginTarget: `${marginTarget}% or better within the included usage` },
                  terms: `Founding pilot for 60 days. Included voice usage is ${offer.voiceMinutes} minutes per month. Usage and scope are reviewed before renewal; no price or scope changes without the customer's agreement. Additional usage requires a separately confirmed upgrade or overage agreement.`,
                  nextStep: 'Explain how the smaller scope fits their stated budget, ask whether this feels workable, and handle one objection at a time. If they agree, capture complete lead details and book a free onboarding call. Do not claim enrollment or payment is complete.',
                })
                return
              }

              if (name === 'escalate_to_human') {
                const a = args as any
                const ownerPhone = configData?.brain?.owner_phone
                if (a.caller_confirmed_transfer !== true || !/\b(?:yes|yeah|yep|please|connect|transfer|human|person|someone)\b/i.test(latestCallerTurn)) {
                  gemini?.respondToTool(callId, name, { success: false, message: 'Ask whether the caller wants to be transferred now and wait for an explicit yes before trying again.' })
                  return
                }
                if (/pric|cost|discount|negotiat|lowest|cheapest/i.test(String(a.reason ?? '')) && !pricingLookupCompleted) {
                  gemini?.respondToTool(callId, name, { success: false, message: 'First call get_webcrew_pricing and answer the pricing question accurately. Then offer a team call if they want custom commercial help.' })
                  return
                }
                if (!ownerPhone || !callSid) {
                  await notifyOwner('escalation', args as any, configData!, callerPhone)
                  gemini?.respondToTool(callId, name, { success: false, message: 'Live transfer is unavailable. Do not say the caller is being connected and do not end the call. Apologize briefly, offer to take their details and arrange a free 15-minute team call.' })
                  return
                }
                escalated = true
                transcript.push(`[ESCALATION] ${(args as any).reason ?? ''}`)
                await notifyOwner('escalation', args as any, configData!, callerPhone)
                gemini?.respondToTool(callId, name, {
                  success: true,
                  message: 'I\'m connecting you to a team member now. Please hold for just a moment.',
                })
                transferTimer = setTimeout(() => {
                  transferTimer = null
                  void liveTransfer(callSid!, ownerPhone)
                }, 4000)
                return
              }

              if (name === 'take_message') {
                // Block fake take_message calls before caller has spoken
                if (!callerAudioReceived && (Date.now() - callStart) < 20_000) {
                  console.log('[Relay] take_message BLOCKED — caller has not spoken yet')
                  gemini?.respondToTool(callId, name, {
                    success: false,
                    message: 'The caller is still on the line and has not spoken yet. Continue the conversation — ask your opening question and wait for their reply.',
                  })
                  return
                }
                const a = args as any
                const email = (verifiedSmsEmail ?? String(a.caller_email ?? '')).trim()
                if (!isValidEmail(email)) {
                  console.log(`[Relay] take_message BLOCKED — invalid email: ${email || 'missing'}`)
                  gemini?.respondToTool(callId, name, {
                    success: false,
                    message: 'The email is incomplete or invalid. Ask the caller for the full address including the domain (for example, name at gmail dot com), spell the complete address back, and wait for confirmation before trying again.',
                  })
                  return
                }
                if (!verifiedSmsEmail && a.email_confirmed !== true) {
                  console.log('[Relay] take_message BLOCKED — email was not confirmed')
                  gemini?.respondToTool(callId, name, {
                    success: false,
                    message: 'Spell the complete email address back to the caller, including at and the domain, and wait for an explicit confirmation before trying again with email_confirmed=true.',
                  })
                  return
                }
                if (a.business_name_confirmed !== true || !String(a.business_name ?? '').trim()) {
                  console.log('[Relay] take_message BLOCKED — business name was not confirmed')
                  gemini?.respondToTool(callId, name, {
                    success: false,
                    message: 'Ask for the actual business name and wait for the caller to confirm it. Do not invent a generic name from their industry. Then try again with business_name_confirmed=true.',
                  })
                  return
                }
                if (String(a.appointment_intent ?? '').toLowerCase() === 'booked' && !appointmentBooked) {
                  console.log('[Relay] take_message BLOCKED — appointment marked booked without a booking')
                  gemini?.respondToTool(callId, name, {
                    success: false,
                    message: 'No appointment has been booked. Use appointment_intent="wants_to_book" or "not_decided" as accurate. Only a successful book_appointment tool call creates a booking.',
                  })
                  return
                }
                if (a.sms_consent_answered !== true) {
                  console.log('[Relay] take_message BLOCKED — SMS consent question not answered')
                  gemini?.respondToTool(callId, name, {
                    success: false,
                    message: 'You have not completed the SMS consent question. Read the required disclosure, wait for a clear yes or no, then try again with sms_consent_answered=true.',
                  })
                  return
                }
                takenMessage = a.message ?? ''
                transcript.push(`[MESSAGE] ${takenMessage}`)
                callLeadId = await upsertReceptionLead({
                  caller: callerPhone ?? a.caller_phone ?? '',
                  name: a.caller_name ?? '',
                  email,
                  niche: a.niche ?? a.industry,
                  configId: configData!.id,
                  notes: takenMessage,
                  smsConsent: a.sms_consent === true,
                }) ?? undefined
                await notifyOwner('message', a, configData!, callerPhone)

                // Send confirmation SMS + email to caller
                const destPhone = a.caller_phone ?? callerPhone
                const destEmail = email
                const callerName = a.caller_name ?? 'there'
                let smsSent = false, emailSent = false

                if (destPhone && a.sms_consent === true) smsSent = await sendCallerConfirmationSMS(destPhone, callerName)
                if (destEmail) emailSent = await sendCallerConfirmationEmail(destEmail, callerName)

                console.log(`[Relay] Caller confirmations — SMS: ${smsSent}, Email: ${emailSent}`)
                leadCaptured = true

                gemini?.respondToTool(callId, name, {
                  success: true,
                  smsSent,
                  emailSent,
                  nextStep: `Lead recorded. SMS sent: ${smsSent}. Email sent: ${emailSent}. Never claim an unsent confirmation. Now: (1) briefly confirm only what actually succeeded; (2) offer a free 15-minute call with the WebCrew team and use check_availability if accepted; (3) ask exactly "Before we wrap up, is there anything else I can help you with today?" and WAIT; (4) answer any questions; (5) only after the caller clearly says no, done, or goodbye, give the professional closing and call end_call with caller_confirmed_done=true.`,
                })
              }

              if (name === 'verify_email_by_sms') {
                const a = args as any
                const phone = normalizeCallerPhone(String(a.caller_phone ?? callerPhone ?? ''))
                if (a.sms_consent_confirmed !== true || !phone || !callSid || !configData) {
                  gemini?.respondToTool(callId, name, {
                    success: false,
                    message: 'Explicit SMS consent and a valid caller phone are required. Ask the consent disclosure and wait for yes before trying again.',
                  })
                  return
                }
                const sent = await sendEmailVerificationSMS(phone)
                if (!sent) {
                  gemini?.respondToTool(callId, name, { success: false, message: 'The verification text could not be sent. Collect and confirm the email by voice instead.' })
                  return
                }
                await startEmailVerification(phone, callSid, configData.id)
                gemini?.respondToTool(callId, name, {
                  success: true,
                  message: 'Verification text sent. Ask the caller to reply to that text with their complete email address while staying on the call.',
                })
                if (!emailVerificationPolling) {
                  emailVerificationPolling = true
                  void waitForVerifiedEmail(callSid, 90_000).then(email => {
                    emailVerificationPolling = false
                    if (!email || callEnding) return
                    verifiedSmsEmail = email
                    gemini?.sendText(`The caller replied by SMS with the verified email ${email}. Tell them you received it and repeat it once for confirmation. Use this exact address in take_message; email_confirmed may be true because the SMS reply proves ownership.`)
                  })
                }
              }

              if (name === 'check_availability') {
                console.log(`[Relay] Checking Cal.com availability`)
                const result = await getAvailableSlots(CAL_EVENT_TYPE_ID, CAL_TIMEZONE)
                if (result.error || result.slots.length === 0) {
                  gemini?.respondToTool(callId, name, {
                    success: false,
                    message: result.error ?? 'No available slots found in the next 5 days.',
                    slots:   [],
                  })
                } else {
                  const slotList = result.slots.map((s, i) => `${i + 1}. ${s.label}`).join('\n')
                  gemini?.respondToTool(callId, name, {
                    success: true,
                    message: `Here are the next available slots (${result.timezone}):`,
                    slots:   result.slots,
                    slotList,
                  })
                }
              }

              if (name === 'end_call') {
                // Block premature hang-ups before any real conversation
                if (!callerAudioReceived && (Date.now() - callStart) < 20_000) {
                  console.log('[Relay] end_call BLOCKED — caller has not spoken yet')
                  gemini?.respondToTool(callId, name, {
                    success: false,
                    message: 'Do not end the call yet — the caller is still there. Ask your opening question and wait for their response.',
                  })
                  return
                }
                const a = args as any
                const reason = String(a.reason ?? '').toLowerCase()
                const systemClose = /silence|robocall|spam/.test(reason)
                const confirmedDone = a.caller_confirmed_done === true && callerSaidDone(callerUtterance)
                if (!systemClose && !confirmedDone) {
                  console.log(`[Relay] end_call BLOCKED — caller has not confirmed they are done | last: ${callerUtterance}`)
                  gemini?.respondToTool(callId, name, {
                    success: false,
                    message: 'Do not end yet. Ask: "Before we wrap up, is there anything else I can help you with today?" Then wait. Only try end_call again after the caller clearly says no, done, nothing else, or goodbye.',
                  })
                  return
                }
                if (!systemClose && leadCaptured && !bookingOfferSpoken && !appointmentBooked) {
                  console.log('[Relay] end_call BLOCKED — required booking offer was skipped')
                  gemini?.respondToTool(callId, name, {
                    success: false,
                    message: 'Before ending, offer the caller a free 15-minute call with the WebCrew team and wait for their answer. If accepted, use check_availability. If declined, then continue to the closing.',
                  })
                  return
                }
                if (!systemClose && !closingWasSpoken(aiSinceLastCaller)) {
                  console.log('[Relay] end_call BLOCKED — professional closing was not spoken')
                  gemini?.respondToTool(callId, name, {
                    success: false,
                    message: 'Say exactly: "Thank you for calling WebCrew. We\'ve got your next step noted, and our team will follow up as discussed. Have a great day!" Then immediately call end_call again.',
                  })
                  return
                }
                console.log(`[Relay] Gemini ending call gracefully`)
                callEnding = true
                stopAll()
                setTimeout(async () => {
                  const sid  = process.env.TWILIO_ACCOUNT_SID
                  const auth = process.env.TWILIO_AUTH_TOKEN
                  if (sid && auth && callSid) {
                    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callSid}.json`, {
                      method:  'POST',
                      headers: {
                        Authorization:  `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                      },
                      body: 'Status=completed',
                    }).catch(e => console.error('[Relay] hangup failed:', e.message))
                  }
                }, 8000)  // 8s: enough for goodbye audio to fully play before hangup
              }

              if (name === 'book_appointment') {
                const a = args as any
                console.log(`[Relay] Booking appointment for ${a.caller_name} at ${a.slot_time}`)
                const result = await createBooking({
                  eventTypeId: CAL_EVENT_TYPE_ID,
                  start:       a.slot_time,
                  name:        a.caller_name,
                  email:       a.caller_email,
                  phone:       a.caller_phone ?? callerPhone ?? undefined,
                  notes:       a.notes,
                  timezone:    CAL_TIMEZONE,
                })
                if (!result.ok) {
                  gemini?.respondToTool(callId, name, { success: false, error: result.error })
                } else {
                  appointmentBooked = true
                  transcript.push(`[BOOKING] ${a.caller_name} booked at ${result.start} | ID:${result.bookingId}`)
                  gemini?.respondToTool(callId, name, {
                    success:    true,
                    bookingId:  result.bookingId,
                    start:      result.start,
                    meetingUrl: result.meetingUrl,
                    message:    `Appointment confirmed for ${a.caller_name} at ${result.start}.`,
                  })
                }
              }
            },
          }

          // Try pre-warmed Gemini session (started in /voice handler while Twilio plays Say)
          const preWarm = callSid ? consumePending(callSid) : undefined
          if (preWarm) {
            try {
              const warm = await preWarm
              configData = warm.configData
              console.log(`[Relay] Pre-warmed session ready — ${configData.business_name} | caller: ${callerPhone ?? 'unknown'}`)
              gemini = warm.session
              gemini.setCallbacks(callbacks)
              // setCallbacks fires onReady immediately if already connected, else waits for onopen
            } catch (e: any) {
              console.error(`[Relay] Pre-warm failed: ${e.message} — falling back to fresh connect`)
            }
          }

          if (!gemini) {
            configData = await getReceptionConfigById(configId)
            if (!configData) {
              console.error(`[Relay] Config ${configId} not found`)
              ws.close()
              return
            }
            console.log(`[Relay] Call started (fresh connect) — ${configData.business_name} | caller: ${callerPhone ?? 'unknown'}`)
            gemini = new GeminiLiveSession(callbacks)
            try {
              await gemini.connect(configData.system_prompt, configData.website_url)
            } catch (e: any) {
              console.error(`[Relay] Gemini connect failed: ${e.message}`)
              ws.close()
            }
          }
          break
        }

        case 'media': {
          if (!gemini || !msg.media?.payload || !greetingReady) break
          const pcm16 = twilioToGeminiAudio(msg.media.payload)
          // Twilio sends media continuously, including silence. Only genuine
          // speech energy should keep an idle call alive.
          if (hasSpeechEnergy(pcm16, SPEECH_RMS_THRESHOLD)) {
            callerAudioReceived = true
            scheduleIdle()
          }
          gemini.sendAudio(pcm16)
          break
        }

        case 'stop': {
          stopAll()
          const durationSec = Math.round((Date.now() - callStart) / 1000)
          console.log(`[Relay] Call ended — ${durationSec}s | caller: ${callerPhone ?? 'unknown'}`)
          gemini?.close()
          gemini = null

          if (configId && configData) {
            insertCallLog({
              configId,
              leadId:      callLeadId ?? configData.lead_id,
              caller:      callerPhone,
              durationSec,
              transcript:  transcript.join('\n'),
              escalated,
              message:     takenMessage,
            }).catch(e => console.error('[Relay] call log write failed:', e.message))

            trackCallCostAndCap(configId, configData.business_name, callLeadId ?? configData.lead_id, configData.business_name, durationSec)
              .catch(e => console.error('[VoiceCap] tracking failed:', e.message))
          }
          break
        }
      }
    })

    ws.on('close', () => {
      stopAll()
      gemini?.close()
      gemini = null
    })

    ws.on('error', (e) => console.error(`[Relay] Twilio WS error: ${e.message}`))
  })
}

function hasSpeechEnergy(base64Pcm16: string, threshold: number): boolean {
  const pcm = Buffer.from(base64Pcm16, 'base64')
  if (pcm.length < 2) return false
  let sumSquares = 0
  const samples = Math.floor(pcm.length / 2)
  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2)
    sumSquares += sample * sample
  }
  return Math.sqrt(sumSquares / samples) >= threshold
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value)
}

function callerSaidDone(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim()
  return /\b(no|nope|done|goodbye|bye|nothing else|that's all|that is all|all good|thank you|thanks)\b/.test(normalized)
}

function closingWasSpoken(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim()
  return /thank you for calling webcrew/.test(normalized) && /have a (great|wonderful|good) day/.test(normalized)
}

// ─── Live transfer via Twilio call redirect ───────────────────────────────────

async function liveTransfer(callSid: string, ownerPhone: string) {
  const sid  = process.env.TWILIO_ACCOUNT_SID
  const auth = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !auth) return

  const transferUrl = `${BASE_URL}/transfer-twiml?to=${encodeURIComponent(ownerPhone)}`
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callSid}.json`, {
      method:  'POST',
      headers: {
        Authorization:  `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Url: transferUrl, Method: 'GET' }).toString(),
    })
    if (res.ok) {
      console.log(`[Relay] Live transfer → ${ownerPhone}`)
    } else {
      const err = await res.json() as any
      console.error(`[Relay] Live transfer failed: ${err.message}`)
    }
  } catch (e: any) {
    console.error(`[Relay] Live transfer error: ${e.message}`)
  }
}

// ─── Owner notifications — free (email via Resend + push via ntfy.sh) ────────
// No Twilio cost. Install ntfy app → subscribe to topic NTFY_TOPIC for push alerts.

async function notifyOwner(
  type: 'escalation' | 'message',
  args: { reason?: string; caller_name?: string; caller_phone?: string; caller_email?: string; message?: string },
  config: NonNullable<Awaited<ReturnType<typeof getReceptionConfigById>>>,
  callerPhone: string | null
) {
  const ownerEmail = process.env.OWNER_NOTIFY_EMAIL ?? 'ranjeetsinghai79@gmail.com'
  const ntfyTopic  = process.env.NTFY_TOPIC  // e.g. "webcrew-leads-xk92" — set in Cloud Run
  const resendKey  = process.env.RESEND_API_KEY
  const from       = process.env.OUTREACH_FROM_EMAIL ?? 'hello@webcrew.app'

  const isEscalation = type === 'escalation'
  const title = isEscalation
    ? `🚨 Escalation — ${config.business_name}`
    : `🔔 New Lead — ${args.caller_name ?? 'Unknown'} | ${config.business_name}`

  const lines: string[] = []
  if (isEscalation) {
    lines.push(`Caller needs human help immediately.`)
    if (args.reason)    lines.push(`Reason: ${args.reason}`)
    if (callerPhone)    lines.push(`Caller phone: ${callerPhone}`)
  } else {
    if (args.caller_name)  lines.push(`Name: ${args.caller_name}`)
    if (args.caller_phone || callerPhone) lines.push(`Phone: ${args.caller_phone ?? callerPhone}`)
    if (args.caller_email) lines.push(`Email: ${args.caller_email}`)
    if (args.message)      lines.push(`\nNotes: ${args.message}`)
  }
  const body = lines.join('\n')

  // 1. ntfy.sh push notification (free, instant to phone)
  if (ntfyTopic) {
    fetch(`https://ntfy.sh/${ntfyTopic}`, {
      method: 'POST',
      headers: { Title: title, Priority: isEscalation ? 'urgent' : 'default', Tags: isEscalation ? 'rotating_light' : 'bell' },
      body,
    }).then(r => r.ok ? console.log('[Relay] ntfy push sent') : console.warn('[Relay] ntfy push failed'))
      .catch(e => console.warn('[Relay] ntfy error:', e.message))
  }

  // 2. Resend email notification (free tier 3k/month)
  if (resendKey) {
    fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        from,
        to:      [ownerEmail],
        subject: title,
        text:    body,
      }),
    }).then(r => r.ok ? console.log(`[Relay] Owner email sent to ${ownerEmail}`) : console.warn('[Relay] Owner email failed'))
      .catch(e => console.warn('[Relay] Owner email error:', e.message))
  } else {
    console.warn('[Relay] Owner notification skipped — RESEND_API_KEY not set')
  }
}

// ─── Caller confirmation SMS ──────────────────────────────────────────────────

async function sendCallerConfirmationSMS(toPhone: string, callerName: string): Promise<boolean> {
  const sid  = process.env.TWILIO_ACCOUNT_SID
  const auth = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_PHONE_NUMBER
  if (!sid || !auth || !from) { console.warn('[Relay] Caller SMS skipped — Twilio creds missing'); return false }

  const body = `Hi ${callerName}, this is WebCrew. Thanks for speaking with our AI receptionist — we've saved your request and next steps. Reply here anytime with questions. Reply STOP to opt out or HELP for help. – WebCrew Team`
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method:  'POST',
      headers: {
        Authorization:  `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: from, To: toPhone, Body: body }).toString(),
    })
    if (res.ok) { console.log(`[Relay] Caller SMS sent to ${toPhone}`); return true }
    const e = await res.json() as any
    console.warn(`[Relay] Caller SMS failed: ${e?.message}`)
    return false
  } catch (e: any) {
    console.warn(`[Relay] Caller SMS error: ${e.message}`)
    return false
  }
}

async function sendEmailVerificationSMS(toPhone: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const auth = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_PHONE_NUMBER
  if (!sid || !auth || !from) return false
  const body = 'Hi, this is WebCrew. Please reply to this text with your complete email address so our receptionist can verify it while you are on the call. Reply STOP to opt out. – WebCrew'
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: from, To: toPhone, Body: body }).toString(),
  }).catch(() => null)
  if (!res?.ok) console.warn('[Relay] Email verification SMS failed')
  return res?.ok === true
}

async function waitForVerifiedEmail(callSid: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const email = await getVerifiedEmail(callSid).catch(() => null)
    if (email) return email
    await new Promise(resolve => setTimeout(resolve, 1_500))
  }
  return null
}

// ─── Caller confirmation email ────────────────────────────────────────────────

async function sendCallerConfirmationEmail(toEmail: string, callerName: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY
  const from = process.env.OUTREACH_FROM_EMAIL ?? 'hello@webcrew.app'
  if (!key) { console.warn('[Relay] Email confirmation skipped — RESEND_API_KEY missing'); return false }

  const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0a0a0a;color:#fff;padding:40px 20px;">
<div style="max-width:520px;margin:0 auto;background:#111827;border-radius:12px;padding:32px 36px;border:1px solid rgba(255,255,255,0.08);">
  <p style="margin:0 0 8px;color:rgba(255,255,255,0.5);font-size:11px;letter-spacing:2px;text-transform:uppercase;">WebCrew</p>
  <h2 style="margin:0 0 20px;font-size:22px;font-weight:800;">We received your WebCrew request</h2>
  <p style="color:rgba(255,255,255,0.75);line-height:1.7;">Hey ${callerName},</p>
  <p style="color:rgba(255,255,255,0.75);line-height:1.7;">Thanks for speaking with our AI receptionist. We've saved your request and the next steps discussed on the call.</p>
  <p style="color:rgba(255,255,255,0.75);line-height:1.7;">A WebCrew team member will follow up to help with your business needs.</p>
  <p style="margin-top:28px;color:rgba(255,255,255,0.5);font-size:13px;">Questions? Reply to this email or text us at the number you just called.<br>— The WebCrew Team</p>
</div></body></html>`

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        from,
        to:      [toEmail],
        subject: 'We received your WebCrew request',
        html,
      }),
    })
    if (res.ok) { console.log(`[Relay] Confirmation email sent to ${toEmail}`); return true }
    const e = await res.json() as any
    console.warn(`[Relay] Confirmation email failed: ${e?.message}`)
    return false
  } catch (e: any) {
    console.warn(`[Relay] Confirmation email error: ${e.message}`)
    return false
  }
}
