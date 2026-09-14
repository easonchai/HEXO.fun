-- Same reason as 20260910071958_pool_epoch_grid: the container's start
-- command is `prisma migrate deploy && node dist/main.js`, and a row for the
-- abandoned pool/round is still in the table there, so the new columns land
-- with a default and drop it again. 0 for one indexer tick; the next
-- `syncAccounts` upserts the real values off chain.

-- AlterTable
ALTER TABLE "Pool" ADD COLUMN     "houseCutBps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Pool" ALTER COLUMN "houseCutBps" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Round" ADD COLUMN     "houseCut" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Round" ALTER COLUMN "houseCut" DROP DEFAULT;
