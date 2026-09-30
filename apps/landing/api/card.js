import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import satori from "satori";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { configured, ensureSchema, loadMemberByCode } from "./_lib.js";
import { cardTree, parseCode } from "./_share.js";

// Node runtime. satori plus resvg-wasm rather than @vercel/og: its Node build
// is a bundle that calls require("fs") and __dirname from inside an ES module,
// which throws in a "type": "module" package. Both files below are read by
// literal path so Vercel's file tracing ships them with the function.
const require = createRequire(import.meta.url);
const FONT = readFileSync(new URL("./_fonts/Syncopate-Bold.ttf", import.meta.url));

let wasm;
const ready = () =>
  (wasm ??= initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm"))).catch(
    (err) => {
      wasm = undefined;
      throw err;
    },
  ));

/** The card as PNG bytes. */
async function render(member) {
  await ready();
  const svg = await satori(cardTree({ handle: member.x_handle, rank: member.rank }), {
    width: 1200,
    height: 630,
    fonts: [{ name: "Syncopate", data: FONT, weight: 700, style: "normal" }],
  });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng());
}

/**
 * The share card, 1200x630. Handle and rank come from the row at render time.
 * `v` is only part of the URL so X and Vercel's cache see a new image per
 * share. It is never read. A code with no X handle goes to the static image.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const staticImage = () => {
    res.setHeader("Location", "/og-image.png");
    return res.status(302).end();
  };

  const code = parseCode(req.query?.code);
  if (!code) return staticImage();
  if (!configured(res, "DATABASE_URL")) return;

  try {
    await ensureSchema();
    const member = await loadMemberByCode(code);
    if (!member?.x_handle) return staticImage();

    const png = await render(member);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.status(200).send(png);
  } catch (err) {
    console.error("card failed", err);
    return res.status(500).json({ error: "Could not render that. Try again." });
  }
}
