-- AlterTable
ALTER TABLE "GlobalResourceType" ADD COLUMN     "defaultDayRate" DOUBLE PRECISION,
ADD COLUMN     "defaultHoursPerDay" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "ResourceType" ADD COLUMN     "dayRate" DOUBLE PRECISION,
ADD COLUMN     "hoursPerDay" DOUBLE PRECISION;
