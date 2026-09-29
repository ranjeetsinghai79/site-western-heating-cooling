import { NextRequest, NextResponse } from "next/server"
import { verifyClientCookie } from "@/lib/client-session"
import { verifyPlatformSession } from "@/lib/platform-session"

// Cached within the isolate — crypto.subtle ops are expensive; only run once per isolate lifecycle
let _cachedToken: string | null = null
let _cachedPassword: string | null = null

async function getExpectedToken(password: string): Promise<string> {
  if (_cachedToken !== null && _cachedPassword === password) return _cachedToken
  const secret = process.env.SESSION_SECRET ?? process.env.ADMIN_PASSWORD ?? "dev-only-insecure-secret"
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(password))
  _cachedToken    = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("")
  _cachedPassword = password
  return _cachedToken
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Client portal auth — verify signed cookie, not just presence
  if (pathname.startsWith("/client/dashboard")) {
    const email = await verifyClientCookie(req.cookies.get("client_email")?.value)
    if (!email) return NextResponse.redirect(new URL("/client/login", req.url))
    return NextResponse.next()
  }

  if (pathname.startsWith("/agency/dashboard")) {
    const session = await verifyPlatformSession(req.cookies.get("agency_session")?.value)
    if (!session) return NextResponse.redirect(new URL("/agency/login", req.url))
    return NextResponse.next()
  }

  // Skip auth for: login page, client routes, public API, static assets
  const isPublic =
    pathname === "/login" ||
    pathname.startsWith("/client/") ||
    pathname === "/agency/login" ||
    pathname.startsWith("/agency/auth/") ||
    pathname.startsWith("/api/platform/self/") ||
    (pathname.startsWith("/api/integrations/") && pathname.endsWith("/callback")) ||
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon")

  if (isPublic) return NextResponse.next()

  // Admin auth — check session cookie
  const adminPassword = process.env.ADMIN_PASSWORD
  if (!adminPassword) return NextResponse.next()

  const session = req.cookies.get("admin_session")?.value
  const expected = await getExpectedToken(adminPassword)

  if (session !== expected) {
    const loginUrl = new URL("/login", req.url)
    loginUrl.searchParams.set("from", pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
