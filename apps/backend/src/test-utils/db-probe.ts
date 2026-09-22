// Ops-and-envs ticket 14 (husky pre-push): the suites in api/, indexer/ and
// operator/ that talk to a real Postgres need a yes/no answer before
// `describe.skipIf` collects their tests, so a wrong password or an
// unreachable server (Docker down, or another project's Postgres answering
// on the port these suites expect) skips them cleanly instead of failing
// `pnpm test:unit` and the pre-push hook.
//
// That answer has to be synchronous: `describe.skipIf` runs at collection
// time, before any `it` starts, and this package's tsconfig targets
// `commonjs`, which rules out top-level `await`. A child process is the way
// to get an async Prisma connection attempt back onto the sync side, so the
// probe shells out to `node -e` rather than calling `$connect()` in-process.
import { execFileSync } from "node:child_process";

const PROBE_SCRIPT = `
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: process.argv[1] });
const timeoutMs = Number(process.argv[2]);
const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("db probe timed out")), timeoutMs));
Promise.race([prisma.$connect(), timeout])
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
`;

const cache = new Map<string, boolean>();

/** Probes `url` once per test run (cached) and reports whether it accepted a
 *  real connection within `timeoutMs`. Never throws. */
export function isDatabaseReachableSync(url: string, timeoutMs = 1500): boolean {
  const cached = cache.get(url);
  if (cached !== undefined) return cached;

  let reachable: boolean;
  try {
    execFileSync(process.execPath, ["-e", PROBE_SCRIPT, url, String(timeoutMs)], {
      stdio: "ignore",
      timeout: timeoutMs + 1000,
    });
    reachable = true;
  } catch {
    reachable = false;
  }
  cache.set(url, reachable);
  return reachable;
}
