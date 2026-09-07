// Loaded from disk with fs.readFileSync, not `import ... from "*.json"`.
// The program is being rewritten concurrently with this scaffold, so the IDL
// shape will change after this ticket lands; a runtime read means a stale
// checked-in copy fails at boot with a clear error instead of silently
// baking a wrong shape into the compiled dist/ at tsc time.
//
// The file itself is a checked-in snapshot synced from target/idl/ by
// scripts/sync-idl.mjs (same approach as apps/web). Re-run that script after
// every program rebuild.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Idl } from "@anchor-lang/core";

export function loadIdl(): Idl {
  const path = join(__dirname, "..", "idl", "hex_vault.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(
      `no IDL at ${path}; run \`pnpm --filter @hexvault/backend sync-idl\` after building the program`,
      { cause },
    );
  }
  return JSON.parse(raw) as Idl;
}
