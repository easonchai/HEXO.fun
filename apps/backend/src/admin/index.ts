// One-off admin CLI: set-params, pause, unpause, fund-jackpot. Same shape as
// ../bootstrap.ts (plain tsx script, no command framework, argument parsing
// split into its own file for a chain-free unit test) but this pool already
// exists, so unlike bootstrap this reuses ChainService and the same full
// .env the backend itself runs on, instead of re-deriving connections and
// PDAs by hand.
//
// stdout carries nothing; every line (including the tx signature) goes to
// stderr, matching bootstrap.ts's stdout/stderr split.
import "reflect-metadata"; // ChainService's @Injectable()/@Inject() decorators need this; NestFactory normally pulls it in, but there is no Nest app here.
import { existsSync } from "node:fs";

import { BN } from "@anchor-lang/core";
import { ConfigService } from "@nestjs/config";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { validateEnv } from "../config/env";
import { decodePool, type PoolState } from "../operator/chain-state";
import { parseAdminCommand, type AdminCommand, type SetParamsInput } from "./args";

const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/**
 * `Program<Idl>`'s methods namespace is a plain index signature (no codegen
 * for a generic Idl), so a stale IDL turns into a clear error here instead of
 * "cannot invoke undefined" at the call site. Same shape as
 * OperatorInstructions.method in ../operator/instructions.ts; not shared with
 * it because that class is built around round/epoch progression, not the
 * three plain calls this file makes.
 */
interface MethodBuilder {
  accountsPartial(accounts: Record<string, PublicKey>): {
    instruction(): Promise<TransactionInstruction>;
  };
}
type MethodFactory = (...args: unknown[]) => MethodBuilder;

function method(chain: ChainService, name: string, ...args: unknown[]): MethodBuilder {
  const factory = (chain.program.methods as Record<string, MethodFactory | undefined>)[
    name
  ];
  if (!factory) {
    throw new Error(
      `instruction ${name} is missing from the IDL; run \`pnpm --filter @hexvault/backend sync-idl\``,
    );
  }
  return factory(...args);
}

async function readPool(chain: ChainService): Promise<PoolState> {
  const address = chain.poolAddress();
  const info = await chain.connection.getAccountInfo(address);
  if (!info) {
    throw new Error(
      `pool ${address.toBase58()} not found on this cluster; has bootstrap run?`,
    );
  }
  return decodePool(chain.program, address, info.data);
}

async function setPause(chain: ChainService, paused: boolean): Promise<void> {
  const ix = await method(chain, "setPause", paused)
    .accountsPartial({ authority: chain.keypair.publicKey, pool: chain.poolAddress() })
    .instruction();
  log(`signature ${await chain.send([ix])}`);
  log(`pool ${paused ? "paused" : "unpaused"}`);
}

function bnOrNull(value: number | undefined): BN | null {
  return value === undefined ? null : new BN(value);
}

async function setParams(chain: ChainService, params: SetParamsInput): Promise<void> {
  const ix = await method(chain, "setParams", {
    epochSeconds: bnOrNull(params.epochSeconds),
    // TODO(ticket 03): resolve from --epoch-anchor
    epochAnchor: null,
    roundSeconds: bnOrNull(params.roundSeconds),
    closeBuffer: bnOrNull(params.closeBuffer),
    vrfTimeout: bnOrNull(params.vrfTimeout),
    minDeposit: params.minDeposit === undefined ? null : new BN(params.minDeposit.toString()),
  })
    .accountsPartial({ authority: chain.keypair.publicKey, pool: chain.poolAddress() })
    .instruction();
  log(`signature ${await chain.send([ix])}`);
  log("params updated (epoch/round changes apply to the next epoch/round, not the open one)");
}

// ponytail: unlike the operator's automatic fundJackpot (operator/instructions.ts),
// this does not mint a shortfall first. An admin topping up the jackpot by
// hand is expected to already hold hexUSDC (see the runbook's minting
// recipe). Auto-minting here would silently paper over a genuinely
// out-of-funds authority. Upgrade path: a --mint-shortfall flag if that
// friction turns out to matter.
async function fundJackpot(chain: ChainService, amount: bigint): Promise<void> {
  const pool = await readPool(chain);
  const source = getAssociatedTokenAddressSync(pool.acceptedMint, chain.keypair.publicKey);
  const ix = await method(chain, "fundJackpot", new BN(amount.toString()))
    .accountsPartial({
      sourceAuthority: chain.keypair.publicKey,
      pool: pool.address,
      acceptedMint: pool.acceptedMint,
      source,
      jackpotVault: chain.jackpotVaultAddress(pool.address),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  log(`signature ${await chain.send([ix])}`);
  log(`jackpot funded with ${amount} atomic units from ${source.toBase58()}`);
}

async function run(command: AdminCommand, chain: ChainService): Promise<void> {
  switch (command.kind) {
    case "pause":
      return setPause(chain, true);
    case "unpause":
      return setPause(chain, false);
    case "set-params":
      return setParams(chain, command.params);
    case "fund-jackpot":
      return fundJackpot(chain, command.amount);
  }
}

async function main(): Promise<void> {
  // Same file and precedence as Nest's ConfigModule: process.env wins.
  if (existsSync(".env")) process.loadEnvFile();

  // Argument parsing happens before any env or network access, so a typo'd
  // command or a missing flag fails instantly with no chain touched.
  const command = parseAdminCommand(process.argv.slice(2));

  const env = validateEnv(process.env);
  const connection = new Connection(env.RPC_URL, "confirmed");
  // Built directly, not through Nest DI: this script never boots a Nest
  // application, so ChainService's own constructor is the whole wiring.
  const chain = new ChainService(connection, new ConfigService<HexVaultEnv, true>(env));
  log(
    `authority ${chain.keypair.publicKey.toBase58()} on ${connection.rpcEndpoint}, pool ${chain.poolAddress().toBase58()}`,
  );

  await run(command, chain);
}

main().catch((error: unknown) => {
  // Same cause-chain print as bootstrap.ts: outer message names the step
  // (here, just "admin"), innermost names the RPC or program error.
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    log(e === error ? `admin: ${e.message}` : `  caused by: ${e.message}`);
  }
  process.exitCode = 1;
});
