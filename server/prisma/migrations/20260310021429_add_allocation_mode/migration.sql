-- CreateEnum
CREATE TYPE "AllocationMode" AS ENUM ('EFFORT', 'TIMELINE', 'FULL_PROJECT');

-- AlterTable
ALTER TABLE "ResourceType" ADD COLUMN     "allocationEndWeek" DOUBLE PRECISION,
ADD COLUMN     "allocationMode" "AllocationMode" NOT NULL DEFAULT 'TIMELINE',
ADD COLUMN     "allocationPercent" DOUBLE PRECISION NOT NULL DEFAULT 100,
ADD COLUMN     "allocationStartWeek" DOUBLE PRECISION;

-- Backfill: existing resources use EFFORT (no behaviour change for live data)
UPDATE "ResourceType" SET "allocationMode" = 'EFFORT';
