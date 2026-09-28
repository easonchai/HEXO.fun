-- game-jackpot-pause ticket 02: the Pool mirror carries the game pause and
-- the jackpot pause. The default stays: false is what a pool created before
-- the program upgrade reads on chain, and the next indexer sync upserts the
-- real values either way.

-- AlterTable
ALTER TABLE "Pool" ADD COLUMN "gamePaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Pool" ADD COLUMN "jackpotPaused" BOOLEAN NOT NULL DEFAULT false;
