-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_resourceTypeId_fkey";

-- AlterTable
ALTER TABLE "Task" ALTER COLUMN "resourceTypeId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_resourceTypeId_fkey" FOREIGN KEY ("resourceTypeId") REFERENCES "ResourceType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
