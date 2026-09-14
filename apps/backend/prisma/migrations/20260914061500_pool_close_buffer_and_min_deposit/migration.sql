-- The browser reads these two off the API now (ticket 07) rather than off the
-- chain, so they have to be in the mirror. Same shape as 20260911041631: the
-- deployed container runs `prisma migrate deploy` with a pool row already in
-- the table, so the columns land with a default and drop it again. 0 for one
-- indexer tick; the next `syncAccounts` upserts the real values off chain.

-- AlterTable
ALTER TABLE "Pool" ADD COLUMN     "closeBuffer" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Pool" ALTER COLUMN "closeBuffer" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Pool" ADD COLUMN     "minDeposit" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Pool" ALTER COLUMN "minDeposit" DROP DEFAULT;
