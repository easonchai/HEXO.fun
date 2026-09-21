-- Invite codes gate the private beta (docs/plan/hexo-referrals ticket 06). No
-- foreign key from InviteRedemption.code to InviteCode: deleting a code (the
-- only way to revoke one) must not touch redemptions that already happened.

-- CreateTable
CREATE TABLE "InviteCode" (
    "code" TEXT NOT NULL,
    "ownerWallet" TEXT,
    "maxUses" INTEGER NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "InviteRedemption" (
    "wallet" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "redeemedAt" BIGINT NOT NULL,

    CONSTRAINT "InviteRedemption_pkey" PRIMARY KEY ("wallet")
);

-- CreateIndex
CREATE INDEX "InviteCode_ownerWallet_idx" ON "InviteCode"("ownerWallet");
