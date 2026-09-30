import {
  awardReferrals,
  configured,
  ensureSchema,
  loadMember,
  safeParse,
  sessionCookie,
  sql,
  str,
  verifyGoogleToken,
  withCode,
} from "../_lib.js";

/**
 * Google sign-in. `{ credential, ref?, referrer?, utm? }` -> verifies the ID
 * token, finds or creates the waitlist row, sets the session cookie and
 * returns the member body plus `created`.
 *
 * Lookup is by google_sub, then by email. An email match takes the old row
 * over, keeping its code and referred_by. `ref` is stored raw as
 * `referred_by`, never validated, and only on a new row. Codes are
 * waitlist-only and unrelated to the app's invite or referral codes.
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!configured(res, "DATABASE_URL", "GOOGLE_CLIENT_ID", "SESSION_SECRET")) return;

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  if (!body || typeof body.credential !== "string") {
    return res.status(400).json({ error: "Expected a Google credential" });
  }

  try {
    const { sub, email } = await verifyGoogleToken(body.credential, {
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    await ensureSchema();

    let id;
    let created = false;
    const known = await sql`select id from waitlist where google_sub = ${sub}`;
    if (known.length) {
      id = known[0].id;
    } else {
      // One statement for both "new" and "typed email from before": the email
      // conflict sets google_sub and leaves code and referred_by alone. xmax
      // is 0 only on a fresh insert.
      const rows = await withCode(
        (code) => sql`
          insert into waitlist
            (email, google_sub, code, referred_by, referrer, utm, user_agent)
          values (
            ${email},
            ${sub},
            ${code},
            ${str(body.ref, 16)?.toLowerCase() ?? null},
            ${str(body.referrer, 500)},
            ${body.utm && typeof body.utm === "object" ? JSON.stringify(body.utm) : null},
            ${str(req.headers["user-agent"], 500)}
          )
          on conflict (email) do update
            set google_sub = coalesce(waitlist.google_sub, excluded.google_sub)
          returning id, (xmax = 0) as created
        `,
      );
      ({ id, created } = rows[0]);
      // Only a fresh row earns its referrer a point award. A takeover keeps
      // its old referred_by, and the backfill already credited that.
      if (created) await awardReferrals(id);
    }

    res.setHeader("Set-Cookie", sessionCookie(id, process.env.SESSION_SECRET));
    return res.status(200).json({ ...(await loadMember(id)), created });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("google sign-in failed", err);
    return res.status(500).json({ error: "Could not sign you in. Try again." });
  }
}
