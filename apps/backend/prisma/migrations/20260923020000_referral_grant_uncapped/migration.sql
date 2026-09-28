-- Adds ReferralGrant.uncapped (referral-page ticket 04, spec.md "Referral
-- grant gains uncapped"): the grant a referrer would get without their own
-- Principal cap, with the pool-wide scale-down still applied. Existing rows
-- have no own-cap/pool-scale breakdown to recompute from, so they default to
-- `amount` (i.e. the own-Principal cap read as not having bound), same as
-- spec.md's own rule "uncapped == amount" when that cap doesn't bind.
--
-- A literal column DEFAULT can't reference another column, so this is
-- add-nullable, backfill, then require, rather than the
-- add-with-DEFAULT-0-then-drop shape the other tables in this file use for a
-- placeholder value.

-- AlterTable
ALTER TABLE "ReferralGrant" ADD COLUMN "uncapped" BIGINT;
UPDATE "ReferralGrant" SET "uncapped" = "amount" WHERE "uncapped" IS NULL;
ALTER TABLE "ReferralGrant" ALTER COLUMN "uncapped" SET NOT NULL;
