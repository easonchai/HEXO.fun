// Copies target/idl/hex_vault.json into src/idl/ so Vite can bundle it.
// Re-run after every program rebuild: `pnpm --filter @hexvault/web sync-idl`.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const src = resolve(root, "target/idl/hex_vault.json");
const outDir = resolve(root, "apps/web/src/idl");
const out = resolve(outDir, "hex_vault.json");

const idl = JSON.parse(readFileSync(src, "utf8"));
if (idl.metadata?.name !== "hex_vault" || typeof idl.address !== "string") {
  throw new Error(`unexpected IDL at ${src}`);
}
mkdirSync(outDir, { recursive: true });
copyFileSync(src, out);
console.log(`synced ${src} -> ${out} (program ${idl.address})`);
