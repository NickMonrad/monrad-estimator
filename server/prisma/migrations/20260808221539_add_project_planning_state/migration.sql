-- CreateEnum
CREATE TYPE "ProjectPlanningState" AS ENUM ('CURRENT', 'NEEDS_REPLAN');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "planningState" "ProjectPlanningState" NOT NULL DEFAULT 'CURRENT';
