import { createHmac, randomBytes } from "node:crypto";
import { getCookie, signSession, verifySession } from "./_lib.js";

// X OAuth 1.0a (three-legged), HMAC-SHA1 via node:crypto. No X API call after the handshake.
export const AUTHENTICATE_URL = "https://api.x.com/oauth/authenticate";
const REQUEST_TOKEN_URL = "https://api.x.com/oauth/request_token";
const ACCESS_TOKEN_URL = "https://api.x.com/oauth/access_token";

// RFC 3986: encodeURIComponent leaves !*'() unescaped.
export function percentEncode(s) {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

// params: object of every oauth + query/body param that is signed.
export function signatureBaseString(method, url, params) {
  const norm = Object.entries(params)
    .map(([k, v]) => [percentEncode(k), percentEncode(String(v))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return [method.toUpperCase(), percentEncode(url), percentEncode(norm)].join("&");
}

export function sign({ method, url, params, consumerSecret, tokenSecret = "" }) {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac("sha1", key)
    .update(signatureBaseString(method, url, params))
    .digest("base64");
}

// extra: additional oauth_* params (oauth_callback, oauth_verifier), signed and sent in the header.
export function authHeader({
  method,
  url,
  consumerKey,
  consumerSecret,
  token,
  tokenSecret = "",
  extra = {},
  nonce = randomBytes(16).toString("hex"),
  timestamp = String(Math.floor(Date.now() / 1000)),
}) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp),
    oauth_version: "1.0",
    ...(token ? { oauth_token: token } : {}),
    ...extra,
  };
  oauth.oauth_signature = sign({ method, url, params: oauth, consumerSecret, tokenSecret });
  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k])}"`)
      .join(", ")
  );
}

// POST with an OAuth header, parse the form-encoded body. Messages carry status only, never secrets.
async function post(what, url, creds, extra) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader({ method: "POST", url, ...creds, extra }) },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`X ${what} failed: HTTP ${res.status}`);
  return new URLSearchParams(await res.text());
}

export async function requestToken({ consumerKey, consumerSecret, callback }) {
  const body = await post(
    "request_token",
    REQUEST_TOKEN_URL,
    { consumerKey, consumerSecret },
    { oauth_callback: callback },
  );
  if (body.get("oauth_callback_confirmed") !== "true") {
    throw new Error("X request_token failed: oauth_callback_confirmed is not true");
  }
  const token = body.get("oauth_token");
  const secret = body.get("oauth_token_secret");
  if (!token || !secret) throw new Error("X request_token failed: missing token in response");
  return { token, secret };
}

// Returns only the identity. The access token and secret are dropped on purpose.
export async function accessToken({ consumerKey, consumerSecret, token, tokenSecret, verifier }) {
  const body = await post(
    "access_token",
    ACCESS_TOKEN_URL,
    { consumerKey, consumerSecret, token, tokenSecret },
    { oauth_verifier: verifier },
  );
  const userId = body.get("user_id");
  const screenName = body.get("screen_name");
  if (!userId || !screenName) throw new Error("X access_token failed: missing identity in response");
  return { userId, screenName };
}

// Request token and its secret ride between /start and /callback in this
// cookie: signed like the session (prefix keeps the two from being swapped),
// ten minutes, only sent to /api/x/*. Lax so it survives the redirect back from x.com.
const X_COOKIE = "hexo_x";
const X_COOKIE_FLAGS = "Path=/api/x; HttpOnly; Secure; SameSite=Lax";

export const xCookie = (token, secret, sessionSecret) =>
  `${X_COOKIE}=${signSession(`x:${token}:${secret}`, sessionSecret)}; ${X_COOKIE_FLAGS}; Max-Age=600`;

export const clearXCookie = `${X_COOKIE}=; ${X_COOKIE_FLAGS}; Max-Age=0`;

/** `{ token, secret }` from a request's cookie, or null when missing or forged. */
export function readXCookie(req, sessionSecret) {
  const parts = verifySession(getCookie(req, X_COOKIE), sessionSecret)?.split(":");
  return parts?.length === 3 && parts[0] === "x" ? { token: parts[1], secret: parts[2] } : null;
}
