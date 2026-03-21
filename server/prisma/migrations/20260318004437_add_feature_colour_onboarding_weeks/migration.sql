-- AlterTable
ALTER TABLE "Feature" ADD COLUMN     "timelineColour" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "onboardingWeeks" INTEGER NOT NULL DEFAULT 0;
