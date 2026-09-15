-- AlterTable
ALTER TABLE "FeatureTemplate" ADD COLUMN     "assumptions" TEXT;

-- AlterTable
ALTER TABLE "TemplateTask" ADD COLUMN     "assumptions" TEXT,
ADD COLUMN     "description" TEXT;
