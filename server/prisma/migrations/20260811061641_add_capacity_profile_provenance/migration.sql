/*
  Issue #405: replace the overloaded CapacityProfile.legacy JSON with the
  explicit nullable CapacityProfileProvenance enum, backfill recognised
  behavioural provenance deterministically, then drop the legacy column.

  Backfill predicates mirror the pre-#405 runtime provenance checks exactly
  (see capacityProfileProvenance.ts for the shared pure predicates used by
  the V4 snapshot translation):

  - ROLE_DEFAULT                 — system-generated NAMED_PERSON role-default
                                   clone (source DERIVED + legacy writer
                                   'ROLE_DEFAULT'), the classifier's
                                   isRoleDefaultClone contract.
  - RESOURCE_OPTIMISER           — optimiser-owned scalar NAMED_PERSON profile
                                   (source DERIVED, planningBasis
                                   AVAILABILITY_WINDOW, valid availability
                                   window, legacy writer 'RESOURCE_OPTIMISER'
                                   + version 1), the optimiser's
                                   isOptimiserDerivedProfile contract.
  - TRANSFERRED_FROM_SQUAD_PLANNER — Squad Planner → manual transferred
                                   PLANNED_RESOURCE profile (source MANUAL,
                                   planningBasis CAPACITY_PROFILE, legacy
                                   writer 'transfer-to-manual') whose
                                   independent capacity is suppressed by the
                                   scheduler while the manual ROLE profile is
                                   authoritative.
  - LEGACY_MAPPER                — strict mapper-derived ROLE or NAMED_PERSON
                                   profile satisfying the complete existing
                                   strict mapper contract (7-key legacy
                                   payload, known allocationMode pair,
                                   profile/legacy shape agreement, finite
                                   nullable values). Any other legacy JSON
                                   (manual-editor projections, ROLE transfer
                                   metadata, unknown payloads) is NOT promoted
                                   and becomes provenance NULL.

  The predicates are mutually exclusive: ROLE_DEFAULT / RESOURCE_OPTIMISER
  require source DERIVED with distinct writers; TRANSFERRED requires
  ownerKind PLANNED_RESOURCE; LEGACY_MAPPER requires a 7-key mapper payload
  with a recognised (source, planningBasis) pair, which the other writers
  never produce.
*/
-- CreateEnum
CREATE TYPE "CapacityProfileProvenance" AS ENUM ('LEGACY_MAPPER', 'ROLE_DEFAULT', 'RESOURCE_OPTIMISER', 'TRANSFERRED_FROM_SQUAD_PLANNER');

-- AlterTable: add the nullable provenance column before backfill
ALTER TABLE "CapacityProfile" ADD COLUMN "provenance" "CapacityProfileProvenance";

-- ── Backfill ROLE_DEFAULT (valid system-generated NAMED_PERSON clone) ───────
UPDATE "CapacityProfile" SET "provenance" = 'ROLE_DEFAULT'
WHERE "ownerKind" = 'NAMED_PERSON'
  AND "resourceTypeId" IS NULL
  AND "namedResourceId" IS NOT NULL
  AND "source" = 'DERIVED'
  AND jsonb_typeof("legacy") = 'object'
  AND "legacy"->>'writer' = 'ROLE_DEFAULT';

-- ── Backfill RESOURCE_OPTIMISER (optimiser-owned scalar profile) ────────────
UPDATE "CapacityProfile" SET "provenance" = 'RESOURCE_OPTIMISER'
WHERE "ownerKind" = 'NAMED_PERSON'
  AND "resourceTypeId" IS NULL
  AND "namedResourceId" IS NOT NULL
  AND "source" = 'DERIVED'
  AND "planningBasis" = 'AVAILABILITY_WINDOW'
  -- hasValidAvailabilityWindow: defaultPercent finite, window edges
  -- null-or-finite, non-inverted when both present. `x = x` is false for
  -- NaN and NULL, rejecting both exactly like Number.isFinite.
  AND "defaultPercent" = "defaultPercent"
  AND ("startWeek" IS NULL OR "startWeek" = "startWeek")
  AND ("endWeek" IS NULL OR "endWeek" = "endWeek")
  AND ("startWeek" IS NULL OR "endWeek" IS NULL OR "startWeek" <= "endWeek")
  AND jsonb_typeof("legacy") = 'object'
  AND "legacy"->>'writer' = 'RESOURCE_OPTIMISER'
  -- version must be the JSON number 1 (jsonb equality: number 1 != string "1"),
  -- matching the shared runtime/V4 translator's strict numeric version===1.
  AND jsonb_typeof("legacy"->'version') = 'number'
  AND "legacy"->'version' = '1'::jsonb;

-- ── Backfill TRANSFERRED_FROM_SQUAD_PLANNER (transferred planned resource) ──
-- Only PLANNED_RESOURCE profiles whose current source/basis/owner shape
-- matches the scheduler suppression contract. ROLE profiles carrying the
-- same transfer writer stay NULL — the scheduler never suppresses a role
-- and an independent manual planned resource (no transfer writer) stays NULL
-- and remains scheduler-authoritative.
UPDATE "CapacityProfile" SET "provenance" = 'TRANSFERRED_FROM_SQUAD_PLANNER'
WHERE "ownerKind" = 'PLANNED_RESOURCE'
  AND "resourceTypeId" IS NULL
  AND "namedResourceId" IS NOT NULL
  AND "source" = 'MANUAL'
  AND "planningBasis" = 'CAPACITY_PROFILE'
  AND jsonb_typeof("legacy") = 'object'
  AND "legacy"->>'writer' = 'transfer-to-manual';

-- ── Backfill LEGACY_MAPPER (strict mapper-derived ROLE / NAMED_PERSON) ──────
-- The 7 mapper keys must all be present, allocationMode must be null or a
-- known mapper mode with the exact mapper (source, planningBasis) pair,
-- every captured value must be a JSON number or JSON null, the profile shape
-- must agree with the legacy payload, and ROLE-only legacy fields must be
-- exactly null. Manual-editor, transfer and unknown payloads fail these
-- checks and stay NULL.
UPDATE "CapacityProfile" SET "provenance" = 'LEGACY_MAPPER'
WHERE (
  -- ROLE variant (isValidMapperProvenance)
  (
    "ownerKind" = 'ROLE'
    AND "resourceTypeId" IS NOT NULL
    AND "namedResourceId" IS NULL
    AND (
      ("legacy"->>'allocationMode') IS NULL AND "source" = 'LEGACY' AND "planningBasis" = 'DEMAND_FOLLOWING'
      OR ("legacy"->>'allocationMode') = 'EFFORT' AND "source" = 'FIXED' AND "planningBasis" = 'DEMAND_FOLLOWING'
      OR ("legacy"->>'allocationMode') = 'TIMELINE' AND "source" = 'AVAILABILITY_WINDOW' AND "planningBasis" = 'AVAILABILITY_WINDOW'
      OR ("legacy"->>'allocationMode') = 'FULL_PROJECT' AND "source" = 'FIXED' AND "planningBasis" = 'WHOLE_PROJECT_ALLOCATION'
      OR ("legacy"->>'allocationMode') = 'CAPACITY_PLAN' AND "source" = 'LEGACY' AND "planningBasis" = 'CAPACITY_PROFILE'
    )
    AND jsonb_typeof("legacy") = 'object'
    AND "legacy" ? 'allocationMode' AND "legacy" ? 'allocationPercent'
    AND "legacy" ? 'allocationPct' AND "legacy" ? 'allocationStartWeek'
    AND "legacy" ? 'allocationEndWeek' AND "legacy" ? 'startWeek' AND "legacy" ? 'endWeek'
    AND jsonb_typeof("legacy"->'allocationPercent') IN ('number', 'null')
    AND jsonb_typeof("legacy"->'allocationPct') IN ('number', 'null')
    AND jsonb_typeof("legacy"->'allocationStartWeek') IN ('number', 'null')
    AND jsonb_typeof("legacy"->'allocationEndWeek') IN ('number', 'null')
    AND jsonb_typeof("legacy"->'startWeek') IN ('number', 'null')
    AND jsonb_typeof("legacy"->'endWeek') IN ('number', 'null')
    -- profile/legacy shape agreement (null-normalised)
    AND "defaultPercent" IS NOT DISTINCT FROM ("legacy"->>'allocationPercent')::double precision
    AND "startWeek" IS NOT DISTINCT FROM ("legacy"->>'allocationStartWeek')::double precision
    AND "endWeek" IS NOT DISTINCT FROM ("legacy"->>'allocationEndWeek')::double precision
    -- ROLE-only legacy fields must be exactly null
    AND jsonb_typeof("legacy"->'allocationPct') = 'null'
    AND jsonb_typeof("legacy"->'startWeek') = 'null'
    AND jsonb_typeof("legacy"->'endWeek') = 'null'
  )
  OR
  -- NAMED_PERSON variant (isValidNamedResourceMapperProvenance)
  (
    "ownerKind" = 'NAMED_PERSON'
    AND "resourceTypeId" IS NULL
    AND "namedResourceId" IS NOT NULL
    AND "defaultPercent" = "defaultPercent"
    AND ("startWeek" IS NULL OR "startWeek" = "startWeek")
    AND ("endWeek" IS NULL OR "endWeek" = "endWeek")
    AND ("startWeek" IS NULL OR "endWeek" IS NULL OR "startWeek" <= "endWeek")
    AND (
      ("legacy"->>'allocationMode') IS NULL AND "source" = 'LEGACY' AND "planningBasis" = 'DEMAND_FOLLOWING'
      OR ("legacy"->>'allocationMode') = 'EFFORT' AND "source" = 'FIXED' AND "planningBasis" = 'DEMAND_FOLLOWING'
      OR ("legacy"->>'allocationMode') = 'TIMELINE' AND "source" = 'AVAILABILITY_WINDOW' AND "planningBasis" = 'AVAILABILITY_WINDOW'
      OR ("legacy"->>'allocationMode') = 'FULL_PROJECT' AND "source" = 'FIXED' AND "planningBasis" = 'WHOLE_PROJECT_ALLOCATION'
      OR ("legacy"->>'allocationMode') = 'CAPACITY_PLAN' AND "source" = 'LEGACY' AND "planningBasis" = 'CAPACITY_PROFILE'
    )
    AND jsonb_typeof("legacy") = 'object'
    AND "legacy" ? 'allocationMode' AND "legacy" ? 'allocationPercent'
    AND "legacy" ? 'allocationPct' AND "legacy" ? 'allocationStartWeek'
    AND "legacy" ? 'allocationEndWeek' AND "legacy" ? 'startWeek' AND "legacy" ? 'endWeek'
    AND jsonb_typeof("legacy"->'allocationPercent') IN ('number', 'null')
    AND jsonb_typeof("legacy"->'allocationPct') IN ('number', 'null')
    AND jsonb_typeof("legacy"->'allocationStartWeek') IN ('number', 'null')
    AND jsonb_typeof("legacy"->'allocationEndWeek') IN ('number', 'null')
    AND jsonb_typeof("legacy"->'startWeek') IN ('number', 'null')
    AND jsonb_typeof("legacy"->'endWeek') IN ('number', 'null')
    -- profile/legacy agreement with the mapper's alias fallbacks
    AND "defaultPercent" IS NOT DISTINCT FROM (
      CASE
        WHEN jsonb_typeof("legacy"->'allocationPercent') = 'number' THEN ("legacy"->>'allocationPercent')::double precision
        WHEN jsonb_typeof("legacy"->'allocationPct') = 'number' THEN ("legacy"->>'allocationPct')::double precision
        ELSE 100::double precision
      END)
    AND "startWeek" IS NOT DISTINCT FROM (
      CASE
        WHEN jsonb_typeof("legacy"->'allocationStartWeek') = 'number' THEN ("legacy"->>'allocationStartWeek')::double precision
        WHEN jsonb_typeof("legacy"->'startWeek') = 'number' THEN ("legacy"->>'startWeek')::double precision
        ELSE NULL::double precision
      END)
    AND "endWeek" IS NOT DISTINCT FROM (
      CASE
        WHEN jsonb_typeof("legacy"->'allocationEndWeek') = 'number' THEN ("legacy"->>'allocationEndWeek')::double precision
        WHEN jsonb_typeof("legacy"->'endWeek') = 'number' THEN ("legacy"->>'endWeek')::double precision
        ELSE NULL::double precision
      END)
  )
);

-- AlterTable: drop the obsolete legacy JSON column now that every recognised
-- behavioural provenance has been backfilled.
ALTER TABLE "CapacityProfile" DROP COLUMN "legacy";
