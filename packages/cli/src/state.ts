import fs from "node:fs";
import path from "node:path";

import { assertion } from "./errors.js";

const FILE_RE = /^pool-(\d+)-mints\.json$/;

export interface PoolMintsFile {
  poolId: string;
  pool: string;
  acceptedMint: string;
  principalMint: string;
  entryMint: string;
  principalMintSecretKey: string;
  entryMintSecretKey: string;
  createdAt: string;
}

export function listPoolFiles(
  stateDir: string,
): { poolId: bigint; file: string }[] {
  if (!fs.existsSync(stateDir)) return [];
  return fs
    .readdirSync(stateDir)
    .map((f) => FILE_RE.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ poolId: BigInt(m[1]!), file: path.join(stateDir, m[0]) }))
    .sort((a, b) => (a.poolId < b.poolId ? -1 : 1));
}

export function readPoolMints(
  stateDir: string,
  poolId: bigint,
): PoolMintsFile | undefined {
  const file = poolMintsPath(stateDir, poolId);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as PoolMintsFile;
}

export function poolMintsPath(stateDir: string, poolId: bigint): string {
  return path.join(stateDir, `pool-${poolId}-mints.json`);
}

export function writePoolMints(
  stateDir: string,
  poolId: bigint,
  value: PoolMintsFile,
): string {
  const file = poolMintsPath(stateDir, poolId);
  fs.mkdirSync(stateDir, { recursive: true });
  if (fs.existsSync(file)) {
    throw assertion(`refusing to overwrite existing ${file}`);
  }
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  return file;
}
