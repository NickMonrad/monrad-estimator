-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "taxLabel" TEXT NOT NULL DEFAULT 'GST',
ADD COLUMN     "taxRate" DOUBLE PRECISION DEFAULT 10;

-- CreateTable
CREATE TABLE "NamedResource" (
    "id" TEXT NOT NULL,
    "resourceTypeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startWeek" INTEGER,
    "endWeek" INTEGER,
    "allocationPct" INTEGER NOT NULL DEFAULT 100,
    "pricingModel" TEXT NOT NULL DEFAULT 'ACTUAL_DAYS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NamedResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateCard" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateCardEntry" (
    "id" TEXT NOT NULL,
    "rateCardId" TEXT NOT NULL,
    "globalResourceTypeId" TEXT NOT NULL,
    "dayRate" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "RateCardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectDiscount" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "resourceTypeId" TEXT,
    "type" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectDiscount_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "NamedResource" ADD CONSTRAINT "NamedResource_resourceTypeId_fkey" FOREIGN KEY ("resourceTypeId") REFERENCES "ResourceType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateCardEntry" ADD CONSTRAINT "RateCardEntry_rateCardId_fkey" FOREIGN KEY ("rateCardId") REFERENCES "RateCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateCardEntry" ADD CONSTRAINT "RateCardEntry_globalResourceTypeId_fkey" FOREIGN KEY ("globalResourceTypeId") REFERENCES "GlobalResourceType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDiscount" ADD CONSTRAINT "ProjectDiscount_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDiscount" ADD CONSTRAINT "ProjectDiscount_resourceTypeId_fkey" FOREIGN KEY ("resourceTypeId") REFERENCES "ResourceType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
