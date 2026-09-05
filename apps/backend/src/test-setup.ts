// vitest setupFiles run before a test file's own imports, which matters here:
// importing ConfigModule evaluates `NestConfigModule.forRoot({ validate })`
// immediately (it's inside the `@Module()` decorator argument), so these env
// vars have to exist before any test file imports config.module.
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.RPC_URL ??= "http://127.0.0.1:8899";
process.env.AUTHORITY_KEYPAIR ??= bs58.encode(Keypair.generate().secretKey);
process.env.HEXUSDC_MINT ??= Keypair.generate().publicKey.toBase58();
process.env.CORS_ORIGIN ??= "http://localhost:5173";
process.env.POOL_ID ??= "1";
