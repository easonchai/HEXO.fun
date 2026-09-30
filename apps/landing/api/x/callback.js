import { ensureSchema, sessionId, sql } from "../_lib.js";
import { POINTS } from "../_points.js";
import { accessToken, clearXCookie, readXCookie } from "../_x.js";

/**
 * Where X sends the browser back. Checks the returned token against the
 * cookie from /start, trades the verifier for the identity, and writes the
 * handle plus the award in one statement. The access token is dropped inside
 * `accessToken` and never reaches here. Every outcome is a redirect home with
 * `?x=connected|taken|denied|error`.
 */
export default async function handler(req, res) {
  const home = (x) => {
    res.setHeader("Set-Cookie", clearXCookie);
    res.setHeader("Location", `/?x=${x}`);
    return res.status(302).end();
  };

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Cache-Control", "no-store");
  // A redirect, not the 500 the other routes send: the visitor is mid-navigation.
  const env = ["DATABASE_URL", "X_CONSUMER_KEY", "X_CONSUMER_SECRET", "SESSION_SECRET"];
  if (!env.every((n) => process.env[n])) {
    console.error("x callback: not configured");
    return home("error");
  }

  const { oauth_token: token, oauth_verifier: verifier, denied } = req.query ?? {};
  if (denied) return home("denied");

  try {
    const id = sessionId(req, process.env.SESSION_SECRET);
    const temp = readXCookie(req, process.env.SESSION_SECRET);
    if (!id || !temp || !verifier || temp.token !== token) return home("error");

    const { userId, screenName } = await accessToken({
      consumerKey: process.env.X_CONSUMER_KEY,
      consumerSecret: process.env.X_CONSUMER_SECRET,
      token,
      tokenSecret: temp.secret,
      verifier,
    });

    await ensureSchema();
    // One statement so the handle and its award land together. A second row
    // holding this X account trips the unique key and nothing is written.
    await sql`
      with u as (
        update waitlist
          set x_user_id = ${userId}, x_handle = ${screenName}, x_connected_at = now()
          where id = ${id}::uuid
          returning id
      )
      insert into waitlist_points (waitlist_id, kind, ref, points)
      select id, 'x_connect', '', ${POINTS.x_connect}::int from u
      on conflict (waitlist_id, kind, ref) do nothing
    `;
    return home("connected");
  } catch (err) {
    if (err.constraint === "waitlist_x_user_id_key") return home("taken");
    console.error("x callback failed", err);
    return home("error");
  }
}
