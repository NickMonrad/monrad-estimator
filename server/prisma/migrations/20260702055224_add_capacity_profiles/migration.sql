-- CreateEnum
CREATE TYPE "CapacityProfileOwnerKind" AS ENUM ('ROLE', 'NAMED_PERSON', 'PLANNED_RESOURCE');

-- CreateEnum
CREATE TYPE "CapacityProfilePlanningBasis" AS ENUM ('DEMAND_FOLLOWING', 'AVAILABILITY_WINDOW', 'WHOLE_PROJECT_ALLOCATION', 'CAPACITY_PROFILE');

-- CreateEnum
CREATE TYPE "CapacityProfileSource" AS ENUM ('FIXED', 'MANUAL', 'AVAILABILITY_WINDOW', 'SQUAD_PLANNER', 'IMPORTED', 'DERIVED', 'LEGACY');

-- CreateTable
CREATE TABLE "CapacityProfile" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "resourceTypeId" TEXT,
    "namedResourceId" TEXT,
    "ownerKind" "CapacityProfileOwnerKind" NOT NULL,
    "planningBasis" "CapacityProfilePlanningBasis" NOT NULL,
    "source" "CapacityProfileSource" NOT NULL,
    "defaultPercent" DOUBLE PRECISION,
    "startWeek" DOUBLE PRECISION,
    "endWeek" DOUBLE PRECISION,
    "legacy" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapacityProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapacitySegment" (
    "id" TEXT NOT NULL,
    "capacityProfileId" TEXT NOT NULL,
    "startWeek" DOUBLE PRECISION NOT NULL,
    "endWeek" DOUBLE PRECISION NOT NULL,
    "capacityPercent" DOUBLE PRECISION NOT NULL,
    "source" "CapacityProfileSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapacitySegment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CapacityProfile_projectId_idx" ON "CapacityProfile"("projectId");

-- CreateIndex
CREATE INDEX "CapacityProfile_resourceTypeId_idx" ON "CapacityProfile"("resourceTypeId");

-- CreateIndex
CREATE INDEX "CapacityProfile_namedResourceId_idx" ON "CapacityProfile"("namedResourceId");

-- CreateIndex
CREATE INDEX "CapacitySegment_capacityProfileId_idx" ON "CapacitySegment"("capacityProfileId");

-- AddForeignKey
ALTER TABLE "CapacityProfile" ADD CONSTRAINT "CapacityProfile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityProfile" ADD CONSTRAINT "CapacityProfile_resourceTypeId_fkey" FOREIGN KEY ("resourceTypeId") REFERENCES "ResourceType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityProfile" ADD CONSTRAINT "CapacityProfile_namedResourceId_fkey" FOREIGN KEY ("namedResourceId") REFERENCES "NamedResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacitySegment" ADD CONSTRAINT "CapacitySegment_capacityProfileId_fkey" FOREIGN KEY ("capacityProfileId") REFERENCES "CapacityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
