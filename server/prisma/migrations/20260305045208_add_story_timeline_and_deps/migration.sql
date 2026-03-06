-- CreateTable
CREATE TABLE "StoryDependency" (
    "storyId" TEXT NOT NULL,
    "dependsOnId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryDependency_pkey" PRIMARY KEY ("storyId","dependsOnId")
);

-- CreateTable
CREATE TABLE "StoryTimelineEntry" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "startWeek" DOUBLE PRECISION NOT NULL,
    "durationWeeks" DOUBLE PRECISION NOT NULL,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoryTimelineEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoryTimelineEntry_storyId_key" ON "StoryTimelineEntry"("storyId");

-- AddForeignKey
ALTER TABLE "StoryDependency" ADD CONSTRAINT "StoryDependency_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "UserStory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryDependency" ADD CONSTRAINT "StoryDependency_dependsOnId_fkey" FOREIGN KEY ("dependsOnId") REFERENCES "UserStory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryTimelineEntry" ADD CONSTRAINT "StoryTimelineEntry_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "UserStory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryTimelineEntry" ADD CONSTRAINT "StoryTimelineEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
