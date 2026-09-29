import { EndSensitivity, GoogleGenAI, Modality, StartSensitivity, ThinkingLevel } from '@google/genai'
import { getAiStudioUsageToday, incrementAiStudioUsage } from './db.js'

// Gemini Live API via @google/genai SDK.
// Vertex AI backend uses Application Default Credentials (ADC) — automatic in Cloud Run.
// No API key or manual token management needed. Vertex has no free tier, so it is
// reserved for paying clients; demo/trial traffic routes through free AI Studio keys
// first and only falls back to Vertex when those are exhausted or fail outright —
// see buildChain/connect below. A phone call must never audibly fail because a free
// quota ran out; Vertex is the guaranteed last resort in every chain.
const PROJECT  = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT_ID ?? 'webcrew-501006'
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION ?? process.env.GCP_REGION ?? 'global'
// GA Vertex Live endpoint. The project must be entitled by Google;
// do not substitute a Gemini Developer API key when access is unavailable.
const VERTEX_MODEL = process.env.GEMINI_LIVE_MODEL_VERTEX ?? 'gemini-live-2.5-flash-native-audio'
// AI Studio's Live model catalog differs from Vertex's. Confirmed 2026-07-21 via
// ai.google.dev/gemini-api/docs/live-guide; re-verify if this ever fails to connect
// (see smoke-test-ai-studio-live.ts for a fast standalone check).
const AI_STUDIO_MODEL = process.env.GEMINI_LIVE_MODEL_AI_STUDIO ?? 'gemini-2.5-flash-native-audio-preview-12-2025'

// Best-effort daily cap per AI Studio key (Gemini 2.5 Flash free tier is 250 RPD as
// of 2026-07-21 — Live sessions may not count 1:1 against that, so this is a
// deliberately conservative proactive guard, not an authoritative limit). Once a
// key's tracked usage crosses this fraction of the cap, it's skipped in favor of
// the next candidate for the rest of the day.
const AI_STUDIO_DAILY_CAP    = Number(process.env.AI_STUDIO_DAILY_CAP ?? 250)
const AI_STUDIO_QUOTA_WARN_PCT = Number(process.env.AI_STUDIO_QUOTA_WARN_PCT ?? 0.9)

type Backend = 'vertex' | 'ai_studio'
interface Candidate { backend: Backend; keyName: string; apiKey?: string }

// Paying-client website_urls are never added to AI_STUDIO_BACKEND_WEBSITE_URLS, so
// they always get the vertex-only chain — that's the billing-safety guarantee.
function isDemoTraffic(websiteUrl: string): boolean {
  const normalize = (url: string) => url.trim().toLowerCase().replace(/\/+$/, '')
  const allowlist = (process.env.AI_STUDIO_BACKEND_WEBSITE_URLS ?? '')
    .split(',')
    .map(normalize)
    .filter(Boolean)
  return allowlist.includes(normalize(websiteUrl))
}

// Ordered list of backends to try for this call. Vertex always appears last as the
// guaranteed fallback — proactive quota skipping only ever reorders/removes the
// free AI Studio candidates that precede it, never removes Vertex itself.
async function buildChain(websiteUrl: string): Promise<Candidate[]> {
  if (!isDemoTraffic(websiteUrl)) return [{ backend: 'vertex', keyName: 'vertex' }]

  const keys: Array<{ keyName: string; apiKey?: string }> = [
    { keyName: 'ai_studio_primary', apiKey: process.env.GOOGLE_AI_API_KEY },
    { keyName: 'ai_studio_backup',  apiKey: process.env.GOOGLE_AI_STUDIO_WEBCREWAPI },
  ]

  const threshold = AI_STUDIO_DAILY_CAP * AI_STUDIO_QUOTA_WARN_PCT
  const aiStudioCandidates: Candidate[] = []
  for (const { keyName, apiKey } of keys) {
    if (!apiKey?.startsWith('AIza')) continue // key not configured — skip silently
    const usedToday = await getAiStudioUsageToday(keyName)
    if (usedToday >= threshold) {
      console.warn(`[Gemini] ${keyName} at ${usedToday}/${AI_STUDIO_DAILY_CAP} today (>=${Math.round(AI_STUDIO_QUOTA_WARN_PCT * 100)}%) — skipping in favor of next backend`)
      continue
    }
    aiStudioCandidates.push({ backend: 'ai_studio', keyName, apiKey })
  }
  return [...aiStudioCandidates, { backend: 'vertex', keyName: 'vertex' }]
}

function makeClient(candidate: Candidate) {
  if (candidate.backend === 'ai_studio') {
    if (!candidate.apiKey?.startsWith('AIza')) {
      throw new Error(`${candidate.keyName} missing or malformed — cannot use ai_studio backend`)
    }
    return new GoogleGenAI({ apiKey: candidate.apiKey })
  }
  return new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION })
}

export interface GeminiLiveCallbacks {
  onReady: () => void
  onAudio: (base64Pcm24kHz: string) => void
  onText?: (text: string) => void
  onInputText?: (text: string) => void
  onInterrupted?: () => void
  onToolCall: (name: string, args: Record<string, unknown>, callId: string) => void
  onError: (err: Error) => void
  onClose: () => void
}

export class GeminiLiveSession {
  private session: Awaited<ReturnType<typeof GoogleGenAI.prototype.live.connect>> | null = null
  private callbacks: GeminiLiveCallbacks
  private _ready = false
  private attemptSeq = 0

  get isReady() { return this._ready }

  constructor(callbacks: GeminiLiveCallbacks) {
    this.callbacks = callbacks
  }

  // Swap in real callbacks after pre-warm. If already ready, fires onReady immediately.
  setCallbacks(callbacks: GeminiLiveCallbacks) {
    this.callbacks = callbacks
    if (this._ready) setTimeout(() => callbacks.onReady(), 0)
  }

  // Tries each backend in the chain in order (free AI Studio keys first, Vertex
  // last) until one connects. A call should never audibly fail just because a free
  // quota ran out — Vertex is always the final, guaranteed-to-work candidate.
  async connect(systemPrompt: string, websiteUrl: string): Promise<void> {
    const chain = await buildChain(websiteUrl)
    let lastErr: unknown

    for (const candidate of chain) {
      try {
        await this.attemptConnect(candidate, systemPrompt)
        if (candidate.backend === 'ai_studio') {
          incrementAiStudioUsage(candidate.keyName).catch(e => console.warn('[Gemini] usage tracking failed:', e.message))
        }
        return
      } catch (err: any) {
        lastErr = err
        console.warn(`[Gemini] ${candidate.keyName} failed (${err.message}) — trying next backend`)
        this.close()
        this._ready = false
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('All Gemini Live backends failed')
  }

  private async attemptConnect(candidate: Candidate, systemPrompt: string): Promise<void> {
    const attemptId = ++this.attemptSeq
    const ai    = makeClient(candidate)
    const model = candidate.backend === 'ai_studio' ? AI_STUDIO_MODEL : VERTEX_MODEL
    console.log(`[Gemini] attempt backend=${candidate.backend} key=${candidate.keyName}${candidate.backend === 'vertex' ? ` project=${PROJECT} location=${LOCATION}` : ''} → ${model}`)

    const thinkingConfig = model.startsWith('gemini-3')
      ? { thinkingLevel: ThinkingLevel.MINIMAL, includeThoughts: false }
      : { thinkingBudget: 0, includeThoughts: false }

    // Set by onerror/onclose if this attempt dies before setupComplete — lets the
    // poll loop below fail fast instead of waiting out the full setup timeout.
    let setupFailure: Error | null = null

    this.session = await ai.live.connect({
      model,
      config: {
        responseModalities:  [Modality.AUDIO],
        // Phone conversations need immediate answers, not hidden multi-step
        // deliberation that leaves the caller listening to dead air.
        thinkingConfig,
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } },
        },
        systemInstruction: { parts: [{ text: systemPrompt }] },
        tools:             [{ functionDeclarations: TOOL_DECLARATIONS as any }],
        inputAudioTranscription:  {},
        outputAudioTranscription: {},
        // Keep the current objective and recent turns available during long
        // calls without allowing conversation history to exhaust the context.
        contextWindowCompression: {
          triggerTokens: '20000',
          slidingWindow: { targetTokens: '12000' },
        },
        // Server-side VAD retains a pre-speech buffer and is substantially more
        // robust to phone noise than the relay's former RMS/manual endpointing.
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
            prefixPaddingMs: 80,
            silenceDurationMs: 800,
          },
        },
      },
      callbacks: {
        onopen: () => {
          if (attemptId !== this.attemptSeq) return
          console.log(`[Gemini] Connected — ${model}`)
        },
        onmessage: (msg: any) => {
          if (attemptId !== this.attemptSeq) return // stray message from an abandoned attempt
          try {
            this.handle(msg)
          } catch (err: any) {
            console.warn('[Gemini] handle error:', err.message)
          }
        },
        onerror: (e: any) => {
          if (attemptId !== this.attemptSeq) return
          const err = new Error(e?.error?.message ?? e?.message ?? 'Gemini WS error')
          console.error('[Gemini] error:', err.message)
          if (this._ready) {
            // Mid-call failure on the winning session — propagate as before.
            this.callbacks.onError(err)
          } else {
            // Failed during setup — let the poll loop below fail fast and move
            // connect() on to the next backend in the chain.
            setupFailure = err
          }
        },
        onclose: (e: any) => {
          if (attemptId !== this.attemptSeq) return
          console.log(`[Gemini] closed — code: ${e?.code}, reason: ${e?.reason ?? ''}`)
          if (this._ready) {
            this.callbacks.onClose()
          } else {
            setupFailure = setupFailure ?? new Error(`closed before setup, code: ${e?.code}`)
          }
        },
      },
    })

    // A WebSocket open is not a usable Gemini session. Wait for setupComplete
    // so callers never sit on a connected-but-unsupported model endpoint.
    const setupDeadline = Date.now() + Number(process.env.GEMINI_SETUP_TIMEOUT_MS ?? 10_000)
    while (!this._ready && !setupFailure && Date.now() < setupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (setupFailure) throw setupFailure
    if (!this._ready) {
      throw new Error(`Gemini Live setup timed out for ${model} (backend=${candidate.backend}, key=${candidate.keyName})`)
    }
  }

  private handle(msg: any) {
    // The WebSocket opening only means the transport is connected. Gemini
    // cannot accept user input until it acknowledges the session setup.
    if (msg.setupComplete && !this._ready) {
      this._ready = true
      console.log('[Gemini] Session setup complete')
      this.callbacks.onReady()
    }

    const serverContent = msg.serverContent
    const parts = serverContent?.modelTurn?.parts ?? []
    for (const part of parts) {
      const data = part.inlineData?.data
      const mime = part.inlineData?.mimeType ?? ''
      if (data && mime.startsWith('audio/pcm')) this.callbacks.onAudio(data)
    }

    // Store what was actually spoken, not model thought/planning parts.
    const spokenText = serverContent?.outputTranscription?.text
    if (spokenText && this.callbacks.onText) this.callbacks.onText(spokenText)
    const callerText = serverContent?.inputTranscription?.text
    if (callerText && this.callbacks.onInputText) this.callbacks.onInputText(callerText)
    if (serverContent?.interrupted && this.callbacks.onInterrupted) this.callbacks.onInterrupted()

    const functionCalls = msg.toolCall?.functionCalls ?? []
    for (const fc of functionCalls) {
      this.callbacks.onToolCall(fc.name, fc.args ?? {}, fc.id)
    }
  }

  sendText(text: string) {
    this.session?.sendRealtimeInput({ text } as any)
  }

  sendAudio(base64Pcm16kHz: string) {
    this.session?.sendRealtimeInput({
      audio: { data: base64Pcm16kHz, mimeType: 'audio/pcm;rate=16000' },
    } as any)
  }

  startActivity() {
    this.session?.sendRealtimeInput({ activityStart: {} } as any)
  }

  endActivity() {
    this.session?.sendRealtimeInput({ activityEnd: {} } as any)
  }

  respondToTool(callId: string, name: string, output: unknown) {
    try {
      this.session?.sendToolResponse({
        functionResponses: [{ id: callId, name, response: { output } }],
      } as any)
    } catch (e: any) {
      console.error('[Gemini] sendToolResponse failed:', e.message)
    }
  }

  close() {
    try { (this.session as any)?.close?.() } catch { /* ignore */ }
    this.session = null
  }
}

// ── Tool declarations ─────────────────────────────────────────────────────────

const TOOL_DECLARATIONS = [
  {
    name: 'get_webcrew_pricing',
    description: 'Get the current authoritative WebCrew plan prices and inclusions. MUST be called before answering any question about price, cost, discounts, negotiation, or the lowest plan.',
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
  {
    name: 'build_founder_offer',
    description: 'Build an approved first-10-customer offer from the monthly budget stated by the caller. MUST be called after a caller gives a comfortable monthly amount or asks for a discount. Never invent a negotiated price or scope without this tool.',
    parameters: {
      type: 'OBJECT',
      properties: {
        comfortable_monthly_budget: { type: 'NUMBER', description: 'The monthly USD amount the caller said they can comfortably afford' },
        primary_need: { type: 'STRING', description: 'Their main requested outcome, such as AI call answering and booking' },
      },
      required: ['comfortable_monthly_budget', 'primary_need'],
    },
  },
  {
    name: 'escalate_to_human',
    description: 'Transfer the call only after offering a human handoff and the caller explicitly confirms they want the transfer now.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reason: { type: 'STRING', description: 'Brief reason for escalation' },
        caller_confirmed_transfer: { type: 'BOOLEAN', description: 'True only when the caller explicitly said yes to being transferred now' },
      },
      required: ['reason', 'caller_confirmed_transfer'],
    },
  },
  {
    name: 'verify_email_by_sms',
    description: 'After explicit SMS consent, send the caller a verification text and ask them to reply with their complete email while remaining on the call. Prefer this over voice spelling for accurate lead capture.',
    parameters: {
      type: 'OBJECT',
      properties: {
        caller_phone: { type: 'STRING', description: 'Confirmed caller mobile number' },
        sms_consent_confirmed: { type: 'BOOLEAN', description: 'True only after the caller heard the SMS disclosure and explicitly agreed' },
      },
      required: ['caller_phone', 'sms_consent_confirmed'],
    },
  },
  {
    name: 'take_message',
    description: 'Record lead info from a caller who has SPOKEN and provided their details. ONLY call after real two-way conversation. Never call before the caller responds to your greeting.',
    parameters: {
      type: 'OBJECT',
      properties: {
        caller_name:  { type: 'STRING', description: "Caller's full name (must be provided by caller)" },
        caller_phone: { type: 'STRING', description: "Caller's callback number" },
        caller_email: { type: 'STRING', description: "Caller's complete, confirmed email address including domain" },
        email_confirmed: { type: 'BOOLEAN', description: 'True only after the assistant spelled the full email back and the caller explicitly confirmed it' },
        business_name: { type: 'STRING', description: "Caller's confirmed business name" },
        business_name_confirmed: { type: 'BOOLEAN', description: 'True only after the caller provided or explicitly confirmed the actual business name; an industry label is not a business name' },
        industry: { type: 'STRING', description: "Caller's industry or business category" },
        city: { type: 'STRING', description: "Primary city or service area" },
        pain_point: { type: 'STRING', description: 'The real problem stated by the caller, without assumptions' },
        recommended_solution: { type: 'STRING', description: 'The WebCrew solution discussed and accepted as relevant' },
        appointment_intent: { type: 'STRING', description: 'Accurate status: wants_to_book, declined, not_decided, or booked. Never use booked before book_appointment succeeds.' },
        sms_consent:  { type: 'BOOLEAN', description: 'Caller explicitly said yes to receiving a confirmation SMS at the caller phone number' },
        sms_consent_answered: { type: 'BOOLEAN', description: 'True only after the caller heard the SMS disclosure and clearly answered yes or no' },
        message:      { type: 'STRING', description: 'Accurate summary of business, location, pain point, solution, next action, appointment intent, and notes' },
      },
      required: ['caller_name', 'caller_email', 'email_confirmed', 'business_name', 'business_name_confirmed', 'industry', 'pain_point', 'recommended_solution', 'appointment_intent', 'sms_consent', 'sms_consent_answered', 'message'],
    },
  },
  {
    name: 'end_call',
    description: 'End the call after saying a proper goodbye. ONLY use when: caller says goodbye/thanks/done, issue is fully resolved, or after confirming a booking. NEVER call this before the caller has responded to your greeting.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reason: { type: 'STRING', description: 'brief reason (resolved, booked, escalated, etc.)' },
        caller_confirmed_done: { type: 'BOOLEAN', description: 'True only when the caller explicitly said they need nothing else, are finished, or said goodbye' },
      },
      required: ['caller_confirmed_done'],
    },
  },
  {
    name: 'check_availability',
    description: 'Check available appointment slots for the next 5 business days. Call this when a caller wants to book an appointment.',
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
  {
    name: 'book_appointment',
    description: 'Book an appointment for the caller. Only call after confirming the time slot with the caller.',
    parameters: {
      type: 'OBJECT',
      properties: {
        caller_name:  { type: 'STRING', description: "Caller's full name" },
        caller_email: { type: 'STRING', description: "Caller's email address" },
        caller_phone: { type: 'STRING', description: "Caller's phone number" },
        slot_time:    { type: 'STRING', description: 'ISO datetime of the selected slot (from check_availability results)' },
        notes:        { type: 'STRING', description: 'Any special notes or reason for appointment' },
      },
      required: ['caller_name', 'caller_email', 'slot_time'],
    },
  },
]
