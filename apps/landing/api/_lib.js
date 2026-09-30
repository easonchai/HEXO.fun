import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Shared by the routes. Files that start with `_` are not routes on Vercel.
 * Every export is inert at import time: no env reads, no connections.
 */

// Built on first query so tests can import this file without DATABASE_URL.
let client;
export const sql = (...args) => (client ??= neon(process.env.DATABASE_URL))(...args);

const CODE_ATTEMPTS = 5;

let ready;

/** Idempotent DDL instead of a migration step for a single table. Later
 *  columns are `add column if not exists` so the same code runs against a
 *  table created by any earlier version. */
export function ensureSchema() {
  ready ??= (async () => {
    await sql`
      create table if not exists waitlist (
        id          uuid primary key default gen_random_uuid(),
        email       text not null unique,
        answer      text,
        referrer    text,
        utm         jsonb,
        user_agent  text,
        created_at  timestamptz not null default now(),
        answered_at timestamptz
      )
    `;
    await sql`alter table waitlist add column if not exists code text unique`;
    await sql`alter table waitlist add column if not exists referred_by text`;
    await sql`alter table waitlist add column if not exists google_sub text unique`;
    // Backfill signups from before codes existed. Empty after the first run.
    const missing = await sql`select id from waitlist where code is null`;
    for (const { id } of missing) {
      await withCode(
        (code) => sql`update waitlist set code = ${code} where id = ${id}::uuid`,
      );
    }
  })().catch((err) => {
    ready = undefined; // let the next request retry rather than cache a failure
    throw err;
  });
  return ready;
}

export const newCode = () => randomBytes(3).toString("hex");

/** Runs `write` with a fresh code, drawing again on a code collision. 16.7M
 *  codes, so a second draw is rare and a fifth is a bug elsewhere. */
export async function withCode(write) {
  for (let i = 0; ; i++) {
    try {
      return await write(newCode());
    } catch (err) {
      if (err.constraint !== "waitlist_code_key" || i + 1 >= CODE_ATTEMPTS) {
        throw err;
      }
    }
  }
}

export function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function str(v, max) {
  return typeof v === "string" && v ? v.slice(0, max) : null;
}

/** The body every signed-in response returns. Later tickets add rank and
 *  points here, and the routes stay unchanged. */
export async function loadMember(id) {
  const rows = await sql`
    select id, code, null::text as x_handle from waitlist where id = ${id}::uuid
  `;
  return rows[0] ?? null;
}

/** Sends the 500 and returns false when an env var is missing. */
export function configured(res, ...names) {
  if (names.every((n) => process.env[n])) return true;
  res.status(500).json({ error: "Not configured" });
  return false;
}

// ------------------------------- session ---------------------------------
// Cookie value is `<waitlist id>.<hex HMAC-SHA256 of the id>`.

export const SESSION_COOKIE = "hexo_session";

const mac = (id, secret) => createHmac("sha256", secret).update(id).digest("hex");

export const signSession = (id, secret) => `${id}.${mac(id, secret)}`;

/** The id inside a signed value, or null when the value was not signed by us. */
export function verifySession(value, secret) {
  if (typeof value !== "string") return null;
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const id = value.slice(0, dot);
  const got = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(mac(id, secret));
  // timingSafeEqual throws on unequal lengths, so compare those first.
  return got.length === want.length && timingSafeEqual(got, want) ? id : null;
}

export const sessionCookie = (id, secret) =>
  `${SESSION_COOKIE}=${signSession(id, secret)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;

/** The signed-in waitlist id from a request's Cookie header, or null. */
export function sessionId(req, secret) {
  const raw = String(req.headers.cookie ?? "")
    .split(/;\s*/)
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return raw ? verifySession(raw.slice(SESSION_COOKIE.length + 1), secret) : null;
}

// -------------------------------- google ---------------------------------

let googleKeys;

/** Checks a Google ID token and returns `{ sub, email }`. `keySet` is a jose
 *  key resolver; tests pass a local one, production takes Google's JWKS with
 *  a five second fetch timeout. Errors carry the HTTP `status` to answer with. */
export async function verifyGoogleToken(credential, { audience, keySet }) {
  keySet ??= googleKeys ??= createRemoteJWKSet(
    new URL("https://www.googleapis.com/oauth2/v3/certs"),
    { timeoutDuration: 5000 },
  );
  let payload;
  try {
    ({ payload } = await jwtVerify(credential, keySet, {
      issuer: ["accounts.google.com", "https://accounts.google.com"],
      audience,
    }));
  } catch (cause) {
    throw Object.assign(new Error("Google sign-in failed", { cause }), { status: 401 });
  }
  if (payload.email_verified !== true || !payload.email || !payload.sub) {
    throw Object.assign(new Error("That Google email isn't verified"), { status: 400 });
  }
  return { sub: payload.sub, email: String(payload.email).toLowerCase() };
}
