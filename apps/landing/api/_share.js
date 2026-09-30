/**
 * Pure pieces of the personal link (/r/<code>) and its card. No I/O, so the
 * tests import this file directly. Files that start with `_` are not routes.
 */

const CODE = /^[0-9a-f]{6}$/;

/** A share code as lowercase hex, or null. Everything downstream (SQL, HTML,
 *  URLs) only ever sees the return value of this. */
export function parseCode(raw) {
  const code = String(Array.isArray(raw) ? raw[0] : (raw ?? "")).toLowerCase();
  return CODE.test(code) ? code : null;
}

/** The `v` cache key as digits only, or null. Never shown on the card. */
export function parseV(raw) {
  const v = String(Array.isArray(raw) ? raw[0] : (raw ?? ""));
  return /^[0-9]{1,9}$/.test(v) ? v : null;
}

export const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/** The card for a member with X connected, the static image otherwise. */
export function ogImage(origin, code, handle, v) {
  if (!handle) return `${origin}/og-image.png`;
  const q = `code=${code}` + (v ? `&v=${v}` : "");
  return `${origin}/api/card?${q}`;
}

/** The small document crawlers read. People get sent on to `/?ref=<code>`,
 *  which is where the referral is credited. Every interpolation is escaped. */
export function sharePage({ origin, code, handle, v }) {
  const e = escapeHtml;
  const title = handle
    ? `Join @${handle} on the HEXO.fun waitlist`
    : "Join the waitlist. Earn 5%, play for jackpot.";
  const desc =
    "A no-loss savings app on Solana. Your deposit earns 5% and never goes into the game. Every dollar is a ticket in the daily jackpot.";
  const image = ogImage(origin, code, handle, v);
  const target = `/?ref=${code}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${e(title)}</title>
<meta property="og:type" content="website" />
<meta property="og:site_name" content="HEXO.fun" />
<meta property="og:title" content="${e(title)}" />
<meta property="og:description" content="${e(desc)}" />
<meta property="og:url" content="${e(`${origin}/r/${code}`)}" />
<meta property="og:image" content="${e(image)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@Hexofun" />
<meta name="twitter:title" content="${e(title)}" />
<meta name="twitter:description" content="${e(desc)}" />
<meta name="twitter:image" content="${e(image)}" />
<meta http-equiv="refresh" content="0;url=${e(target)}" />
<script>location.replace(${JSON.stringify(target)});</script>
</head>
<body><a href="${e(target)}">HEXO.fun</a></body>
</html>
`;
}

// Landing palette (index.html :root) and type.
const NAVY = "#081120";
const INK = "#e2e4e9";
const INK3 = "#838a93";
const LIME = "#b6ff3b";
const LINE = "rgba(226, 228, 233, 0.18)";

const el = (type, style, children) => ({ type, props: { style, children } });

/** Element tree for `ImageResponse`, 1200x630. Plain objects, no JSX. */
export function cardTree({ handle, rank }) {
  const name = `@${handle}`;
  // Syncopate is wide, about 0.95em a character. X handles run to 15 characters,
  // so size the name to fit one line in the 1056px content box.
  const nameSize = Math.min(104, Math.floor(1056 / (name.length * 0.95)));
  return el(
    "div",
    {
      width: 1200,
      height: 630,
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      padding: 72,
      background: NAVY,
      color: INK,
      fontFamily: "Syncopate",
      borderTop: `8px solid ${LIME}`,
    },
    [
      el("div", { display: "flex", fontSize: 40, fontWeight: 700, color: LIME }, "HEXO.fun"),
      el("div", { display: "flex", flexDirection: "column" }, [
        el("div", { display: "flex", fontSize: 24, color: INK3, letterSpacing: 4 }, "ON THE WAITLIST"),
        el(
          "div",
          { display: "flex", fontSize: nameSize, fontWeight: 700, marginTop: 20, color: INK },
          name,
        ),
      ]),
      el(
        "div",
        {
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          borderTop: `2px solid ${LINE}`,
          paddingTop: 32,
        },
        [
          el("div", { display: "flex", fontSize: 28, color: INK3 }, "Earn 5%. Play for jackpot."),
          el("div", { display: "flex", alignItems: "baseline" }, [
            el("div", { display: "flex", fontSize: 28, color: INK3, marginRight: 20 }, "RANK"),
            el("div", { display: "flex", fontSize: 96, fontWeight: 700, color: LIME }, `#${rank}`),
          ]),
        ],
      ),
    ],
  );
}
