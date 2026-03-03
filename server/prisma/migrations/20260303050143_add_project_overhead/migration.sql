-- CreateEnum
CREATE TYPE "OverheadType" AS ENUM ('PERCENTAGE', 'FIXED_DAYS');

-- CreateTable
CREATE TABLE "ProjectOverhead" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "resourceTypeId" TEXT,
    "type" "OverheadType" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectOverhead_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ProjectOverhead" ADD CONSTRAINT "ProjectOverhead_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectOverhead" ADD CONSTRAINT "ProjectOverhead_resourceTypeId_fkey" FOREIGN KEY ("resourceTypeId") REFERENCES "ResourceType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
