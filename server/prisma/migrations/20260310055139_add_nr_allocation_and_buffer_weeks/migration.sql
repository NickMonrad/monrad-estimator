-- AlterTable
ALTER TABLE "NamedResource" ADD COLUMN     "allocationEndWeek" DOUBLE PRECISION,
ADD COLUMN     "allocationMode" "AllocationMode" NOT NULL DEFAULT 'EFFORT',
ADD COLUMN     "allocationPercent" DOUBLE PRECISION NOT NULL DEFAULT 100,
ADD COLUMN     "allocationStartWeek" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "bufferWeeks" INTEGER NOT NULL DEFAULT 0;
