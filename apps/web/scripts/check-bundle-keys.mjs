// Scans the built assets for a leaked provider RPC key (production-hardening
// ticket 07 / spec.md item 7). Run after `vite build`; package.json's `build`
// script chains build then this (pre-mainnet review: `check` alone never
// ran on Vercel, so a keyed URL set in the dashboard shipped unnoticed), and
// `check` does the same. `findLeak` is the pure part, exported so
// check-bundle-keys.test.ts can drive it against fixture text instead of
// real files on disk.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const DIST_DIR = resolve(here, "../dist");

// RPC provider hostnames whose keyed URLs carry the key in the path or
// query: the ones this repo's docs mention as options (runbook.md,
// docs/ops/environments.md) plus the rest of the usual Solana roster. Only
// a long token *next to* one of these trips the generic pattern below, so
// the provider's public, unkeyed endpoints (`rpc.ankr.com/solana`) pass.
export const PROVIDER_HOSTS = [
  "helius-rpc.com",
  "quiknode.pro",
  "alchemy.com",
  "rpcpool.com",
  "drpc.org",
  "ankr.com",
  "shyft.to",
  "syndica.io",
  "chainstack.com",
  "getblock.io",
  "triton.one",
  "extrnode.com",
];

// A key-shaped run: 32+ hex, or 20+ base64url characters. Long enough that
// a path segment like `/solana` or `/v2/demo` never matches.
const TOKEN = "(?:[a-f0-9]{32,}|[a-z0-9_-]{20,})";
const HOSTS = PROVIDER_HOSTS.map((host) => host.replace(/\./g, "\\.")).join("|");

// `api-key=` and the Helius host are the two spec.md names explicitly; the
// provider-specific ones match their token in the URL, and the last two are
// the generic net (pre-mainnet review): a key-shaped token anywhere in the
// path or query of a provider host's URL, and the query-param spellings
// dRPC (`dkey=`), Ankr/Shyft/Syndica (`api_key=`, `apikey=`, `token=`) use.
// The generic host pattern stops at whitespace and quotes so it cannot run
// from one string literal into the next.
export const PATTERNS = [
  { name: "api-key query param", re: /api-key=/i },
  { name: "Helius RPC host", re: /helius-rpc\.com\/\?/i },
  { name: "QuickNode token", re: /quiknode\.pro\/[a-z0-9]{16,}/i },
  { name: "Alchemy token", re: /alchemy\.com\/v2\/[a-z0-9_-]{16,}/i },
  { name: "Triton token", re: /rpcpool\.com\/[a-z0-9_-]{16,}/i },
  { name: "dRPC key", re: /drpc\.org\/[^\s"'`]*[?&]dkey=/i },
  { name: "Ankr token", re: /ankr\.com\/[a-z0-9_-]+\/[a-f0-9]{32,}/i },
  { name: "Shyft key", re: /shyft\.to\/?[^\s"'`]*[?&]api_key=/i },
  { name: "Syndica key", re: /syndica\.io\/api-key\/[a-z0-9_-]{16,}/i },
  {
    name: "provider host with key-shaped token",
    re: new RegExp(`(?:${HOSTS})/(?:[^\\s"'\`]*?[/=?&])?${TOKEN}(?=$|[/?&#\\s"'\`])`, "i"),
  },
  {
    name: "keyed query param",
    re: new RegExp(`[?&](?:api_key|apikey|token|dkey)=${TOKEN}(?=$|[&#\\s"'\`])`, "i"),
  },
];

const TEXT_EXT = new Set([".js", ".mjs", ".css", ".html", ".json", ".map", ".txt"]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/**
 * First `{ file, pattern }` match across `files` (`{ path, text }`), or
 * `null`. Pure: no filesystem, no `process.exit`.
 */
export function findLeak(files) {
  for (const { path, text } of files) {
    for (const { name, re } of PATTERNS) {
      if (re.test(text)) return { file: path, pattern: name };
    }
  }
  return null;
}

function readDist() {
  const files = [];
  for (const path of walk(DIST_DIR)) {
    if (!TEXT_EXT.has(extname(path))) continue;
    files.push({ path, text: readFileSync(path, "utf8") });
  }
  return files;
}

function main() {
  let stat;
  try {
    stat = statSync(DIST_DIR);
  } catch {
    stat = null;
  }
  if (!stat?.isDirectory()) {
    console.error(
      `check-bundle-keys: ${DIST_DIR} not found; run \`vite build\` first`,
    );
    process.exit(1);
  }
  const hit = findLeak(readDist());
  if (hit) {
    console.error(
      `check-bundle-keys: ${hit.file} contains a leaked key (${hit.pattern})`,
    );
    process.exit(1);
  }
  console.log("check-bundle-keys: no provider key found in dist/");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
