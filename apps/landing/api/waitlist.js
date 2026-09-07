import { neon } from "@neondatabase/serverless";

/**
 * Waitlist capture. Two operations on one route:
 *
 *   { email }      -> inserts the signup, returns its id
 *   { id, answer } -> attaches the follow-up answer to that signup
 *
 * The answer is a second step on purpose: the email is already committed by
 * the time we ask, so abandoning the question costs us nothing.
 */

const sql = neon(process.env.DATABASE_URL);

// Deliberately loose. Real addresses fail strict regexes far more often than
// junk passes a loose one, and a bounced send is cheaper than a lost signup.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const ANSWER_MAX = 2000;

let ready;

/** One idempotent DDL instead of a migration step for a single table. */
function ensureSchema() {
  ready ??= sql`
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
  `.catch((err) => {
    ready = undefined; // let the next request retry rather than cache a failure
    throw err;
  });
  return ready;
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

    // A repeat signup returns the original row so the follow-up question still
    // has an id to attach to.
    const rows = await sql`
      insert into waitlist (email, referrer, utm, user_agent)
      values (
        ${email},
        ${str(body.referrer, 500)},
        ${body.utm && typeof body.utm === "object" ? JSON.stringify(body.utm) : null},
        ${str(req.headers["user-agent"], 500)}
      )
      on conflict (email) do update set email = excluded.email
      returning id
    `;
    return res.status(200).json({ id: rows[0].id });
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
