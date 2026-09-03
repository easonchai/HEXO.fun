import { PublicKey } from "@solana/web3.js";

import type { Context } from "./client.js";

export const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

export interface AnchorInstruction {
  keys: unknown[];
  programId: PublicKey;
  data: Buffer;
}

interface Builder {
  accounts(a: Record<string, unknown>): Builder;
  instruction(): Promise<AnchorInstruction>;
}

type Methods = Record<string, (...args: unknown[]) => Builder>;

/** Anchor method builder without generated types. */
export function method(ctx: Context, name: string, args: unknown[]): Builder {
  const methods = ctx.program.methods as unknown as Methods;
  const entry = methods[name];
  if (!entry) throw new Error(`IDL has no instruction ${name}`);
  return entry(...args);
}

export type AnyAccounts = Record<
  string,
  {
    fetchNullable(address: PublicKey): Promise<unknown>;
    fetch(address: PublicKey): Promise<unknown>;
  }
>;

/** CLI name -> Anchor runtime account namespace key (camelCase of the IDL type). */
const ACCOUNT_TYPES: Record<string, string> = {
  config: "protocolConfig",
  request: "randomnessRequest",
};

/** Decodes an Anchor account, or returns null when it does not exist yet. */
export async function fetchAccount(
  ctx: Context,
  name: string,
  address: PublicKey,
): Promise<Record<string, unknown> | null> {
  const accounts = ctx.program.account as unknown as AnyAccounts;
  const account = accounts[ACCOUNT_TYPES[name] ?? name];
  if (!account) throw new Error(`IDL has no account ${name}`);
  const raw = await account.fetchNullable(address);
  return (raw ?? null) as Record<string, unknown> | null;
}

export async function fetchAccountStrict(
  ctx: Context,
  name: string,
  address: PublicKey,
  missing: string,
): Promise<Record<string, unknown>> {
  const account = await fetchAccount(ctx, name, address);
  if (!account) throw new Error(missing);
  return account;
}
