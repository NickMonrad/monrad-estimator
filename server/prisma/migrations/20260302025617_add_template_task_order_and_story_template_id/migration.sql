-- AlterTable
ALTER TABLE "TemplateTask" ADD COLUMN     "order" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "UserStory" ADD COLUMN     "appliedTemplateId" TEXT;
