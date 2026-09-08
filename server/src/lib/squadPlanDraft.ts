import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'

export type SquadPlanDraftProof = {
  version: 1
  purpose: 'squad-plan-reviewed-result'
  projectId: string
  userId: string
  stateFingerprint: string
  inputFingerprint: string
  resultFingerprint: string
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }
  return value
}

export function canonicalFingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function signingSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is required to sign squad-plan draft results')
  return `${secret}:squad-plan-reviewed-result`
}

export function signSquadPlanProof(proof: SquadPlanDraftProof): string {
  return jwt.sign({ draftProof: proof }, signingSecret(), {
    expiresIn: '1h',
    audience: 'squad-plan-reviewed-result',
    issuer: 'monrad-estimator',
  })
}

export function verifySquadPlanProof(token: unknown): SquadPlanDraftProof | null {
  if (typeof token !== 'string' || token.length === 0) return null
  try {
    const payload = jwt.verify(token, signingSecret(), {
      audience: 'squad-plan-reviewed-result',
      issuer: 'monrad-estimator',
    }) as { draftProof?: Partial<SquadPlanDraftProof> }
    const proof = payload.draftProof
    if (
      !proof
      || proof.version !== 1
      || proof.purpose !== 'squad-plan-reviewed-result'
      || typeof proof.projectId !== 'string'
      || typeof proof.userId !== 'string'
      || typeof proof.stateFingerprint !== 'string'
      || typeof proof.inputFingerprint !== 'string'
      || typeof proof.resultFingerprint !== 'string'
    ) return null
    return proof as SquadPlanDraftProof
  } catch {
    return null
  }
}
