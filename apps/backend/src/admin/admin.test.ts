// The stdout/stderr contract of the admin CLI (runbook.md "Mainnet: the
// admin is a Squads multisig"): `admin ... | pbcopy` has to hand Squads one
// base58 transaction and nothing else, while every human-readable line goes
// to stderr. A wrong split here is invisible in a terminal, where both
// streams land on the same screen, and only shows up as a paste Squads
// rejects.
//
// The chain is a fake: `run` is driven directly, so no env is read, no
// connection is opened, and the instructions are the real ones built off the
// checked-in IDL.
import {
  AnchorProvider,
  BN,
  Program,
  Wallet,
  type Idl,
} from "@anchor-lang/core";
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type AccountInfo,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChainService } from "../chain/chain.service";
import { loadIdl } from "../chain/idl";
import {
  jackpotVaultAddress,
  poolAddress,
  principalVaultAddress,
} from "../chain/pda";
import { createInvite, run, type InviteCodeStore } from "./index";
import type { AdminMode } from "./squads";

const PROGRAM_ID = new PublicKey("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");
const POOL = poolAddress(PROGRAM_ID, 1n);
const MINT = Keypair.generate().publicKey;
const BLOCKHASH = PublicKey.default.toBase58();

// Never reached: every account is passed explicitly, so Anchor resolves none.
const idl = { ...loadIdl(), address: PROGRAM_ID.toBase58() } as Idl;
const program = new Program(
  idl,
  new AnchorProvider(
    new Connection("http://127.0.0.1:1"),
    new Wallet(Keypair.generate()),
    {},
  ),
);

const bn = (value: bigint | number): BN => new BN(value.toString());

const poolFields = {
  poolId: bn(1),
  admin: Keypair.generate().publicKey,
  operator: Keypair.generate().publicKey,
  acceptedMint: MINT,
  principalVault: principalVaultAddress(PROGRAM_ID, POOL),
  jackpotVault: jackpotVaultAddress(PROGRAM_ID, POOL),
  treasury: Keypair.generate().publicKey,
  buybackReserve: Keypair.generate().publicKey,
  house: Keypair.generate().publicKey,
  vrfNetworkState: Keypair.generate().publicKey,
  epochSeconds: bn(86_400),
  epochAnchor: bn(1_789_315_200),
  roundSeconds: bn(60),
  closeBuffer: bn(5),
  vrfTimeout: bn(120),
  minDeposit: bn(1_000_000),
  paused: false,
  currentEpochId: bn(1),
  currentEpochStart: bn(0),
  currentEpochEndsAt: bn(0),
  previousEpochStart: bn(0),
  previousEpochEndsAt: bn(0),
  nextRoundId: bn(1),
  openRoundId: bn(0),
  carryPot: bn(0),
  totalPrincipal: bn(0),
  bump: 255,
  principalVaultBump: 254,
  jackpotVaultBump: 253,
};

/** A six-decimal mint account, for `withdraw-principal`'s `getMint`. */
function mintAccount(): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return {
    data,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    lamports: 1,
    rentEpoch: 0,
  };
}

interface Harness {
  chain: ChainService;
  /** Instruction batches the local-mode path signed and sent. */
  sent: TransactionInstruction[][];
}

async function harness(): Promise<Harness> {
  const poolData = await program.coder.accounts.encode("pool", poolFields);
  const sent: TransactionInstruction[][] = [];
  const connection = {
    getAccountInfo: async (
      address: PublicKey,
    ): Promise<AccountInfo<Buffer> | null> => {
      if (address.equals(POOL)) {
        return {
          data: poolData,
          owner: PROGRAM_ID,
          executable: false,
          lamports: 1,
          rentEpoch: 0,
        };
      }
      if (address.equals(MINT)) return mintAccount();
      // The admin's token account: absent, so withdraw-principal has to
      // prepend its creation to the same transaction.
      return null;
    },
    getLatestBlockhash: async () => ({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1,
    }),
  };
  const chain = {
    program,
    programId: PROGRAM_ID,
    keypair: Keypair.generate(),
    connection,
    poolAddress: () => POOL,
    principalVaultAddress: () => principalVaultAddress(PROGRAM_ID, POOL),
    jackpotVaultAddress: () => jackpotVaultAddress(PROGRAM_ID, POOL),
    send: async (instructions: TransactionInstruction[]): Promise<string> => {
      sent.push(instructions);
      return "signature";
    },
  } as unknown as ChainService;
  return { chain, sent };
}

/** Everything the two streams received while `body` ran, as lines. */
async function capture(body: () => Promise<void>): Promise<{
  stdout: string[];
  stderr: string[];
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const collect = (into: string[]) =>
    vi.fn((chunk: string | Uint8Array) => {
      into.push(String(chunk));
      return true;
    });
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(collect(stdout));
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(collect(stderr));
  try {
    await body();
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  const lines = (chunks: string[]): string[] =>
    chunks.join("").split("\n").filter((line) => line.length > 0);
  return { stdout: lines(stdout), stderr: lines(stderr) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin run", () => {
  it("set-params in local mode signs, and writes nothing to stdout", async () => {
    const { chain, sent } = await harness();
    const mode: AdminMode = { signer: chain.keypair.publicKey, multisig: false };

    const { stdout, stderr } = await capture(() =>
      run({ kind: "set-params", params: { epochSeconds: 3_600 } }, chain, mode),
    );

    expect(sent).toHaveLength(1);
    expect(stdout).toEqual([]);
    // The signature is a log line like any other, so it belongs on stderr.
    expect(stderr[0]).toMatch(/^signature /);
    expect(stderr).toHaveLength(2);
  });

  it("unpause in multisig mode prints one base58 transaction and nothing else", async () => {
    const { chain, sent } = await harness();
    const multisigVault = Keypair.generate().publicKey;
    const mode: AdminMode = { signer: multisigVault, multisig: true };

    const { stdout, stderr } = await capture(() =>
      run({ kind: "unpause" }, chain, mode),
    );

    // Nothing signed: the key is not in this process.
    expect(sent).toEqual([]);
    expect(stdout).toHaveLength(1);
    const tx = Transaction.from(bs58.decode(stdout[0] as string));
    // Squads signs it; every slot has to still be empty on the way out.
    expect(tx.signatures.every((entry) => entry.signature === null)).toBe(true);
    expect(tx.feePayer?.equals(multisigVault)).toBe(true);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    expect(tx.instructions).toHaveLength(1);
    // The multisig vault, not the loaded key, is what the program checks.
    expect(
      tx.instructions[0]?.keys.some(
        (key) => key.isSigner && key.pubkey.equals(multisigVault),
      ),
    ).toBe(true);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("withdraw-principal in multisig mode prints one line carrying both instructions", async () => {
    const { chain, sent } = await harness();
    const multisigVault = Keypair.generate().publicKey;
    const mode: AdminMode = { signer: multisigVault, multisig: true };

    const { stdout, stderr } = await capture(() =>
      run({ kind: "withdraw-principal", amount: "12.5" }, chain, mode),
    );

    expect(sent).toEqual([]);
    expect(stdout).toHaveLength(1);
    const tx = Transaction.from(bs58.decode(stdout[0] as string));
    // The destination ATA does not exist yet, so its idempotent creation
    // rides along in front of admin_withdraw.
    expect(tx.instructions).toHaveLength(2);
    expect(tx.feePayer?.equals(multisigVault)).toBe(true);
    // 12.5 USDC against the mint's six decimals, in the summary on stderr.
    expect(stderr.join("\n")).toContain("12500000 atomic");
    // No part of the human-readable summary leaked into the paste.
    expect(stdout[0]).not.toContain(" ");
  });
});

interface CreatedInvite {
  code: string;
  ownerWallet: string | null;
  maxUses: number;
  uses: number;
  createdAt: bigint;
}

/** An in-memory stand-in for the one Prisma call `createInvite` makes, so
 *  this exercises the real dispatch logic without a database. */
function fakeInviteStore(): { store: InviteCodeStore; created: CreatedInvite[] } {
  const created: CreatedInvite[] = [];
  return {
    store: {
      inviteCode: {
        create: async ({ data }) => {
          created.push(data);
          return data;
        },
      },
    },
    created,
  };
}

describe("createInvite", () => {
  it("writes one code per --count to the store and prints each on stdout", async () => {
    const { store, created } = fakeInviteStore();
    const owner = Keypair.generate().publicKey;

    const { stdout, stderr } = await capture(() =>
      createInvite(store, { kind: "create-invite", maxUses: 5, count: 3, owner }),
    );

    expect(created).toHaveLength(3);
    expect(new Set(created.map((row) => row.code)).size).toBe(3);
    for (const row of created) {
      expect(row.code).toHaveLength(8);
      expect(row.ownerWallet).toBe(owner.toBase58());
      expect(row.maxUses).toBe(5);
      expect(row.uses).toBe(0);
    }
    expect(stdout).toHaveLength(3);
    expect(stderr).toEqual([]);
  });

  it("stores no owner when --owner is not given", async () => {
    const { store, created } = fakeInviteStore();
    await createInvite(store, { kind: "create-invite", maxUses: 1, count: 1 });
    expect(created).toHaveLength(1);
    expect(created[0]?.ownerWallet).toBeNull();
  });
});
