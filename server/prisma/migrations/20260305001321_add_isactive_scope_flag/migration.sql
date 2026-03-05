-- AlterTable
ALTER TABLE "Epic" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Feature" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "UserStory" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;
