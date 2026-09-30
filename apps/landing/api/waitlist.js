import {
  configured,
  ensureSchema,
  safeParse,
  sessionId,
  sql,
} from "./_lib.js";

/**
 * Waitlist follow-up. `{ answer }` attaches the answer to the signed-in
 * signup, taken from the session cookie. The signup itself happens in
 * auth/google.js.
 *
 * The answer is a second step on purpose: the signup is already committed by
 * the time we ask, so abandoning the question costs us nothing.
 */

const ANSWER_MAX = 2000;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!configured(res, "DATABASE_URL", "SESSION_SECRET")) return;

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  if (!body) return res.status(400).json({ error: "Expected a JSON body" });

  const id = sessionId(req, process.env.SESSION_SECRET);
  if (!id) return res.status(401).json({ error: "Not signed in" });

  const answer = String(body.answer ?? "").trim();
  if (!answer) return res.status(400).json({ error: "Answer is empty" });

  try {
    await ensureSchema();
    const rows = await sql`
      update waitlist
         set answer = ${answer.slice(0, ANSWER_MAX)}, answered_at = now()
       where id = ${id}::uuid
      returning id
    `;
    if (!rows.length) return res.status(404).json({ error: "Unknown signup" });
    return res.status(200).json({ id: rows[0].id });
  } catch (err) {
    console.error("waitlist failed", err);
    return res.status(500).json({ error: "Could not save that. Try again." });
  }
}
