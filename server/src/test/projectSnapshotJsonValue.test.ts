/**
 * projectSnapshotJsonValue.test.ts — Unit tests for SnapshotJsonValue type guard,
 * sentinel mapping, and serialisation.
 *
 * Coverage:
 *   - snapshotJsonValueToPrisma (DB_NULL/JSON_NULL/VALUE mapping)
 *   - snapshotJsonValueToPlain (round-trip serialisation)
 *   - validateSnapshotJsonValue (every accepted scalar/container/rejection)
 *
 * All tests are behavioural and deterministic.
 */

import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import type { SnapshotJsonValue } from '../lib/projectSnapshotTypes.js'
import {
  snapshotJsonValueToPrisma,
  snapshotJsonValueToPlain,
} from '../lib/projectSnapshotTypes.js'
import {
  validateSnapshotJsonValue,
  SnapshotValidationError,
} from '../lib/projectSnapshotValidation.js'

/* ─── Helpers ─────────────────────────────────────────────────── */

/** Assert that validateSnapshotJsonValue does NOT throw. */
function assertValid(value: unknown, pfx = 'test'): asserts value is SnapshotJsonValue {
  const act = () => validateSnapshotJsonValue(value, pfx)
  expect(act).not.toThrow()
}

/** Assert that validateSnapshotJsonValue throws SnapshotValidationError. */
function assertInvalid(value: unknown, pfx = 'test'): void {
  const act = () => validateSnapshotJsonValue(value, pfx)
  expect(act).toThrow(SnapshotValidationError)
}

/* ─── snapshotJsonValueToPrisma ───────────────────────────────── */

describe('snapshotJsonValueToPrisma', () => {
  it('maps DB_NULL to Prisma.DbNull', () => {
    const sjv: SnapshotJsonValue = { kind: 'DB_NULL' }
    expect(snapshotJsonValueToPrisma(sjv)).toBe(Prisma.DbNull)
  })

  it('maps JSON_NULL to Prisma.JsonNull', () => {
    const sjv: SnapshotJsonValue = { kind: 'JSON_NULL' }
    expect(snapshotJsonValueToPrisma(sjv)).toBe(Prisma.JsonNull)
  })

  it('unwraps VALUE string', () => {
    const sjv: SnapshotJsonValue = { kind: 'VALUE', value: 'hello' }
    expect(snapshotJsonValueToPrisma(sjv)).toBe('hello')
  })

  it('unwraps VALUE number', () => {
    const sjv: SnapshotJsonValue = { kind: 'VALUE', value: 42 }
    expect(snapshotJsonValueToPrisma(sjv)).toBe(42)
  })

  it('unwraps VALUE boolean', () => {
    const sjv: SnapshotJsonValue = { kind: 'VALUE', value: true }
    expect(snapshotJsonValueToPrisma(sjv)).toBe(true)
  })

  it('unwraps VALUE object', () => {
    const obj = { a: 1 }
    const sjv: SnapshotJsonValue = { kind: 'VALUE', value: obj }
    expect(snapshotJsonValueToPrisma(sjv)).toBe(obj)
  })

  it('unwraps VALUE array', () => {
    const arr = [1, 2, 3]
    const sjv: SnapshotJsonValue = { kind: 'VALUE', value: arr }
    expect(snapshotJsonValueToPrisma(sjv)).toBe(arr)
  })
})

/* ─── snapshotJsonValueToPlain ────────────────────────────────── */

describe('snapshotJsonValueToPlain', () => {
  it('serialises DB_NULL', () => {
    const sjv: SnapshotJsonValue = { kind: 'DB_NULL' }
    expect(snapshotJsonValueToPlain(sjv)).toEqual({ kind: 'DB_NULL' })
  })

  it('serialises JSON_NULL', () => {
    const sjv: SnapshotJsonValue = { kind: 'JSON_NULL' }
    expect(snapshotJsonValueToPlain(sjv)).toEqual({ kind: 'JSON_NULL' })
  })

  it('serialises VALUE with number', () => {
    const sjv: SnapshotJsonValue = { kind: 'VALUE', value: 99 }
    expect(snapshotJsonValueToPlain(sjv)).toEqual({ kind: 'VALUE', value: 99 })
  })

  it('serialises VALUE with object', () => {
    const sjv: SnapshotJsonValue = { kind: 'VALUE', value: { x: 1 } }
    expect(snapshotJsonValueToPlain(sjv)).toEqual({ kind: 'VALUE', value: { x: 1 } })
  })

  it('serialises VALUE with array', () => {
    const sjv: SnapshotJsonValue = { kind: 'VALUE', value: [1, null, 'a'] }
    expect(snapshotJsonValueToPlain(sjv)).toEqual({ kind: 'VALUE', value: [1, null, 'a'] })
  })
})

/* ─── validateSnapshotJsonValue — accepted ────────────────────── */

describe('validateSnapshotJsonValue – accepted', () => {
  it('accepts DB_NULL without value', () => {
    assertValid({ kind: 'DB_NULL' })
  })

  it('accepts JSON_NULL without value', () => {
    assertValid({ kind: 'JSON_NULL' })
  })

  it('accepts VALUE with string', () => {
    assertValid({ kind: 'VALUE', value: 'text' })
  })

  it('accepts VALUE with empty string', () => {
    assertValid({ kind: 'VALUE', value: '' })
  })

  it('accepts VALUE with positive integer', () => {
    assertValid({ kind: 'VALUE', value: 42 })
  })

  it('accepts VALUE with zero', () => {
    assertValid({ kind: 'VALUE', value: 0 })
  })

  it('accepts VALUE with negative integer', () => {
    assertValid({ kind: 'VALUE', value: -1 })
  })

  it('accepts VALUE with finite decimal', () => {
    assertValid({ kind: 'VALUE', value: 3.14 })
  })

  it('accepts VALUE with true', () => {
    assertValid({ kind: 'VALUE', value: true })
  })

  it('accepts VALUE with false', () => {
    assertValid({ kind: 'VALUE', value: false })
  })

  it('accepts VALUE with empty object', () => {
    assertValid({ kind: 'VALUE', value: {} })
  })

  it('accepts VALUE with empty array', () => {
    assertValid({ kind: 'VALUE', value: [] })
  })

  it('accepts VALUE with nested object containing null', () => {
    assertValid({ kind: 'VALUE', value: { a: null, b: 'keep' } })
  })

  it('accepts VALUE with nested array containing null', () => {
    assertValid({ kind: 'VALUE', value: [1, null, 'two'] })
  })

  it('accepts VALUE with deeply nested valid structure', () => {
    assertValid({
      kind: 'VALUE',
      value: {
        level1: [
          { level2: null },
          { level2: [true, false, 0, 'deep'] },
        ],
      },
    })
  })

  it('accepts VALUE with prototype-less object (Object.create(null))', () => {
    const bare = Object.create(null) as Record<string, unknown>
    bare.x = 1
    assertValid({ kind: 'VALUE', value: bare })
  })

  it('accepts shared non-cyclic reference in VALUE', () => {
    const shared = { tag: 'shared' }
    const root = { a: shared, b: shared }
    assertValid({ kind: 'VALUE', value: root })
  })
})

/* ─── validateSnapshotJsonValue — rejected ────────────────────── */

describe('validateSnapshotJsonValue – rejected', () => {
  /* Non-object input */
  it('rejects null (non-object input)', () => {
    assertInvalid(null)
  })

  it('rejects undefined (non-object input)', () => {
    assertInvalid(undefined)
  })

  it('rejects a bare string', () => {
    assertInvalid('hello')
  })

  it('rejects a bare number', () => {
    assertInvalid(99)
  })

  /* Malformed discriminator */
  it('rejects non-string kind', () => {
    assertInvalid({ kind: 42 })
  })

  it('rejects null kind', () => {
    assertInvalid({ kind: null })
  })

  it('rejects unsupported kind string', () => {
    assertInvalid({ kind: 'UNKNOWN' })
  })

  /* Extra / missing fields */
  it('rejects DB_NULL with extra value field', () => {
    assertInvalid({ kind: 'DB_NULL', value: 'x' })
  })

  it('rejects DB_NULL with arbitrary extra field', () => {
    assertInvalid({ kind: 'DB_NULL', extra: 1 })
  })

  it('rejects JSON_NULL with extra value field', () => {
    assertInvalid({ kind: 'JSON_NULL', value: 'x' })
  })

  it('rejects JSON_NULL with arbitrary extra field', () => {
    assertInvalid({ kind: 'JSON_NULL', extra: 1 })
  })

  it('rejects VALUE missing value field', () => {
    assertInvalid({ kind: 'VALUE' })
  })

  it('rejects VALUE with extra unsupported field', () => {
    assertInvalid({ kind: 'VALUE', value: 'ok', extra: true })
  })

  /* Top-level null in VALUE */
  it('rejects VALUE with top-level null', () => {
    assertInvalid({ kind: 'VALUE', value: null })
  })

  /* Undefined */
  it('rejects VALUE with undefined', () => {
    assertInvalid({ kind: 'VALUE', value: undefined })
  })

  /* Non-finite numbers */
  it('rejects VALUE with NaN', () => {
    assertInvalid({ kind: 'VALUE', value: NaN })
  })

  it('rejects VALUE with Infinity', () => {
    assertInvalid({ kind: 'VALUE', value: Infinity })
  })

  it('rejects VALUE with -Infinity', () => {
    assertInvalid({ kind: 'VALUE', value: -Infinity })
  })

  /* Function */
  it('rejects VALUE with function', () => {
    assertInvalid({ kind: 'VALUE', value: () => 1 })
  })

  /* Symbol */
  it('rejects VALUE with symbol', () => {
    assertInvalid({ kind: 'VALUE', value: Symbol('x') })
  })

  /* BigInt */
  it('rejects VALUE with bigint', () => {
    assertInvalid({ kind: 'VALUE', value: BigInt(1) })
  })

  /* Non-plain objects */
  it('rejects VALUE with Date', () => {
    assertInvalid({ kind: 'VALUE', value: new Date() })
  })

  it('rejects VALUE with RegExp', () => {
    assertInvalid({ kind: 'VALUE', value: /regex/ })
  })

  it('rejects VALUE with Map', () => {
    assertInvalid({ kind: 'VALUE', value: new Map() })
  })

  it('rejects VALUE with Set', () => {
    assertInvalid({ kind: 'VALUE', value: new Set() })
  })

  it('rejects VALUE with custom class instance', () => {
    class CustomClass { x = 1 }
    assertInvalid({ kind: 'VALUE', value: new CustomClass() })
  })

  /* Cyclic references */
  it('rejects VALUE with self-referencing object cycle', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    assertInvalid({ kind: 'VALUE', value: cyclic })
  })

  it('rejects VALUE with deeper cycle in nested object', () => {
    const inner: Record<string, unknown> = { a: 1 }
    const root = { inner }
    inner.parent = root
    assertInvalid({ kind: 'VALUE', value: root })
  })

  it('rejects VALUE with cyclic array (element refers to self)', () => {
    const arr: unknown[] = [1, 2, 3]
    arr.push(arr)
    assertInvalid({ kind: 'VALUE', value: arr })
  })

  /* Non-serialisable values nested inside structures */
  it('rejects VALUE with function nested in object', () => {
    assertInvalid({ kind: 'VALUE', value: { fn: () => 1 } })
  })

  it('rejects VALUE with undefined nested in array', () => {
    assertInvalid({ kind: 'VALUE', value: [1, undefined, 3] })
  })

  it('rejects VALUE with NaN nested in array', () => {
    assertInvalid({ kind: 'VALUE', value: [NaN] })
  })
})
