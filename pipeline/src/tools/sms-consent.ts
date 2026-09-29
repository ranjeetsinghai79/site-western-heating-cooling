/**
 * sms-consent.ts — TCPA gate for outbound marketing SMS.
 *
 * A number may only be texted if an active (non-revoked) consent event exists
 * in consent_events (migration-v9). Consent is captured by the CF Worker on:
 *   - contact/audit form submit with SMS opt-in checkbox (express_written)
 *   - inbound SMS reply (inbound_reply)
 * STOP revokes it (worker sets revoked_at).
 *
 * Fail-closed: missing DATABASE_URL, DB error, or no match → NO send.
 * ALLOW_COLD_SMS=true bypasses the gate — you accept TCPA exposure
 * ($500–$1,500 statutory damages per text) and 10DLC campaign suspension risk.
 * Cold leads without consent should get EMAIL outreach (sheets-outreach.ts).
 */

import pg from 'pg'

let _pool: pg.Pool | null = null
function getPool(): pg.Pool | null {
  if (!process.env.DATABASE_URL) return null
  if (!_pool) _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
  return _pool
}

const COLD_SMS_OVERRIDE = process.env.ALLOW_COLD_SMS === 'true'
let warnedOverride = false
function warnOverride(): void {
  if (warnedOverride) return
  warnedOverride = true
  console.warn('⚠️  ALLOW_COLD_SMS=true — TCPA consent gate BYPASSED. Cold SMS to scraped numbers = $500–$1,500 exposure per text.')
}

/** Canonical US comparison key: last 10 digits. */
export function phoneKey(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10)
}

/** Check one number for active SMS consent. Fail-closed. */
export async function hasSmsConsent(phone: string): Promise<boolean> {
  if (COLD_SMS_OVERRIDE) { warnOverride(); return true }
  const key = phoneKey(phone)
  if (key.length !== 10) return false
  const pool = getPool()
  if (!pool) return false
  try {
    const res = await pool.query(
      `SELECT 1 FROM consent_events
       WHERE channel = 'sms' AND revoked_at IS NULL
         AND RIGHT(REGEXP_REPLACE(contact, '\\D', '', 'g'), 10) = $1
       LIMIT 1`,
      [key]
    )
    return (res.rowCount ?? 0) > 0
  } catch (e: any) {
    console.warn(`[Consent] lookup failed (${e.message}) — failing closed, SMS blocked`)
    return false
  }
}

/**
 * Bulk load all consented phone keys — one query for batch scripts instead of
 * one query per row. Set containing '*' means gate bypassed via ALLOW_COLD_SMS.
 */
export async function loadSmsConsentSet(): Promise<Set<string>> {
  if (COLD_SMS_OVERRIDE) { warnOverride(); return new Set(['*']) }
  const pool = getPool()
  if (!pool) return new Set()
  try {
    const res = await pool.query(
      `SELECT DISTINCT RIGHT(REGEXP_REPLACE(contact, '\\D', '', 'g'), 10) AS key
       FROM consent_events WHERE channel = 'sms' AND revoked_at IS NULL`
    )
    return new Set<string>(res.rows.map((r: any) => r.key).filter((k: string) => k?.length === 10))
  } catch (e: any) {
    console.warn(`[Consent] bulk lookup failed (${e.message}) — failing closed`)
    return new Set()
  }
}

export function consentSetAllows(set: Set<string>, phone: string): boolean {
  return set.has('*') || set.has(phoneKey(phone))
}
