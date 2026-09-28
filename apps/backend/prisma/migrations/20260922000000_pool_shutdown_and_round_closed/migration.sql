-- Pool.version/shutdown and Round.closed (ops-and-envs tickets 01-05, 08).
-- Same shape as 20260921120000: the deployed container runs
-- `prisma migrate deploy` with rows already in the tables, so each new
-- NOT NULL column lands with a default and drops it again. Those
-- placeholders live for one indexer tick; the next sync upserts the real
-- values off chain. Round.closed keeps its default: nothing but the
-- RoundClosed event handler ever sets it true, so a fresh mirrored row is
-- correctly "not closed" forever until that event lands.

-- AlterTable
ALTER TABLE "Pool" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Pool" ALTER COLUMN "version" DROP DEFAULT;
ALTER TABLE "Pool" ADD COLUMN     "shutdown" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Pool" ALTER COLUMN "shutdown" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Round" ADD COLUMN     "closed" BOOLEAN NOT NULL DEFAULT false;
