// Scans the built assets for a leaked provider RPC key (production-hardening
// ticket 07 / spec.md item 7). Run after `vite build`; package.json's `check`
// script chains build then this. `findLeak` is the pure part, exported so
// check-bundle-keys.test.ts can drive it against fixture text instead of
// real files on disk.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const DIST_DIR = resolve(here, "../dist");

// `api-key=` and the Helius host are the two spec.md names explicitly; the
// rest are the other RPC providers this repo's docs mention as options
// (runbook.md, docs/ops/environments.md), matched on their token in the URL.
export const PATTERNS = [
  { name: "api-key query param", re: /api-key=/i },
  { name: "Helius RPC host", re: /helius-rpc\.com\/\?/i },
  { name: "QuickNode token", re: /quiknode\.pro\/[a-z0-9]{16,}/i },
  { name: "Alchemy token", re: /alchemy\.com\/v2\/[a-z0-9_-]{16,}/i },
  { name: "Triton token", re: /rpcpool\.com\/[a-z0-9_-]{16,}/i },
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
