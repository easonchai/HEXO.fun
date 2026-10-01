import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { POINTS, QUESTS } from "./_points.js";

/**
 * Shared by the routes. Files that start with `_` are not routes on Vercel.
 * Every export is inert at import time: no env reads, no connections.
 */

// Built on first query so tests can import this file without DATABASE_URL.
let client;
export const sql = (...args) => (client ??= neon(process.env.DATABASE_URL))(...args);

/** Tests swap in a tagged-template client over node-postgres, since neon's
 *  driver needs its HTTP endpoint. Resets the schema check for the new DB. */
export function useSql(fn) {
  client = fn;
  ready = undefined;
}

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
    await sql`alter table waitlist add column if not exists x_user_id text unique`;
    await sql`alter table waitlist add column if not exists x_handle text`;
    await sql`alter table waitlist add column if not exists x_connected_at timestamptz`;
    // Backfill signups from before codes existed. Empty after the first run.
    const missing = await sql`select id from waitlist where code is null`;
    for (const { id } of missing) {
      await withCode(
        (code) => sql`update waitlist set code = ${code} where id = ${id}::uuid`,
      );
    }
    await sql`
      create table if not exists waitlist_points (
        id          bigserial primary key,
        waitlist_id uuid not null references waitlist(id),
        kind        text not null,
        ref         text not null default '',
        points      int not null,
        created_at  timestamptz not null default now(),
        unique (waitlist_id, kind, ref)
      )
    `;
    // Referrals pay on X connect. Drop awards paid at sign-in for invitees
    // without X, then credit the qualified ones. Both repeat safely.
    await sql`
      delete from waitlist_points p
      where p.kind = 'referral'
        and not exists (
          select 1 from waitlist w where w.id::text = p.ref and w.x_user_id is not null
        )
    `;
    await awardReferrals();
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

/** The body every signed-in response returns. Later tickets add fields here,
 *  and the routes stay unchanged. Rank is position by total points descending,
 *  then earlier signup, then id so it is always a strict order. */
export const loadMember = (id) => loadMemberWhere(id, null);

/** The same body by share code, for the public card and link routes. */
export const loadMemberByCode = (code) => loadMemberWhere(null, code);

async function loadMemberWhere(id, code) {
  // ponytail: window function over every row on each call, fine at waitlist
  // size. When it shows in latency, cache the ranking for a few seconds or
  // keep a materialised total per row.
  const rows = await sql`
    with ranked as (
      select
        w.id,
        coalesce(sum(p.points), 0)::int as points,
        (count(p.id) filter (where p.kind = 'referral'))::int as referrals,
        (row_number() over (
          order by coalesce(sum(p.points), 0) desc, w.created_at asc, w.id asc
        ))::int as rank
      from waitlist w
      left join waitlist_points p on p.waitlist_id = w.id
      group by w.id
    )
    select w.id, w.code, w.x_handle, r.rank, r.points, r.referrals,
      (w.x_user_id is not null) as x,
      array(
        select p.kind || ':' || p.ref from waitlist_points p
        where p.waitlist_id = w.id and p.kind in ('quest', 'x_connect')
      ) as got
    from waitlist w
    join ranked r on r.id = w.id
    where w.id = ${id}::uuid or w.code = ${code}
  `;
  if (!rows[0]) return null;
  // Quest state rides along as `x` and `got`, and stays out of the body.
  const { x, got = [], ...member } = rows[0];
  const quests = QUESTS.map((q) => ({
    ...q,
    done: got.includes(q.check === "oauth" ? `${q.id}:` : `quest:${q.id}`),
    locked: q.check !== "oauth" && !x,
  }));
  return { ...member, quests };
}

/** Writes the referrer's award and the invitee's own bonus, only for an invitee
 *  with X connected. With an id it covers that one row; with none it backfills
 *  every row. Safe to repeat, the unique key drops the second insert. */
export function awardReferrals(newId = null) {
  return sql`
    with q as (
      select r.id as referrer, w.id as invitee
      from waitlist w
      join waitlist r on r.code = w.referred_by and r.id <> w.id
      where w.x_user_id is not null
        and (${newId}::uuid is null or w.id = ${newId}::uuid)
    )
    insert into waitlist_points (waitlist_id, kind, ref, points)
    select referrer, 'referral', invitee::text, ${POINTS.referral}::int from q
    union all
    select invitee, 'referred', '', ${POINTS.referred}::int from q
    on conflict (waitlist_id, kind, ref) do nothing
  `;
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

/** One cookie's raw value from a request's Cookie header, or undefined. */
export function getCookie(req, name) {
  const raw = String(req.headers.cookie ?? "")
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`));
  return raw?.slice(name.length + 1);
}

/** The signed-in waitlist id from a request's Cookie header, or null. */
export function sessionId(req, secret) {
  return verifySession(getCookie(req, SESSION_COOKIE), secret);
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
