-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "startDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "durationDays" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "TimelineEntry" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "featureId" TEXT NOT NULL,
    "startWeek" INTEGER NOT NULL,
    "durationWeeks" INTEGER NOT NULL,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimelineEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TimelineEntry_featureId_key" ON "TimelineEntry"("featureId");

-- AddForeignKey
ALTER TABLE "TimelineEntry" ADD CONSTRAINT "TimelineEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEntry" ADD CONSTRAINT "TimelineEntry_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature"("id") ON DELETE CASCADE ON UPDATE CASCADE;
