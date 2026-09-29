// Signed client-portal session cookie.
// The cookie value is `<email>.<hmac>` so it cannot be forged.
// Before this, `client_email` was stored as plaintext — anyone could set
// the cookie to any client's email and read their dashboard + Stripe billing.

import { hmacSha256Hex, timingSafeEqual } from "@/lib/edge-crypto"

// Signing secret: prefer an explicit SESSION_SECRET, fall back to ADMIN_PASSWORD
// (always set in any real deployment). No hardcoded constant fallback in prod —
// a known secret would let anyone forge sessions.
function signingSecret(): string {
  const s = process.env.SESSION_SECRET ?? process.env.ADMIN_PASSWORD
  if (s) return s
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET or ADMIN_PASSWORD must be set in production")
  }
  return "dev-only-insecure-secret"
}

export async function signClientEmail(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase()
  const sig = await hmacSha256Hex(signingSecret(), normalized)
  return `${normalized}.${sig}`
}

// Returns the verified email, or null if the cookie is missing/forged/tampered.
export async function verifyClientCookie(cookieValue: string | undefined | null): Promise<string | null> {
  if (!cookieValue) return null
  const dot = cookieValue.lastIndexOf(".")
  if (dot <= 0) return null
  const email = cookieValue.slice(0, dot)
  const sig   = cookieValue.slice(dot + 1)
  if (!email || !sig) return null
  const expected = await hmacSha256Hex(signingSecret(), email)
  if (!timingSafeEqual(sig, expected)) return null
  return email
}
