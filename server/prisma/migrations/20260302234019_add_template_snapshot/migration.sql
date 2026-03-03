-- CreateTable
CREATE TABLE "TemplateSnapshot" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "label" TEXT,
    "trigger" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateSnapshot_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "TemplateSnapshot" ADD CONSTRAINT "TemplateSnapshot_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "FeatureTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
