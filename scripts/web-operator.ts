/**
 * Operator bot for the web e2e / localnet demo: keeps the round loop running
 * while a human (or Playwright) plays the browser app. Every 3 seconds:
 *   - a round past its close is drawn (request + mock fulfill), and
 *   - once a round settles, the next round is created while the epoch lasts.
 * Uses the ops CLI's own primitives; the program enforces every gate.
 */
import { createContext, fetchPool, pda } from "../packages/cli/src/client.ts";
import {
  fulfillRandomness,
  requestRandomness,
  roundCreate,
  roundShow,
} from "../packages/cli/src/user-ops.ts";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const POOL_ID = BigInt(process.env.POOL_ID ?? "1");
const INTERVAL_MS = Number(process.env.OPERATOR_INTERVAL_MS ?? "3000");
const MAX_ROUNDS = Number(process.env.OPERATOR_MAX_ROUNDS ?? "6");
const ROUND_SECONDS = Number(process.env.OPERATOR_ROUND_SECONDS ?? "150");
const BONUS = process.env.OPERATOR_BONUS ?? "50000";

const ctx = createContext({ url: RPC }, true);
// PDA helpers derive against the deployed program id; bind before any use.
pda.bind(ctx.programId);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function chainNow(): Promise<bigint> {
  const slot = await ctx.connection.getSlot("finalized");
  const blockTime = await ctx.connection.getBlockTime(slot);
  return BigInt(blockTime ?? 0);
}

const quiet = async (
  action: () => Promise<unknown>,
): Promise<unknown | null> => {
  try {
    return await action();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    // Expected contention: round not closed yet / already requested / exists.
    if (
      !/RoundClosed|InvalidRoundState|already in use|InstructionFallbackNotFound|Custom\s*:\s*6\d{4}/.test(
        text,
      )
    ) {
      console.log(`[operator] ${text.split("\n")[0]}`);
    }
    return null;
  }
};

async function tick(): Promise<void> {
  const pool = await fetchPool(ctx, POOL_ID);
  const now = await chainNow();
  if (pool.latestEpochId <= 0n) return;

  let roundId = 1n;
  for (;;) {
    const round = await quiet(() => roundShow(ctx, POOL_ID, roundId));
    if (!round || Number(round.epochId) !== Number(pool.latestEpochId)) break;
    const endsAt = BigInt(round.endsAt);

    if (Number(round.status) === 0 && now >= endsAt) {
      await quiet(() => requestRandomness(ctx, "round", POOL_ID, roundId));
      await quiet(() =>
        fulfillRandomness(
          ctx,
          "round",
          POOL_ID,
          roundId,
          String(now * 7919n + roundId),
        ),
      );
      return; // settle takes effect next tick
    }

    // Requested but not yet fulfilled: retry the fulfill (the request may
    // have raced the close, or an earlier fulfill tx may have failed).
    if (Number(round.status) === 1) {
      await quiet(() =>
        fulfillRandomness(
          ctx,
          "round",
          POOL_ID,
          roundId,
          String(now * 104729n + roundId),
        ),
      );
      return;
    }

    if (Number(round.status) === 2) {
      if (roundId >= BigInt(MAX_ROUNDS)) return;
      const next = roundId + 1n;
      const nextRound = await quiet(() => roundShow(ctx, POOL_ID, next));
      if (nextRound && Number(nextRound.epochId) === Number(pool.latestEpochId)) {
        // Round `next` already exists: inspect it this tick instead of
        // returning, so the loop keeps advancing past a settled round.
        roundId = next;
        continue;
      }
      const created = await quiet(() =>
        roundCreate(ctx, POOL_ID, {
          roundId: next.toString(),
          starts: now.toString(),
          ends: (now + BigInt(ROUND_SECONDS)).toString(),
          bonus: BONUS,
        }),
      );
      if (created) console.log(`[operator] round ${next} opened`);
      return;
    }

    roundId += 1n;
  }

  // No round exists yet in this epoch: open round 1.
  if (roundId === 1n) {
    const created = await quiet(() =>
      roundCreate(ctx, POOL_ID, {
        roundId: "1",
        starts: now.toString(),
        ends: (now + BigInt(ROUND_SECONDS)).toString(),
        bonus: BONUS,
      }),
    );
    if (created) console.log("[operator] round 1 opened");
  }
}

console.log(`[operator] watching pool ${POOL_ID} on ${RPC}`);
for (;;) {
  await quiet(tick);
  await sleep(INTERVAL_MS);
}
