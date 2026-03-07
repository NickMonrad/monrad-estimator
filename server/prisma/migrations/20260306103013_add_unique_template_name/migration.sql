/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `FeatureTemplate` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "FeatureTemplate_name_key" ON "FeatureTemplate"("name");

-- AddForeignKey
ALTER TABLE "UserStory" ADD CONSTRAINT "UserStory_appliedTemplateId_fkey" FOREIGN KEY ("appliedTemplateId") REFERENCES "FeatureTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
