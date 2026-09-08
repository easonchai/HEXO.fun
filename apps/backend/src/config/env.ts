// spec.md §3.1. Vars with a listed default value fall back to it; the rest
// have none and fail the boot if missing — all of them at once, not one at a
// time, so a fresh checkout tells you everything it needs in one error.
const REQUIRED_KEYS = [
  "DATABASE_URL",
  "RPC_URL",
  "AUTHORITY_KEYPAIR",
  "HEXUSDC_MINT",
  "CORS_ORIGIN",
] as const;

// The program is mid-rewrite under this ID (see ticket 05). PROGRAM_ID isn't
// in spec's "no default" column, so an unset value falls back to it rather
// than failing boot.
export const DEFAULT_PROGRAM_ID = "LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6";

export interface HexVaultEnv {
  DATABASE_URL: string;
  RPC_URL: string;
  PROGRAM_ID: string;
  POOL_ID: string;
  AUTHORITY_KEYPAIR: string;
  HEXUSDC_MINT: string;
  APR_BPS: string;
  FAUCET_AMOUNT: string;
  FAUCET_INTERVAL_SECONDS: string;
  CORS_ORIGIN: string;
  PORT: string;
}

/** @nestjs/config `validate` hook: runs once at boot, on the raw process.env. */
export function validateEnv(env: Record<string, unknown>): HexVaultEnv {
  const missing = REQUIRED_KEYS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`missing required env vars: ${missing.join(", ")}`);
  }
  return {
    DATABASE_URL: String(env.DATABASE_URL),
    RPC_URL: String(env.RPC_URL),
    PROGRAM_ID: String(env.PROGRAM_ID ?? DEFAULT_PROGRAM_ID),
    POOL_ID: String(env.POOL_ID ?? "1"),
    AUTHORITY_KEYPAIR: String(env.AUTHORITY_KEYPAIR),
    HEXUSDC_MINT: String(env.HEXUSDC_MINT),
    APR_BPS: String(env.APR_BPS ?? "500"),
    FAUCET_AMOUNT: String(env.FAUCET_AMOUNT ?? "1000000000"),
    FAUCET_INTERVAL_SECONDS: String(env.FAUCET_INTERVAL_SECONDS ?? "3600"),
    CORS_ORIGIN: String(env.CORS_ORIGIN),
    PORT: String(env.PORT ?? "8080"),
  };
}
