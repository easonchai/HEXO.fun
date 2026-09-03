/** IDL copy synced from target/idl/hex_vault.json (see scripts/sync-idl.mjs). */
import type { Idl } from "@anchor-lang/core";

import rawIdl from "./idl/hex_vault.json";

export const idl = rawIdl as unknown as Idl;

export const PROGRAM_ID_STRING = idl.address as string;
