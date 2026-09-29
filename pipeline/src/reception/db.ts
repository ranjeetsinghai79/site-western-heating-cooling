import pg from 'pg'
import type { ReceptionConfig, BusinessBrain } from './types.js'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

export async function saveReceptionConfig(
  websiteUrl: string,
  businessName: string,
  brain: BusinessBrain,
  systemPrompt: string,
  leadId?: string
): Promise<ReceptionConfig> {
  const { rows } = await pool.query(
    `INSERT INTO reception_configs (website_url, business_name, brain_json, system_prompt, lead_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (website_url) DO UPDATE SET
       business_name  = EXCLUDED.business_name,
       brain_json     = EXCLUDED.brain_json,
       system_prompt  = EXCLUDED.system_prompt,
       updated_at     = NOW()
     RETURNING *`,
    [websiteUrl, businessName, JSON.stringify(brain), systemPrompt, leadId ?? null]
  )
  return rowToConfig(rows[0])
}

export async function getReceptionConfig(websiteUrl: string): Promise<ReceptionConfig | null> {
  const { rows } = await pool.query(
    `SELECT * FROM reception_configs WHERE website_url = $1 AND active = true LIMIT 1`,
    [websiteUrl]
  )
  return rows[0] ? rowToConfig(rows[0]) : null
}

export async function getReceptionConfigById(id: string): Promise<ReceptionConfig | null> {
  const { rows } = await pool.query(
    `SELECT * FROM reception_configs WHERE id = $1 LIMIT 1`,
    [id]
  )
  return rows[0] ? rowToConfig(rows[0]) : null
}

export async function listReceptionConfigs(): Promise<ReceptionConfig[]> {
  const { rows } = await pool.query(
    `SELECT * FROM reception_configs ORDER BY created_at DESC`
  )
  return rows.map(rowToConfig)
}

export async function updateTwilioPhone(id: string, phone: string): Promise<void> {
  await pool.query(
    `UPDATE reception_configs SET twilio_phone = $2, updated_at = NOW() WHERE id = $1`,
    [id, phone]
  )
}

/** Create or enrich a lead from a live WebCrew Reception test call. */
export async function upsertReceptionLead(opts: {
  caller: string
  name: string
  email?: string
  niche?: string
  configId: string
  notes?: string
  smsConsent?: boolean
}): Promise<string | null> {
  const digits = opts.caller.replace(/\D/g, '')
  if (digits.length < 10) return null
  const phone = `+1${digits.slice(-10)}`
  const placeId = `voice_${digits.slice(-10)}`
  try {
    const { rows } = await pool.query(
      `INSERT INTO leads (place_id, name, phone, email, niche, status, source, reception_config_id)
       VALUES ($1,$2,$3,$4,$5,'interested','ai_reception',$6)
       ON CONFLICT (phone) WHERE phone IS NOT NULL DO UPDATE SET
         name = CASE WHEN $2 <> '' THEN $2 ELSE leads.name END,
         phone = COALESCE(NULLIF($3,''), leads.phone),
         email = COALESCE(NULLIF($4,''), leads.email),
         niche = COALESCE(NULLIF($5,''), leads.niche),
         status = CASE WHEN leads.status IN ('paid','handed_off') THEN leads.status ELSE 'interested' END,
         reception_config_id = COALESCE($6, leads.reception_config_id),
         updated_at = NOW()
       RETURNING id`,
      [placeId, opts.name.trim() || 'WebCrew test caller', phone, opts.email?.trim() || null, opts.niche?.trim() || null, opts.configId]
    )
    const leadId = rows[0]?.id ?? null
    if (leadId) {
      await pool.query(
        `INSERT INTO lead_events (lead_id, event_type, detail) VALUES ($1,'reception_qualified',$2)`,
        [leadId, JSON.stringify({ phone, name: opts.name, email: opts.email ?? null, niche: opts.niche ?? null, notes: opts.notes ?? null })]
      ).catch(e => console.error('[DB] reception lead event failed:', e.message))
      if (opts.smsConsent === true) {
        await pool.query(
          `INSERT INTO consent_events (lead_id, channel, contact, consent_type, source, consent_text)
           SELECT $1,'sms',$2,'express_written','ai_reception',$3
           WHERE NOT EXISTS (SELECT 1 FROM consent_events WHERE channel='sms' AND contact=$2 AND revoked_at IS NULL)`,
          [leadId, phone, 'Caller verbally opted in to recurring WebCrew SMS updates. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe or HELP for help.']
        ).catch(e => console.error('[DB] reception SMS consent failed:', e.message))
      }
    }
    return leadId
  } catch (e: any) {
    console.error('[DB] reception lead upsert failed:', e.message)
    return null
  }
}

export async function insertCallLog(opts: {
  configId:    string
  leadId?:     string
  caller:      string | null
  durationSec: number
  transcript:  string
  escalated:   boolean
  message?:    string
}): Promise<void> {
  await pool.query(
    `INSERT INTO call_logs
       (reception_config_id, lead_id, caller_number, duration_seconds, transcript, escalated, message_taken)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [opts.configId, opts.leadId ?? null, opts.caller, opts.durationSec, opts.transcript, opts.escalated, opts.message ?? null]
  )

  if (!opts.leadId) return
  const booked  = opts.transcript.includes('[BOOKING]')
  const isSpam  = opts.durationSec < 8 && (
    opts.transcript.toLowerCase().includes('vendor') ||
    opts.transcript.toLowerCase().includes('not accepting') ||
    opts.transcript.length < 80
  )
  try {
    await pool.query(
      `INSERT INTO lead_events (lead_id, event_type, detail) VALUES ($1, $2, $3)`,
      [opts.leadId, isSpam ? 'call_spam' : 'call_received', JSON.stringify({ caller: opts.caller, durationSec: opts.durationSec })]
    )
    if (booked) {
      await pool.query(
        `INSERT INTO lead_events (lead_id, event_type, detail) VALUES ($1, $2, $3)`,
        [opts.leadId, 'call_booked', JSON.stringify({ caller: opts.caller })]
      )
    }
    if (opts.escalated) {
      await pool.query(
        `INSERT INTO lead_events (lead_id, event_type, detail) VALUES ($1, $2, $3)`,
        [opts.leadId, 'call_escalated', JSON.stringify({ caller: opts.caller })]
      )
    }
  } catch (e: any) {
    console.error('[DB] lead_events insert failed:', e.message)
  }
}

export async function getRecentCallerContext(caller: string, configId: string): Promise<string> {
  const digits = caller.replace(/\D/g, '')
  if (digits.length < 10) return ''
  try {
    const { rows } = await pool.query(
      `SELECT created_at, transcript, message_taken FROM call_logs
       WHERE reception_config_id=$1 AND caller_number=$2
       ORDER BY created_at DESC LIMIT 3`,
      [configId, `+1${digits.slice(-10)}`]
    )
    return rows.map((r: any) => `Previous call ${r.created_at}: ${(r.transcript || r.message_taken || '').slice(-1800)}`).join('\n')
  } catch (e: any) {
    console.error('[DB] caller history lookup failed:', e.message)
    return ''
  }
}

export async function startEmailVerification(phone: string, callSid: string, configId: string): Promise<void> {
  await pool.query(
    `INSERT INTO reception_email_verifications (phone, call_sid, config_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (phone) WHERE status='pending' DO UPDATE SET
       call_sid=EXCLUDED.call_sid, config_id=EXCLUDED.config_id,
       email=NULL, status='pending', expires_at=NOW()+INTERVAL '10 minutes',
       created_at=NOW(), verified_at=NULL`,
    [phone, callSid, configId]
  )
}

export async function getVerifiedEmail(callSid: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT email FROM reception_email_verifications
     WHERE call_sid=$1 AND status='verified' AND expires_at>NOW()
     ORDER BY verified_at DESC LIMIT 1`,
    [callSid]
  )
  return rows[0]?.email ?? null
}

/** Today's call count for a given AI Studio key (0 if no calls yet today). */
export async function getAiStudioUsageToday(keyName: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT call_count FROM ai_studio_key_usage WHERE key_name = $1 AND usage_date = CURRENT_DATE`,
    [keyName]
  )
  return rows[0]?.call_count ?? 0
}

/** Atomically records one call against a key's daily counter, returns the new count. */
export async function incrementAiStudioUsage(keyName: string): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO ai_studio_key_usage (key_name, usage_date, call_count)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (key_name, usage_date) DO UPDATE SET
       call_count = ai_studio_key_usage.call_count + 1,
       updated_at = NOW()
     RETURNING call_count`,
    [keyName]
  )
  return rows[0].call_count
}

/** Total AI Reception voice minutes for a config, current calendar month. */
export async function getMonthlyVoiceMinutes(configId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(duration_seconds), 0) AS total_sec
     FROM call_logs
     WHERE reception_config_id = $1 AND created_at >= date_trunc('month', NOW())`,
    [configId]
  )
  return Math.round((Number(rows[0]?.total_sec) || 0) / 60)
}

/**
 * Records the voice-cap-exceeded alert for this config this month.
 * Returns true the first time it's called in a given month (caller should
 * send the alert email), false on every subsequent call that month (already
 * sent — skip, don't spam an email per over-cap call).
 */
export async function markCapAlertSent(configId: string, minutesUsed: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO reception_cap_alerts (config_id, alert_month, minutes_used)
     VALUES ($1, date_trunc('month', NOW())::date, $2)
     ON CONFLICT (config_id, alert_month) DO NOTHING`,
    [configId, minutesUsed]
  )
  return (rowCount ?? 0) > 0
}

function rowToConfig(row: any): ReceptionConfig {
  return {
    id:            row.id,
    lead_id:       row.lead_id,
    website_url:   row.website_url,
    business_name: row.business_name,
    brain:         row.brain_json,
    system_prompt: row.system_prompt,
    twilio_phone:  row.twilio_phone,
    active:        row.active,
    created_at:    row.created_at,
  }
}
