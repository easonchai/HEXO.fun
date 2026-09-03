/**
 * Creates the ORAO VRF request for one stored HexVault seed (devnet runbook
 * step 3 of docs/vrf-randomness.md). The program-side settle
 * (`hexvault randomness fulfill-vrf`) submits it once ORAO's quorum fulfills.
 *
 * Usage:
 *   pnpm exec tsx scripts/orao-request.ts <storedSeedHex> [--url <rpc>] [--keypair <path>]
 *
 * The seed is the 32 bytes stored in the HexVault RandomnessRequest account
 * (client seed already slot-hash-mixed by the program) — NOT the raw client
 * seed you passed to `hexvault randomness request`.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const ORAO_PROGRAM_ID = new PublicKey(
  "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y",
);
const NETWORK_STATE_SEED = Buffer.from("orao-vrf-network-configuration");
const REQUEST_SEED = Buffer.from("orao-vrf-randomness-request");
/** sha256("global:request")[..8] — ORAO's Anchor ix discriminator. */
const REQUEST_IX_DISCRIMINATOR = createHash("sha256")
  .update("global:request")
  .digest()
  .subarray(0, 8);

const args = process.argv.slice(2);
const seedHex = args.find((a) => !a.startsWith("--"));
const url =
  (args.find((a) => a.startsWith("--url=")) ?? "").split("=")[1] ??
  "https://api.devnet.solana.com";
const keypairPath =
  (args.find((a) => a.startsWith("--keypair=")) ?? "").split("=")[1] ??
  `${process.env.HOME}/.config/solana/id.json`;

if (!seedHex)
  throw new Error(
    "usage: orao-request.ts <storedSeedHex> [--url=] [--keypair=]",
  );
const clean = seedHex.startsWith("0x") ? seedHex.slice(2) : seedHex;
const seed = Buffer.from(clean, "hex");
if (seed.length !== 32)
  throw new Error(`seed must be 32 bytes, got ${seed.length}`);

const payer = Keypair.fromSecretKey(
  JSON.parse(fs.readFileSync(keypairPath.replace(/^--keypair=?/, ""), "utf8")),
);
const connection = new Connection(url, "confirmed");

const [networkState] = PublicKey.findProgramAddressSync(
  [NETWORK_STATE_SEED],
  ORAO_PROGRAM_ID,
);
const stateAccount = await connection.getAccountInfo(networkState);
if (!stateAccount)
  throw new Error(`ORAO network state missing at ${networkState.toBase58()}`);
// NetworkConfiguration borsh: authority 32B, treasury 32B, fee 8B, ...
const treasury = new PublicKey(stateAccount.data.subarray(8 + 32, 8 + 64));

const [request] = PublicKey.findProgramAddressSync(
  [REQUEST_SEED, networkState.toBuffer(), seed],
  ORAO_PROGRAM_ID,
);

const existing = await connection.getAccountInfo(request);
if (existing) {
  const fulfilled = existing.data.length >= 137 && existing.data[8] === 1;
  console.log(
    `orao request already exists at ${request.toBase58()} (${fulfilled ? "FULFILLED" : "pending"})`,
  );
} else {
  const ix = new TransactionInstruction({
    programId: ORAO_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: networkState, isSigner: false, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: request, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([REQUEST_IX_DISCRIMINATOR, seed]),
  });
  const signature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(ix),
    [payer],
  );
  console.log(`orao request created: ${request.toBase58()} tx ${signature}`);
}
console.log(`watch: solana account ${request.toBase58()} --url ${url}`);
