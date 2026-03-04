-- AlterTable
ALTER TABLE "Epic" ADD COLUMN     "featureMode" TEXT NOT NULL DEFAULT 'sequential',
ADD COLUMN     "timelineStartWeek" INTEGER;

-- CreateTable
CREATE TABLE "FeatureDependency" (
    "featureId" TEXT NOT NULL,
    "dependsOnId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureDependency_pkey" PRIMARY KEY ("featureId","dependsOnId")
);

-- AddForeignKey
ALTER TABLE "FeatureDependency" ADD CONSTRAINT "FeatureDependency_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureDependency" ADD CONSTRAINT "FeatureDependency_dependsOnId_fkey" FOREIGN KEY ("dependsOnId") REFERENCES "Feature"("id") ON DELETE CASCADE ON UPDATE CASCADE;
