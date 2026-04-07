-- CreateIndex
CREATE INDEX "BacklogSnapshot_projectId_createdAt_idx" ON "BacklogSnapshot"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Epic_projectId_order_idx" ON "Epic"("projectId", "order");

-- CreateIndex
CREATE INDEX "Feature_epicId_order_idx" ON "Feature"("epicId", "order");

-- CreateIndex
CREATE INDEX "NamedResource_resourceTypeId_idx" ON "NamedResource"("resourceTypeId");

-- CreateIndex
CREATE INDEX "OrganisationMember_userId_idx" ON "OrganisationMember"("userId");

-- CreateIndex
CREATE INDEX "ProjectDiscount_projectId_idx" ON "ProjectDiscount"("projectId");

-- CreateIndex
CREATE INDEX "ProjectOverhead_projectId_idx" ON "ProjectOverhead"("projectId");

-- CreateIndex
CREATE INDEX "ResourceType_projectId_idx" ON "ResourceType"("projectId");

-- CreateIndex
CREATE INDEX "StoryTimelineEntry_projectId_idx" ON "StoryTimelineEntry"("projectId");

-- CreateIndex
CREATE INDEX "Task_userStoryId_idx" ON "Task"("userStoryId");

-- CreateIndex
CREATE INDEX "TimelineEntry_projectId_idx" ON "TimelineEntry"("projectId");

-- CreateIndex
CREATE INDEX "UserStory_featureId_order_idx" ON "UserStory"("featureId", "order");
