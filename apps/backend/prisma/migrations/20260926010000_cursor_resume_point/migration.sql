-- The catch-up walk's own resume point (pre-mainnet review): the live
-- onLogs path used to move `lastSignature`, which is also where the
-- finalized catch-up walk stopped listing, so a transaction the socket
-- dropped or whose logs were not readable yet was never replayed once a
-- newer live one moved the cursor past it. Nullable, like `updatedAt` in
-- 20260905144252, and backfilled from the old cursor: until now
-- `lastSignature` was exactly the walk's stop point, so the first sweep on
-- the new column resumes from where the last one on the old column ended.

-- AlterTable
ALTER TABLE "Cursor" ADD COLUMN     "resumeSignature" TEXT;
ALTER TABLE "Cursor" ADD COLUMN     "resumeSlot" BIGINT;
UPDATE "Cursor" SET "resumeSignature" = "lastSignature", "resumeSlot" = "lastSlot";
