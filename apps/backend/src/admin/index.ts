// One-off admin CLI: set-params, pause, unpause, fund-jackpot, fund-yield,
// grant-tickets, withdraw-principal, set-operator, propose-admin,
// accept-admin, create-invite. Same shape as ../bootstrap.ts (plain tsx script, no command
// framework, argument parsing split into its own file for a chain-free unit
// test) but this pool already exists, so unlike bootstrap this reuses
// ChainService and the same full .env the backend itself runs on, instead of
// re-deriving connections and PDAs by hand.
//
// In local mode stdout carries nothing; every line (including the tx
// signature) goes to stderr, matching bootstrap.ts's stdout/stderr split. In
// multisig mode stdout carries exactly one line, the base58 transaction, so
// `admin ... | pbcopy` hands Squads something it can import. create-invite
// touches no chain at all, so it never reaches `run()`; its own lines
// (each code, one per line) go to stdout instead, for the same reason:
// `admin create-invite ... | pbcopy` or a script should get codes and
// nothing else.
import "reflect-metadata"; // ChainService's @Injectable()/@Inject() decorators need this; NestFactory normally pulls it in, but there is no Nest app here.
import { existsSync } from "node:fs";

import { BN } from "@anchor-lang/core";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import { generateInviteCode } from "../api/invite-code";
import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { validateEnv } from "../config/env";
import { decodePool, type PoolState } from "../operator/chain-state";
import {
  atomicUsdc,
  checkRegistrationWindow,
  parseAdminCommand,
  type AdminCommand,
  type SetParamsInput,
} from "./args";
import {
  checkLedgerAddress,
  ledgerSigner,
  parseAdminKeypair,
  type AdminSigner,
} from "./ledger";
import { adminMode, encodeForSquads, type AdminMode } from "./squads";

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

/**
 * Every admin-gated command ends here. Local mode signs and sends with the
 * loaded key, as it always did, unless a Ledger is loaded (ticket 09), in
 * which case it signs and sends through that instead. Multisig mode prints
 * the unsigned transaction on stdout and nothing else, for Squads to import.
 */
async function submit(
  chain: ChainService,
  mode: AdminMode,
  instructions: TransactionInstruction[],
  summary: string,
  ledger?: AdminSigner,
): Promise<void> {
  if (!mode.multisig) {
    const signature = ledger
      ? await sendWithLedger(chain, ledger, instructions)
      : await chain.send(instructions);
    log(`signature ${signature}`);
    log(summary);
    return;
  }
  // Same "finalized" blockhash as ChainService.send, and for the same
  // reason: a "confirmed" one from a load-balanced pool is unknown to nodes
  // a few slots behind, and Squads simulates the import against its own.
  const { blockhash } = await chain.connection.getLatestBlockhash("finalized");
  process.stdout.write(`${encodeForSquads(instructions, mode.signer, blockhash)}\n`);
  log(summary);
  log(
    `unsigned, signer and fee payer ${mode.signer.toBase58()}; paste into Squads' "Import base58 encoded tx" now, the blockhash expires in about a minute`,
  );
}

/**
 * Builds, signs through the Ledger and sends: `chain.send`'s shape, but for a
 * signer that never hands over a `Keypair` for `chain.send`'s own signature
 * to use. Confirms with web3.js's own poll rather than `chain.send`'s
 * subscription-first wait, since an admin command runs once, off the hot
 * crank path that wait is tuned for.
 * ponytail: no dropped-subscription handling like chain.send's; upgrade if a
 * Ledger command needs the same drop detection the operator's sends get.
 */
async function sendWithLedger(
  chain: ChainService,
  ledger: AdminSigner,
  instructions: TransactionInstruction[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await chain.connection.getLatestBlockhash("finalized");
  const tx = new Transaction({
    blockhash,
    lastValidBlockHeight,
    feePayer: ledger.publicKey,
  }).add(...instructions);
  log("confirm on the Ledger");
  let signed: Transaction;
  try {
    signed = await ledger.signTransaction(tx);
  } catch (cause) {
    throw new Error("Ledger signing failed", { cause });
  }
  const signature = await chain.connection.sendRawTransaction(signed.serialize());
  const confirmation = await chain.connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (confirmation.value.err) {
    throw new Error(
      `transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`,
    );
  }
  return signature;
}

// `set_pause` takes the admin or the operator when pausing and the admin
// alone when unpausing. Pausing therefore always signs locally, whichever of
// the two keys is loaded; unpausing goes through `submit` because on mainnet
// the admin is the multisig.
async function pause(chain: ChainService): Promise<void> {
  const ix = await method(chain, "setPause", true)
    .accountsPartial({ signer: chain.keypair.publicKey, pool: chain.poolAddress() })
    .instruction();
  log(`signature ${await chain.send([ix])}`);
  log("pool paused");
}

async function unpause(
  chain: ChainService,
  mode: AdminMode,
  ledger?: AdminSigner,
): Promise<void> {
  const ix = await method(chain, "setPause", false)
    .accountsPartial({ signer: mode.signer, pool: chain.poolAddress() })
    .instruction();
  await submit(chain, mode, [ix], "unpause the pool", ledger);
}

function bnOrNull(value: number | undefined): BN | null {
  return value === undefined ? null : new BN(value);
}

async function setParams(
  chain: ChainService,
  mode: AdminMode,
  params: SetParamsInput,
  ledger?: AdminSigner,
): Promise<void> {
  // args.ts already compared the window against --epoch-seconds when both
  // were given; with only the window, the epoch it has to beat is the
  // pool's, and the program would reject it with InvalidParameter.
  if (params.registrationWindow !== undefined && params.epochSeconds === undefined) {
    checkRegistrationWindow(
      params.registrationWindow,
      Number((await readPool(chain)).epochSeconds),
    );
  }
  const ix = await method(chain, "setParams", {
    epochSeconds: bnOrNull(params.epochSeconds),
    epochAnchor: bnOrNull(params.epochAnchor),
    roundSeconds: bnOrNull(params.roundSeconds),
    closeBuffer: bnOrNull(params.closeBuffer),
    vrfTimeout: bnOrNull(params.vrfTimeout),
    minDeposit: params.minDeposit === undefined ? null : new BN(params.minDeposit.toString()),
    houseCutBps: params.houseCutBps === undefined ? null : params.houseCutBps,
    minJackpot:
      params.minJackpot === undefined ? null : new BN(params.minJackpot.toString()),
    registrationWindow: bnOrNull(params.registrationWindow),
    payoutTimeout: bnOrNull(params.payoutTimeout),
    baseRateBps: params.baseRateBps ?? null,
    ticketsPerUsdc: params.ticketsPerUsdc ?? null,
    bonusCapBps: params.bonusCapBps ?? null,
  })
    .accountsPartial({ admin: mode.signer, pool: chain.poolAddress() })
    .instruction();
  await submit(
    chain,
    mode,
    [ix],
    "set params (epoch/round changes apply to the next epoch/round, not the open one)",
    ledger,
  );
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

/**
 * Tops up `Pool.yield_budget` with real USDC, same shape as `fundJackpot`
 * (permissionless, signs locally with whatever key is loaded) but into
 * `principal_vault` instead of the jackpot vault.
 */
async function fundYield(chain: ChainService, amount: bigint): Promise<void> {
  const pool = await readPool(chain);
  const source = getAssociatedTokenAddressSync(pool.acceptedMint, chain.keypair.publicKey);
  const ix = await method(chain, "fundYield", new BN(amount.toString()))
    .accountsPartial({
      sourceAuthority: chain.keypair.publicKey,
      pool: pool.address,
      acceptedMint: pool.acceptedMint,
      source,
      principalVault: chain.principalVaultAddress(pool.address),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  log(`signature ${await chain.send([ix])}`);
  log(`yield budget funded with ${amount} atomic units from ${source.toBase58()}`);
}

/**
 * The admin path of `grant_tickets`: uncapped, for the rare manual fix. The
 * referral job (docs/plan/hexo-referrals ticket 08) is the only intended
 * caller of the operator path, which signs with the operator key directly
 * through `OperatorInstructions` rather than this CLI.
 */
async function grantTickets(
  chain: ChainService,
  mode: AdminMode,
  owner: PublicKey,
  amount: bigint,
  ledger?: AdminSigner,
): Promise<void> {
  const ix = await method(chain, "grantTickets", new BN(amount.toString()))
    .accountsPartial({
      signer: mode.signer,
      pool: chain.poolAddress(),
      player: chain.playerAddress(owner),
    })
    .instruction();
  await submit(
    chain,
    mode,
    [ix],
    `grant ${amount} tickets to ${owner.toBase58()} (admin path, uncapped)`,
    ledger,
  );
}

/**
 * Moves principal out of the vault to the admin's associated token account,
 * which the program checks by address. The amount is scaled by the mint's
 * own decimals rather than an assumed six, because this is the one command
 * that moves depositors' money.
 */
async function withdrawPrincipal(
  chain: ChainService,
  mode: AdminMode,
  amount: string,
  ledger?: AdminSigner,
): Promise<void> {
  const pool = await readPool(chain);
  const { decimals } = await getMint(chain.connection, pool.acceptedMint);
  const atomic = atomicUsdc(amount, decimals);
  // Off-curve is allowed on purpose: a Squads vault is a PDA, and its ATA
  // derives the same way.
  const adminToken = getAssociatedTokenAddressSync(pool.acceptedMint, mode.signer, true);

  const instructions: TransactionInstruction[] = [];
  if ((await chain.connection.getAccountInfo(adminToken)) === null) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        mode.signer,
        adminToken,
        mode.signer,
        pool.acceptedMint,
      ),
    );
  }
  instructions.push(
    await method(chain, "adminWithdraw", new BN(atomic.toString()))
      .accountsPartial({
        admin: mode.signer,
        pool: pool.address,
        acceptedMint: pool.acceptedMint,
        adminToken,
        principalVault: chain.principalVaultAddress(pool.address),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  );
  await submit(
    chain,
    mode,
    instructions,
    `withdraw ${amount} USDC (${atomic} atomic) of principal to ${adminToken.toBase58()}`,
    ledger,
  );
}

/** The slice of PrismaClient `createInvite` needs, so `admin.test.ts` can
 *  drive it with an in-memory fake instead of a real Postgres. */
export interface InviteCodeStore {
  inviteCode: {
    create(args: {
      data: {
        code: string;
        ownerWallet: string | null;
        maxUses: number;
        uses: number;
        createdAt: bigint;
      };
    }): Promise<unknown>;
  };
}

/**
 * Writes `command.count` fresh codes to Postgres and prints each one, one per
 * line, to stdout. Never touches the chain, so `main()` calls this instead of
 * `run()` and skips building a ChainService for it altogether.
 */
export async function createInvite(
  store: InviteCodeStore,
  command: Extract<AdminCommand, { kind: "create-invite" }>,
): Promise<void> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (let i = 0; i < command.count; i++) {
    const code = generateInviteCode();
    await store.inviteCode.create({
      data: {
        code,
        ownerWallet: command.owner?.toBase58() ?? null,
        maxUses: command.maxUses,
        uses: 0,
        createdAt: now,
      },
    });
    process.stdout.write(`${code}\n`);
  }
}

/**
 * The command dispatch, exported so `admin.test.ts` can drive it with a
 * fabricated ChainService and watch what lands on stdout against stderr.
 * `main.ts` is the entry point that actually invokes it, so importing this
 * file never touches an env or a network. `create-invite` never reaches
 * here; `main()` handles it before this is called.
 */
export async function run(
  command: AdminCommand,
  chain: ChainService,
  mode: AdminMode,
  ledger?: AdminSigner,
): Promise<void> {
  switch (command.kind) {
    case "pause":
      return pause(chain);
    case "unpause":
      return unpause(chain, mode, ledger);
    case "set-params":
      return setParams(chain, mode, command.params, ledger);
    case "fund-jackpot":
      return fundJackpot(chain, command.amount);
    case "fund-yield":
      return fundYield(chain, command.amount);
    case "grant-tickets":
      return grantTickets(chain, mode, command.owner, command.amount, ledger);
    case "withdraw-principal":
      return withdrawPrincipal(chain, mode, command.amount, ledger);
    case "set-operator": {
      const ix = await method(chain, "setOperator", command.key)
        .accountsPartial({ admin: mode.signer, pool: chain.poolAddress() })
        .instruction();
      return submit(
        chain,
        mode,
        [ix],
        `set the operator to ${command.key.toBase58()}`,
        ledger,
      );
    }
    case "propose-admin": {
      const ix = await method(chain, "proposeAdmin", command.key)
        .accountsPartial({ admin: mode.signer, pool: chain.poolAddress() })
        .instruction();
      return submit(
        chain,
        mode,
        [ix],
        `propose ${command.key.toBase58()} as the next admin; it then runs accept-admin`,
        ledger,
      );
    }
    // Signed by the pending admin, which is whoever is taking the pool over:
    // the loaded key when a person is, ADMIN_ADDRESS when the multisig is.
    case "accept-admin": {
      const ix = await method(chain, "acceptAdmin")
        .accountsPartial({ pendingAdmin: mode.signer, pool: chain.poolAddress() })
        .instruction();
      return submit(
        chain,
        mode,
        [ix],
        `accept the admin role as ${mode.signer.toBase58()}`,
        ledger,
      );
    }
  }
}

export async function main(): Promise<void> {
  // Same file and precedence as Nest's ConfigModule: process.env wins.
  if (existsSync(".env")) process.loadEnvFile();

  // Argument parsing happens before any env or network access, so a typo'd
  // command or a missing flag fails instantly with no chain touched.
  const command = parseAdminCommand(process.argv.slice(2));

  const env = validateEnv(process.env);

  if (command.kind === "create-invite") {
    const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    try {
      await createInvite(prisma, command);
    } finally {
      await prisma.$disconnect();
    }
    return;
  }

  const connection = new Connection(env.RPC_URL, "confirmed");
  // Built directly, not through Nest DI: this script never boots a Nest
  // application, so ChainService's own constructor is the whole wiring.
  const chain = new ChainService(connection, new ConfigService<HexVaultEnv, true>(env));

  const ledger = await loadLedgerSigner(env.ADMIN_ADDRESS);
  const mode = adminMode(env.ADMIN_ADDRESS, ledger?.publicKey ?? chain.keypair.publicKey);
  log(
    `signer ${chain.keypair.publicKey.toBase58()} on ${connection.rpcEndpoint}, pool ${chain.poolAddress().toBase58()}`,
  );
  if (ledger) {
    log(`admin signer is the Ledger at ${ledger.publicKey.toBase58()}`);
  }
  if (mode.multisig) {
    log(`admin is ${mode.signer.toBase58()}, not the loaded key: nothing will be sent`);
  }

  await run(command, chain, mode, ledger);
}

/**
 * ADMIN_KEYPAIR is admin-CLI-only (nothing else reads it), so it lives
 * outside HexVaultEnv/validateEnv, same as bootstrap.ts's own ad hoc env
 * reads. Unset, or anything that isn't a usb://ledger URI, returns
 * `undefined`: signing stays on chain.keypair exactly as before this ticket.
 */
async function loadLedgerSigner(
  adminAddress: string | undefined,
): Promise<AdminSigner | undefined> {
  const selector = parseAdminKeypair(process.env.ADMIN_KEYPAIR);
  if (!selector.ledger) return undefined;
  // Dynamic import: these two packages talk to real USB hardware at import
  // time, so this only runs (and only needs to work) when ADMIN_KEYPAIR
  // actually asks for a Ledger. admin.test.ts never sets it, so the test
  // suite never touches USB.
  const [{ default: TransportNodeHid }, { default: Solana }] = await Promise.all([
    import("@ledgerhq/hw-transport-node-hid"),
    import("@ledgerhq/hw-app-solana"),
  ]);
  const transport = await TransportNodeHid.create();
  const ledger = await ledgerSigner(new Solana(transport), selector.account);
  checkLedgerAddress(ledger.publicKey, adminAddress);
  return ledger;
}

/** Same cause-chain print as bootstrap.ts: the outer message names the step
 *  (here, just "admin"), the innermost names the RPC or program error. */
export function reportFailure(error: unknown): void {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    log(e === error ? `admin: ${e.message}` : `  caused by: ${e.message}`);
  }
  process.exitCode = 1;
}
