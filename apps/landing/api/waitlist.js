import { randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";

/**
 * Waitlist capture. Two operations on one route:
 *
 *   { email, ref? } -> inserts the signup, returns its id and share code
 *   { id, answer }  -> attaches the follow-up answer to that signup
 *
 * Every signup gets a 6-hex share code. `ref` is the code the visitor arrived
 * with (from ?ref=); it is stored raw as `referred_by`, never validated, so
 * counting referrals is `group by referred_by`. Codes are waitlist-only and
 * unrelated to the app's invite or referral codes.
 *
 * The answer is a second step on purpose: the email is already committed by
 * the time we ask, so abandoning the question costs us nothing.
 */

const sql = neon(process.env.DATABASE_URL);

// Deliberately loose. Real addresses fail strict regexes far more often than
// junk passes a loose one, and a bounced send is cheaper than a lost signup.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const ANSWER_MAX = 2000;

const CODE_ATTEMPTS = 5;

let ready;

/** Idempotent DDL instead of a migration step for a single table. Later
 *  columns are `add column if not exists` so the same code runs against a
 *  table created by any earlier version. */
function ensureSchema() {
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

const newCode = () => randomBytes(3).toString("hex");

/** Runs `write` with a fresh code, drawing again on a code collision. 16.7M
 *  codes, so a second draw is rare and a fifth is a bug elsewhere. */
async function withCode(write) {
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: "Storage is not configured" });
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  if (!body) return res.status(400).json({ error: "Expected a JSON body" });

  try {
    await ensureSchema();

    if (body.id) {
      const answer = String(body.answer ?? "").trim();
      if (!answer) return res.status(400).json({ error: "Answer is empty" });

      const rows = await sql`
        update waitlist
           set answer = ${answer.slice(0, ANSWER_MAX)}, answered_at = now()
         where id = ${body.id}::uuid
        returning id
      `;
      if (!rows.length) return res.status(404).json({ error: "Unknown signup" });
      return res.status(200).json({ id: rows[0].id });
    }

    const email = String(body.email ?? "")
      .trim()
      .toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) {
      return res.status(400).json({ error: "That email doesn't look right" });
    }

    // A repeat signup returns the original row (and its original code) so the
    // follow-up question still has an id to attach to. Self-referral can't
    // happen: a visitor has no code until this insert, and a repeat keeps the
    // first referred_by.
    const rows = await withCode(
      (code) => sql`
        insert into waitlist (email, code, referred_by, referrer, utm, user_agent)
        values (
          ${email},
          ${code},
          ${str(body.ref, 16)?.toLowerCase() ?? null},
          ${str(body.referrer, 500)},
          ${body.utm && typeof body.utm === "object" ? JSON.stringify(body.utm) : null},
          ${str(req.headers["user-agent"], 500)}
        )
        on conflict (email) do update set email = excluded.email
        returning id, code
      `,
    );
    return res.status(200).json({ id: rows[0].id, code: rows[0].code });
  } catch (err) {
    console.error("waitlist failed", err);
    return res.status(500).json({ error: "Could not save that. Try again." });
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function str(v, max) {
  return typeof v === "string" && v ? v.slice(0, max) : null;
}
