/**
 * Funds an arbitrary wallet (by pubkey, e.g. the browser's deterministic dev
 * burner) with the e2e test asset. Run after scripts/e2e-fixtures.ts has
 * created the mint.
 * Usage: pnpm exec tsx scripts/fund-wallet.ts <owner-pubkey> <mint-pubkey>
 * Airdrops 5 SOL for fees and mints 500 USDC (6 decimals).
 */
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import fs from "node:fs";

const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const owner = new PublicKey(process.argv[2] ?? "");
const mint = new PublicKey(process.argv[3] ?? "");
if (!owner || !mint) {
  throw new Error(
    "usage: tsx scripts/fund-wallet.ts <owner-pubkey> <mint-pubkey>",
  );
}

const connection = new Connection(rpc, "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(
    JSON.parse(
      fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8"),
    ),
  ),
);

const airdrop = await connection.requestAirdrop(owner, 5 * LAMPORTS_PER_SOL);
const latest = await connection.getLatestBlockhash();
await connection.confirmTransaction(
  { signature: airdrop, ...latest },
  "confirmed",
);

const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
const tx = new Transaction();
if (!(await connection.getAccountInfo(ata))) {
  tx.add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner,
      mint,
      TOKEN_PROGRAM_ID,
    ),
  );
}
tx.add(createMintToInstruction(mint, ata, payer.publicKey, 500_000_000n));
const signature = await connection.sendTransaction(tx, [payer]);
await connection.confirmTransaction(signature, "confirmed");
console.log(ata.toBase58());
