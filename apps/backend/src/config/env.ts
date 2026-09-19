// spec.md §3.1. Vars with a listed default value fall back to it; the rest
// have none and fail the boot if missing — all of them at once, not one at a
// time, so a fresh checkout tells you everything it needs in one error.
import { Logger } from "@nestjs/common";

const REQUIRED_KEYS = [
  "DATABASE_URL",
  "RPC_URL",
  "OPERATOR_KEYPAIR",
  "ACCEPTED_MINT",
  "CORS_ORIGIN",
] as const;

// The program is mid-rewrite under this ID (see ticket 05). PROGRAM_ID isn't
// in spec's "no default" column, so an unset value falls back to it rather
// than failing boot.
export const DEFAULT_PROGRAM_ID = "LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6";

/** SOL the operator is warned about falling below, in `/status`. */
export const DEFAULT_OPERATOR_SOL_WARN = "0.3";

export interface HexVaultEnv {
  DATABASE_URL: string;
  RPC_URL: string;
  PROGRAM_ID: string;
  POOL_ID: string;
  /** The hot crank key. The admin's key is never in this env. */
  OPERATOR_KEYPAIR: string;
  /** Pool admin, base58 pubkey. Read for CLI targeting only; absent means
   * the locally loaded keypair is treated as the admin too. */
  ADMIN_ADDRESS?: string;
  /** The mint the pool takes deposits in: the test mint on devnet, real
   *  USDC on mainnet. Named HEXUSDC_MINT before the mainnet work. */
  ACCEPTED_MINT: string;
  /** SOL below which `/status` flags the operator as running out of fees. */
  OPERATOR_SOL_WARN: string;
  FAUCET_AMOUNT: string;
  FAUCET_INTERVAL_SECONDS: string;
  CORS_ORIGIN: string;
  PORT: string;
  /** Sparring player secret, base58. Absent switches the Sparring player off. */
  SPARRING_KEYPAIR?: string;
}

/** @nestjs/config `validate` hook: runs once at boot, on the raw process.env. */
export function validateEnv(env: Record<string, unknown>): HexVaultEnv {
  if (!env.ACCEPTED_MINT && env.HEXUSDC_MINT) {
    new Logger("env").warn("HEXUSDC_MINT is deprecated; rename it to ACCEPTED_MINT");
  }
  const acceptedMint = env.ACCEPTED_MINT ?? env.HEXUSDC_MINT;
  const missing = REQUIRED_KEYS.filter((key) =>
    key === "ACCEPTED_MINT" ? !acceptedMint : !env[key],
  );
  if (missing.length > 0) {
    throw new Error(`missing required env vars: ${missing.join(", ")}`);
  }
  return {
    DATABASE_URL: String(env.DATABASE_URL),
    RPC_URL: String(env.RPC_URL),
    PROGRAM_ID: String(env.PROGRAM_ID ?? DEFAULT_PROGRAM_ID),
    POOL_ID: String(env.POOL_ID ?? "1"),
    OPERATOR_KEYPAIR: String(env.OPERATOR_KEYPAIR),
    ACCEPTED_MINT: String(acceptedMint),
    OPERATOR_SOL_WARN: String(env.OPERATOR_SOL_WARN ?? DEFAULT_OPERATOR_SOL_WARN),
    FAUCET_AMOUNT: String(env.FAUCET_AMOUNT ?? "1000000000"),
    FAUCET_INTERVAL_SECONDS: String(env.FAUCET_INTERVAL_SECONDS ?? "3600"),
    CORS_ORIGIN: String(env.CORS_ORIGIN),
    PORT: String(env.PORT ?? "8080"),
    // Spread rather than assigned: under `exactOptionalPropertyTypes` an
    // optional key cannot be set to `undefined`, and "absent" is the switch.
    ...(env.ADMIN_ADDRESS ? { ADMIN_ADDRESS: String(env.ADMIN_ADDRESS) } : {}),
    ...(env.SPARRING_KEYPAIR
      ? { SPARRING_KEYPAIR: String(env.SPARRING_KEYPAIR) }
      : {}),
  };
}
