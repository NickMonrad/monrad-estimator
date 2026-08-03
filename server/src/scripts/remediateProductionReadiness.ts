/**
 * remediateProductionReadiness.ts — Issue #421: standalone explicitly-invoked
 * remediation command for production capacity-profile readiness blockers.
 *
 * NEVER runs during application startup or from an HTTP request; exposes no
 * API or UI. Requires explicit CLI invocation.
 *
 * Usage:
 *   npx tsx src/scripts/remediateProductionReadiness.ts                     # dry-run (default)
 *   npx tsx src/scripts/remediateProductionReadiness.ts --json plan.json    # dry-run + machine plan
 *   npx tsx src/scripts/remediateProductionReadiness.ts --json plan.json --manifest decisions.json
 *   npx tsx src/scripts/remediateProductionReadiness.ts --apply --plan plan.json [--manifest decisions.json]
 *
 * Or via npm scripts (repository root):
 *   npm run capacity-profiles:remediate-readiness -- --dry-run
 *   npm run capacity-profiles:remediate-readiness -- --apply --plan <reviewed-plan.json>
 *
 * Exit contract:
 *   0 — plan is valid and has no unresolved decisions (apply mode: every
 *       operation applied or already applied, and post-apply readiness is clean);
 *   1 — operational, structural or drift failure (apply mode: nothing was
 *       written when the failure occurred before the transaction committed);
 *   2 — plan is valid but explicit decisions remain unresolved (apply refused).
 *
 * Dry-run performs ZERO writes. Apply performs only the reviewed plan
 * operations inside one transaction. Credentials and complete database URLs
 * are never printed.
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import 'dotenv/config'

import {
  buildRemediationPlan,
  classifyPlanExit,
  loadRemediationState,
  parseManifestJson,
  parsePlanJson,
  formatRemediationPlanReport,
  planToJson,
  resolvePlanWithManifest,
  type RemediationManifest,
  type RemediationPlan,
} from '../lib/productionRemediationPlan.js'
import { applyRemediationPlan } from '../lib/productionRemediationApply.js'
import {
  runProductionMigrationReadiness,
  formatReadinessReport,
} from '../lib/productionMigrationReadiness.js'

// ─── CLI argument parsing ──────────────────────────────────────────────────

interface CliOptions {
  dryRun: boolean
  apply: boolean
  planPath: string | null
  manifestPath: string | null
  jsonPath: string | null
}

function parseArgs(args: string[]): CliOptions | { error: string } {
  const options: CliOptions = {
    dryRun: true,
    apply: false,
    planPath: null,
    manifestPath: null,
    jsonPath: null,
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--dry-run':
        options.dryRun = true
        break
      case '--apply':
        options.apply = true
        options.dryRun = false
        break
      case '--plan':
        options.planPath = args[++i] ?? null
        if (!options.planPath) return { error: '--plan requires a file path' }
        break
      case '--manifest':
        options.manifestPath = args[++i] ?? null
        if (!options.manifestPath) return { error: '--manifest requires a file path' }
        break
      case '--json':
        options.jsonPath = args[++i] ?? null
        if (!options.jsonPath) return { error: '--json requires a file path' }
        break
      default:
        return { error: `unknown argument "${arg}"` }
    }
  }
  if (options.apply && !options.planPath) {
    return { error: '--apply requires --plan <reviewed-plan.json>' }
  }
  if (options.dryRun && options.planPath) {
    return { error: '--plan is only valid with --apply' }
  }
  return options
}

function currentCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}

function usage(): string {
  return [
    'Usage:',
    '  remediateProductionReadiness.ts [--dry-run] [--json <plan.json>] [--manifest <decisions.json>]',
    '  remediateProductionReadiness.ts --apply --plan <reviewed-plan.json> [--manifest <decisions.json>]',
    '',
    'Exit codes: 0 = plan valid & no unresolved decisions; 1 = operational/structural/drift failure; 2 = decisions remain unresolved.',
  ].join('\n')
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if ('error' in parsed) {
    console.error(`❌ ${parsed.error}`)
    console.error(usage())
    return 1
  }
  const options = parsed

  console.log('🔧 Capacity-Profile Readiness Remediation')
  console.log('=========================================')
  console.log(options.apply ? 'Mode: APPLY (writes only the reviewed plan)' : 'Mode: DRY-RUN (zero writes)')
  console.log('')

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient({ adapter })

  try {
    if (!options.apply) {
      const state = await loadRemediationState(prisma)
      const plan = buildRemediationPlan(state, currentCommit())

      let manifest: RemediationManifest | null = null
      if (options.manifestPath) {
        let raw: string
        try {
          raw = readFileSync(options.manifestPath, 'utf-8')
        } catch (error) {
          console.error(`❌ Cannot read manifest: ${error instanceof Error ? error.message : String(error)}`)
          return 1
        }
        const parsedManifest = parseManifestJson(raw)
        if (!parsedManifest.manifest) {
          console.error(`❌ ${parsedManifest.errors.join('; ')}`)
          return 1
        }
        manifest = parsedManifest.manifest
        const resolved = resolvePlanWithManifest(plan, manifest)
        if (resolved.errors.length > 0) {
          console.error('❌ Manifest validation failed:')
          for (const error of resolved.errors) console.error(`   - ${error}`)
          return 1
        }
        console.log(`Manifest: ${manifest.decisions.length} decision(s) merged for reporting.`)
        console.log('')
        console.log(formatRemediationPlanReport(resolved.plan))
        if (options.jsonPath) {
          writeFileSync(options.jsonPath, planToJson(resolved.plan))
          console.log(`\nPlan written to ${options.jsonPath}`)
        }
        const exit = classifyPlanExit(resolved.plan)
        return exit
      }

      // Baseline dry-run: also run the permanent readiness check for context.
      const readiness = await runProductionMigrationReadiness(prisma)
      console.log(formatReadinessReport(readiness))
      console.log('')
      console.log(formatRemediationPlanReport(plan))
      if (options.jsonPath) {
        writeFileSync(options.jsonPath, planToJson(plan))
        console.log(`\nPlan written to ${options.jsonPath}`)
      }
      return classifyPlanExit(plan)
    }

    // ── Apply mode ───────────────────────────────────────────────────────
    if (!options.planPath) {
      console.error('❌ --apply requires --plan <reviewed-plan.json>')
      return 1
    }
    let planRaw: string
    try {
      planRaw = readFileSync(options.planPath, 'utf-8')
    } catch (error) {
      console.error(`❌ Cannot read plan: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
    const parsedPlan = parsePlanJson(planRaw)
    if (!parsedPlan.plan) {
      console.error(`❌ ${parsedPlan.errors.join('; ')}`)
      return 1
    }
    const plan: RemediationPlan = parsedPlan.plan

    let manifest: RemediationManifest | null = null
    if (options.manifestPath) {
      let raw: string
      try {
        raw = readFileSync(options.manifestPath, 'utf-8')
      } catch (error) {
        console.error(`❌ Cannot read manifest: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
      const parsedManifest = parseManifestJson(raw)
      if (!parsedManifest.manifest) {
        console.error(`❌ ${parsedManifest.errors.join('; ')}`)
        return 1
      }
      manifest = parsedManifest.manifest
    }

    console.log(`Plan: ${options.planPath} (fingerprint ${plan.fingerprint})`)
    console.log(`Plan application commit: ${plan.applicationCommit}`)
    console.log('')
    const outcome = await applyRemediationPlan(prisma, { plan, manifest })
    console.log(outcome.report)
    return outcome.exitCode
  } catch (error) {
    console.error('')
    console.error('❌ Remediation command failed:', error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    await prisma.$disconnect()
  }
}

const exitCode = await main()
process.exit(exitCode)
