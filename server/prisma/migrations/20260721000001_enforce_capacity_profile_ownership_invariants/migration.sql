-- enforce_capacity_profile_ownership_invariants
--
-- Phase 1: Preflight checks — fail with actionable errors when dirty data remains.
-- Phase 2: Enforce invariants via CHECK constraints and partial unique indexes.
-- Phase 3: Remove superseded non-unique indexes.
--
-- Precondition: run the ownership audit and repair tools before this migration.
--   npm run capacity-profiles:audit           # read-only check
--   npm run capacity-profiles:audit:repair     # repair identical duplicates
--   npm run capacity-profiles:audit            # confirm clean
--
-- If any preflight check fails below, resolve the reported issues and retry.

-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 1: Preflight dirty-data checks
-- ═════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
    v_error_count INTEGER := 0;
    v_err TEXT;
BEGIN

    -- Check 1: Both owner FKs set (XOR violation)
    FOR v_err IN
        SELECT 'Profile "' || id || '": both resourceTypeId and namedResourceId are set (project "' || "projectId" || '")'
        FROM "CapacityProfile"
        WHERE "resourceTypeId" IS NOT NULL AND "namedResourceId" IS NOT NULL
    LOOP
        RAISE WARNING '[preflight] %', v_err;
        v_error_count := v_error_count + 1;
    END LOOP;

    -- Check 2: Neither owner FK set
    FOR v_err IN
        SELECT 'Profile "' || id || '": neither resourceTypeId nor namedResourceId is set (project "' || "projectId" || '")'
        FROM "CapacityProfile"
        WHERE "resourceTypeId" IS NULL AND "namedResourceId" IS NULL
    LOOP
        RAISE WARNING '[preflight] %', v_err;
        v_error_count := v_error_count + 1;
    END LOOP;

    -- Check 3: ownerKind = ROLE without resourceTypeId
    FOR v_err IN
        SELECT 'Profile "' || id || '": ownerKind ROLE but resourceTypeId is null (project "' || "projectId" || '")'
        FROM "CapacityProfile"
        WHERE "ownerKind" = 'ROLE' AND "resourceTypeId" IS NULL
    LOOP
        RAISE WARNING '[preflight] %', v_err;
        v_error_count := v_error_count + 1;
    END LOOP;

    -- Check 4: ownerKind = ROLE with namedResourceId
    FOR v_err IN
        SELECT 'Profile "' || id || '": ownerKind ROLE but namedResourceId is set (project "' || "projectId" || '")'
        FROM "CapacityProfile"
        WHERE "ownerKind" = 'ROLE' AND "namedResourceId" IS NOT NULL
    LOOP
        RAISE WARNING '[preflight] %', v_err;
        v_error_count := v_error_count + 1;
    END LOOP;

    -- Check 5: ownerKind = NAMED_PERSON or PLANNED_RESOURCE without namedResourceId
    FOR v_err IN
        SELECT 'Profile "' || id || '": ownerKind "' || "ownerKind" || '" but namedResourceId is null (project "' || "projectId" || '")'
        FROM "CapacityProfile"
        WHERE "ownerKind" IN ('NAMED_PERSON', 'PLANNED_RESOURCE') AND "namedResourceId" IS NULL
    LOOP
        RAISE WARNING '[preflight] %', v_err;
        v_error_count := v_error_count + 1;
    END LOOP;

    -- Check 6: ownerKind = NAMED_PERSON or PLANNED_RESOURCE with resourceTypeId
    FOR v_err IN
        SELECT 'Profile "' || id || '": ownerKind "' || "ownerKind" || '" but resourceTypeId is set (project "' || "projectId" || '")'
        FROM "CapacityProfile"
        WHERE "ownerKind" IN ('NAMED_PERSON', 'PLANNED_RESOURCE') AND "resourceTypeId" IS NOT NULL
    LOOP
        RAISE WARNING '[preflight] %', v_err;
        v_error_count := v_error_count + 1;
    END LOOP;

    -- Check 7: Duplicate resourceTypeId (non-null)
    FOR v_err IN
        SELECT 'Duplicate resourceTypeId "' || "resourceTypeId" || '": profiles ' || string_agg(id, ', ')
        FROM "CapacityProfile"
        WHERE "resourceTypeId" IS NOT NULL
        GROUP BY "resourceTypeId"
        HAVING COUNT(*) > 1
    LOOP
        RAISE WARNING '[preflight] %', v_err;
        v_error_count := v_error_count + 1;
    END LOOP;

    -- Check 8: Duplicate namedResourceId (non-null)
    FOR v_err IN
        SELECT 'Duplicate namedResourceId "' || "namedResourceId" || '": profiles ' || string_agg(id, ', ')
        FROM "CapacityProfile"
        WHERE "namedResourceId" IS NOT NULL
        GROUP BY "namedResourceId"
        HAVING COUNT(*) > 1
    LOOP
        RAISE WARNING '[preflight] %', v_err;
        v_error_count := v_error_count + 1;
    END LOOP;

    -- Check 9: Cross-project owner mismatches (informational - not blocking for constraint enforcement)
    FOR v_err IN
        SELECT cp.id || ': ' ||
               CASE WHEN cp."resourceTypeId" IS NOT NULL THEN 'resourceTypeId "' || cp."resourceTypeId" || '" belongs to project "' || rt."projectId" || '" but profile projectId is "' || cp."projectId" || '"'
                    WHEN cp."namedResourceId" IS NOT NULL THEN 'namedResourceId "' || cp."namedResourceId" || '" belongs to project "' || nr_rt."projectId" || '" but profile projectId is "' || cp."projectId" || '"'
               END
        FROM "CapacityProfile" cp
        LEFT JOIN "ResourceType" rt ON cp."resourceTypeId" = rt.id
        LEFT JOIN "NamedResource" nr ON cp."namedResourceId" = nr.id
        LEFT JOIN "ResourceType" nr_rt ON nr."resourceTypeId" = nr_rt.id
        WHERE (cp."resourceTypeId" IS NOT NULL AND rt.id IS NOT NULL AND rt."projectId" != cp."projectId")
           OR (cp."namedResourceId" IS NOT NULL AND nr.id IS NOT NULL AND nr_rt.id IS NOT NULL AND nr_rt."projectId" != cp."projectId")
    LOOP
        RAISE WARNING '[preflight] Cross-project owner mismatch: %', v_err;
        v_error_count := v_error_count + 1;
    END LOOP;

    IF v_error_count > 0 THEN
        RAISE EXCEPTION 'Preflight FAILED: % integrity issue(s) detected. Run `npm run capacity-profiles:audit` and resolve all errors before retrying this migration.', v_error_count;
    END IF;

    RAISE NOTICE 'Preflight PASSED: no dirty data detected.';
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 2: CHECK constraints
-- ═════════════════════════════════════════════════════════════════════════════

-- Constraint: exactly one of resourceTypeId/namedResourceId is non-null (XOR)
ALTER TABLE "CapacityProfile"
    ADD CONSTRAINT "chk_CapacityProfile_exactly_one_owner"
    CHECK (
        ("resourceTypeId" IS NOT NULL AND "namedResourceId" IS NULL)
        OR
        ("resourceTypeId" IS NULL AND "namedResourceId" IS NOT NULL)
    );

-- Constraint: ownerKind must match the selected FK namespace
ALTER TABLE "CapacityProfile"
    ADD CONSTRAINT "chk_CapacityProfile_owner_kind_fk"
    CHECK (
        ("ownerKind" = 'ROLE' AND "resourceTypeId" IS NOT NULL AND "namedResourceId" IS NULL)
        OR
        ("ownerKind" = 'NAMED_PERSON' AND "resourceTypeId" IS NULL AND "namedResourceId" IS NOT NULL)
        OR
        ("ownerKind" = 'PLANNED_RESOURCE' AND "resourceTypeId" IS NULL AND "namedResourceId" IS NOT NULL)
    );

-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 3: Partial unique indexes (supersede non-unique owner indexes)
-- ═════════════════════════════════════════════════════════════════════════════

-- At most one profile per resourceTypeId (role owner)
DROP INDEX IF EXISTS "CapacityProfile_resourceTypeId_idx";
CREATE UNIQUE INDEX "CapacityProfile_resourceTypeId_key" ON "CapacityProfile"("resourceTypeId") WHERE "resourceTypeId" IS NOT NULL;

-- At most one profile per namedResourceId (named/person/planned resource owner)
DROP INDEX IF EXISTS "CapacityProfile_namedResourceId_idx";
CREATE UNIQUE INDEX "CapacityProfile_namedResourceId_key" ON "CapacityProfile"("namedResourceId") WHERE "namedResourceId" IS NOT NULL;

-- Note: The projectId index is preserved since it supports project-scoped queries.
-- The superseded non-unique indexes (resourceTypeId, namedResourceId) are removed
-- because the partial unique indexes serve the same query patterns with stronger guarantees.
