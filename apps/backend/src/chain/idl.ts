// Loaded from disk with fs.readFileSync, not `import ... from "*.json"`.
// The program is being rewritten concurrently with this scaffold, so the IDL
// shape will change after this ticket lands; a runtime read means a stale
// checked-in copy fails at boot with a clear error instead of silently
// baking a wrong shape into the compiled dist/ at tsc time.
//
// The file itself is a checked-in snapshot synced from target/idl/ by
// scripts/sync-idl.mjs (same approach as apps/web). Re-run that script after
// every program rebuild.
//
// Ticket 01: the committed snapshot can be for the wrong environment (e.g.
// devnew's program id, and devnew is never built with `--features
// test-vrf`, so it is also missing the `testFulfill` instruction the
// operator's test-vrf detection looks for). `tests/run-local.sh` points a
// localnet run at the just-built target/idl/hex_vault.json instead, via this
// env var, rather than overwriting the committed file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Idl } from "@anchor-lang/core";

export function loadIdl(): Idl {
  const path = process.env.HEXVAULT_IDL_PATH ?? join(__dirname, "..", "idl", "hex_vault.json");
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
