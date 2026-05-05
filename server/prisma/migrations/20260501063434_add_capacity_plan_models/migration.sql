-- AlterEnum
ALTER TYPE "AllocationMode" ADD VALUE 'CAPACITY_PLAN';

-- CreateTable
CREATE TABLE "CapacityPlan" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetWeeks" INTEGER NOT NULL,
    "periodWeeks" INTEGER NOT NULL,
    "maxDelta" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "totalCost" DOUBLE PRECISION,
    "deliveryWeeks" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapacityPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapacityPlanPeriod" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "periodIndex" INTEGER NOT NULL,
    "startWeek" INTEGER NOT NULL,
    "endWeek" INTEGER NOT NULL,

    CONSTRAINT "CapacityPlanPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapacityPlanEntry" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "resourceTypeId" TEXT NOT NULL,
    "headcount" INTEGER NOT NULL,
    "demandFTE" DOUBLE PRECISION NOT NULL,
    "utilisationPct" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "CapacityPlanEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CapacityPlan_projectId_idx" ON "CapacityPlan"("projectId");

-- CreateIndex
CREATE INDEX "CapacityPlanPeriod_planId_idx" ON "CapacityPlanPeriod"("planId");

-- CreateIndex
CREATE INDEX "CapacityPlanEntry_periodId_idx" ON "CapacityPlanEntry"("periodId");

-- AddForeignKey
ALTER TABLE "CapacityPlan" ADD CONSTRAINT "CapacityPlan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityPlanPeriod" ADD CONSTRAINT "CapacityPlanPeriod_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CapacityPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityPlanEntry" ADD CONSTRAINT "CapacityPlanEntry_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "CapacityPlanPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
