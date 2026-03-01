-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "hoursPerDay" DOUBLE PRECISION NOT NULL DEFAULT 7.6;

-- AlterTable
ALTER TABLE "ResourceType" ADD COLUMN     "count" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "globalTypeId" TEXT,
ADD COLUMN     "proposedName" TEXT;

-- CreateTable
CREATE TABLE "GlobalResourceType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ResourceCategory" NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalResourceType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GlobalResourceType_name_key" ON "GlobalResourceType"("name");

-- AddForeignKey
ALTER TABLE "ResourceType" ADD CONSTRAINT "ResourceType_globalTypeId_fkey" FOREIGN KEY ("globalTypeId") REFERENCES "GlobalResourceType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
