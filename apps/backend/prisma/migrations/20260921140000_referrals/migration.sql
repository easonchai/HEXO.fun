-- Referral binding and qualification (docs/plan/hexo-referrals ticket 07). A
-- new table, so this is a plain CreateTable, not the add-with-default shape
-- 20260920020000 and 20260921120000 use for columns landing on rows that
-- already exist. No foreign key to InviteCode, same reason InviteRedemption
-- has none: deleting a code (the only way to revoke it) must not touch a
-- Referral already bound from it.

-- CreateTable
CREATE TABLE "Referral" (
    "referee" TEXT NOT NULL,
    "referrer" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "boundAt" BIGINT NOT NULL,
    "aboveSince" BIGINT,
    "principal" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("referee")
);

-- CreateIndex
CREATE INDEX "Referral_referrer_idx" ON "Referral"("referrer");
