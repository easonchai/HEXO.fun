/**
 * e2e fixtures: creates the accepted-asset stand-in mint (classic SPL, 6
 * decimals) and funds the deployer and the second player wallet.
 * Usage: pnpm exec tsx scripts/e2e-fixtures.ts <player-keypair.json>
 * Prints the mint address on the last line.
 */
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import fs from "node:fs";

const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const playerFile = process.argv[2];
if (!playerFile)
  throw new Error("usage: tsx scripts/e2e-fixtures.ts <player-keypair.json>");

const connection = new Connection(rpc, "confirmed");
const load = (path: string): Keypair =>
  Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(path, "utf8"))),
  );
const payer = load(process.env.HOME + "/.config/solana/id.json");
const player = load(playerFile);

const sig = await connection.requestAirdrop(
  player.publicKey,
  10 * LAMPORTS_PER_SOL,
);
const latest = await connection.getLatestBlockhash();
await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");

const mint = await createMint(connection, payer, payer.publicKey, null, 6);
const payerAta = (
  await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    payer.publicKey,
  )
).address;
const playerAta = (
  await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    player.publicKey,
  )
).address;
await mintTo(connection, payer, mint, payerAta, payer, 1_000_000_000n);
await mintTo(connection, payer, mint, playerAta, payer, 500_000_000n);
console.log(mint.toBase58());
