/**
 * snapshotVersionClassification.ts — Shared version classification for stored
 * BacklogSnapshot payloads (issue #444).
 *
 * One small classifier, built on the existing `parseSnapshotData` authority
 * and the existing version guards, decides whether a stored snapshot is
 * v1/v2/v3, a valid/invalid v4, or malformed/unsupported. It is the version
 * authority used by:
 *   - the snapshot restorability classifier (retirement policy);
 *   - the production-migration readiness snapshot section (aggregate counts);
 *   - the pre-V4 purge command (positive V1/V2/V3 identification).
 *
 * It deliberately performs NO historical translation or quarantine analysis:
 * issue #444 accepts the loss of pre-V4 rollback history, so only the schema
 * version (and, for v4, structural validity) matters.
 */

import {
  parseSnapshotData,
  isLegacyV1Snapshot,
  isSnapshotV2,
  isSnapshotV3,
  isSnapshotV4,
  type SnapshotData,
} from './projectSnapshotTypes.js'
import { validateSnapshotV3 } from './projectSnapshotValidation.js'

export type SnapshotVersionClassification =
  | { kind: 'v1' }
  | { kind: 'v2' }
  | { kind: 'v3' }
  | { kind: 'v4'; valid: boolean; reason?: string }
  | { kind: 'malformed'; reason: string }

/**
 * Classify a raw stored snapshot payload by schema version.
 *
 * Outcomes:
 *   - `v1` / `v2` / `v3` — the payload parsed as that legacy version;
 *   - `v4` with `valid: true` — parsed and structurally validated;
 *   - `v4` with `valid: false` — schemaVersion 4 but the payload fails
 *     `validateSnapshotV3` (the authoritative structural rules shared by v4
 *     rollback); `reason` carries the validation failure;
 *   - `malformed` — parse failure or an unsupported schema version;
 *     `reason` carries the parse failure.
 *
 * Never throws; never rewrites the stored record.
 */
export function classifySnapshotVersion(raw: unknown): SnapshotVersionClassification {
  let parsed: SnapshotData
  try {
    parsed = parseSnapshotData(raw)
  } catch (error) {
    return {
      kind: 'malformed',
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  if (isLegacyV1Snapshot(parsed)) return { kind: 'v1' }
  if (isSnapshotV2(parsed)) return { kind: 'v2' }
  if (isSnapshotV3(parsed)) return { kind: 'v3' }
  if (isSnapshotV4(parsed)) {
    try {
      validateSnapshotV3(parsed)
      return { kind: 'v4', valid: true }
    } catch (error) {
      return {
        kind: 'v4',
        valid: false,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return { kind: 'malformed', reason: 'unsupported snapshot data' }
}
