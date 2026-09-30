import { configured, sessionId } from "../_lib.js";
import { requestToken, AUTHENTICATE_URL, xCookie } from "../_x.js";

/** `PUBLIC_ORIGIN` pins the callback host; without it the request's own host is used. */
const origin = (req) =>
  process.env.PUBLIC_ORIGIN || `https://${req.headers.host}`;

/**
 * Start of the X connect. Needs the session cookie. Gets a request token,
 * parks it in a ten minute cookie and sends the browser to X to approve.
 * Any failure sends the browser home with `?x=error`, since this is a
 * navigation and JSON would strand the visitor on a blank page.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!configured(res, "X_CONSUMER_KEY", "X_CONSUMER_SECRET", "SESSION_SECRET")) return;

  res.setHeader("Cache-Control", "no-store");
  if (!sessionId(req, process.env.SESSION_SECRET)) {
    return res.status(401).json({ error: "Not signed in" });
  }

  try {
    const { token, secret } = await requestToken({
      consumerKey: process.env.X_CONSUMER_KEY,
      consumerSecret: process.env.X_CONSUMER_SECRET,
      callback: `${origin(req)}/api/x/callback`,
    });
    res.setHeader("Set-Cookie", xCookie(token, secret, process.env.SESSION_SECRET));
    res.setHeader("Location", `${AUTHENTICATE_URL}?oauth_token=${encodeURIComponent(token)}`);
    return res.status(302).end();
  } catch (err) {
    console.error("x start failed", err);
    res.setHeader("Location", "/?x=error");
    return res.status(302).end();
  }
}
