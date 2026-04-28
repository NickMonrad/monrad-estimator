-- CreateTable
CREATE TABLE "EpicDependency" (
    "epicId" TEXT NOT NULL,
    "dependsOnId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EpicDependency_pkey" PRIMARY KEY ("epicId","dependsOnId")
);

-- AddForeignKey
ALTER TABLE "EpicDependency" ADD CONSTRAINT "EpicDependency_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "Epic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpicDependency" ADD CONSTRAINT "EpicDependency_dependsOnId_fkey" FOREIGN KEY ("dependsOnId") REFERENCES "Epic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
