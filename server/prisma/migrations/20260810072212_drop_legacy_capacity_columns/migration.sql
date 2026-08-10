/*
  Warnings:

  - You are about to drop the column `allocationEndWeek` on the `NamedResource` table. All the data in the column will be lost.
  - You are about to drop the column `allocationMode` on the `NamedResource` table. All the data in the column will be lost.
  - You are about to drop the column `allocationPct` on the `NamedResource` table. All the data in the column will be lost.
  - You are about to drop the column `allocationPercent` on the `NamedResource` table. All the data in the column will be lost.
  - You are about to drop the column `allocationStartWeek` on the `NamedResource` table. All the data in the column will be lost.
  - You are about to drop the column `endWeek` on the `NamedResource` table. All the data in the column will be lost.
  - You are about to drop the column `startWeek` on the `NamedResource` table. All the data in the column will be lost.
  - You are about to drop the column `allocationEndWeek` on the `ResourceType` table. All the data in the column will be lost.
  - You are about to drop the column `allocationMode` on the `ResourceType` table. All the data in the column will be lost.
  - You are about to drop the column `allocationPercent` on the `ResourceType` table. All the data in the column will be lost.
  - You are about to drop the column `allocationStartWeek` on the `ResourceType` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "NamedResource" DROP COLUMN "allocationEndWeek",
DROP COLUMN "allocationMode",
DROP COLUMN "allocationPct",
DROP COLUMN "allocationPercent",
DROP COLUMN "allocationStartWeek",
DROP COLUMN "endWeek",
DROP COLUMN "startWeek";

-- AlterTable
ALTER TABLE "ResourceType" DROP COLUMN "allocationEndWeek",
DROP COLUMN "allocationMode",
DROP COLUMN "allocationPercent",
DROP COLUMN "allocationStartWeek";
