/**
 * Tests for structured error aggregation.
 * Covers recursive flattening, deduplication, ordering, and Error.cause retention.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AggregatedError, createFailureCollector } from './aggregated-error.mjs'

describe('AggregatedError', () => {
  it('produces combined message from primary and secondaries', () => {
    const e = new AggregatedError(new Error('main'), [
      { type: 'foo', error: new Error('bar') },
    ])
    assert.ok(e.message.includes('main'))
    assert.ok(e.message.includes('[foo]'))
    assert.ok(e.message.includes('bar'))
  })

  it('handles empty secondaries', () => {
    const e = new AggregatedError(new Error('only'))
    assert.equal(e.message, 'only')
    assert.equal(e.secondaryErrors.length, 0)
  })
})

describe('createFailureCollector / addError', () => {
  it('one primary error', () => {
    const c = createFailureCollector()
    c.addPrimary(new Error('primary'))
    const a = c.toError()
    assert.ok(a)
    assert.equal(a.primary?.message, 'primary')
    assert.equal(a.secondaryErrors.length, 0)
  })

  it('primary plus one secondary', () => {
    const c = createFailureCollector()
    c.addPrimary(new Error('primary'))
    c.addSecondary('cleanup', new Error('oh no'))
    const a = c.toError()
    assert.equal(a.primary?.message, 'primary')
    assert.equal(a.secondaryErrors.length, 1)
    assert.equal(a.secondaryErrors[0].type, 'cleanup')
  })

  it('nested aggregate as primary is flattened', () => {
    const inner = createFailureCollector()
    inner.addPrimary(new Error('inner-primary'))
    inner.addSecondary('inner-sec', new Error('inner-sec'))
    const innerAgg = inner.toError()

    const outer = createFailureCollector()
    outer.addError(innerAgg)

    const a = outer.toError()
    assert.equal(a.primary?.message, 'inner-primary')
    assert.equal(a.secondaryErrors.length, 1)
    assert.equal(a.secondaryErrors[0].type, 'inner-sec')
  })

  it('aggregate nested multiple levels deep', () => {
    const level3 = createFailureCollector()
    level3.addPrimary(new Error('l3-primary'))
    level3.addSecondary('l3-sec', new Error('l3-sec'))
    const l3 = level3.toError()

    const level2 = createFailureCollector()
    level2.addPrimary(new Error('l2-primary'))
    level2.addError(l3)
    const l2 = level2.toError()

    const level1 = createFailureCollector()
    level1.addError(l2)

    const a = level1.toError()
    assert.equal(a.primary?.message, 'l2-primary')
    const primaries = a.secondaryErrors.filter(s => s.type === 'primary')
    assert.equal(primaries.length, 1)
    assert.ok(primaries[0].error?.message?.includes('l3-primary'))
    const l3secs = a.secondaryErrors.filter(s => s.type === 'l3-sec')
    assert.equal(l3secs.length, 1)
  })

  it('later distinct primary becomes secondary', () => {
    const c = createFailureCollector()
    c.addPrimary(new Error('first'))
    c.addPrimary(new Error('second'))
    const a = c.toError()
    assert.equal(a.primary?.message, 'first')
    const later = a.secondaryErrors.filter(s => s.type === 'primary')
    assert.equal(later.length, 1)
    assert.ok(later[0].error?.message?.includes('second'))
  })

  it('nested Docker cleanup failure survives flattening', () => {
    const inner = createFailureCollector()
    inner.addSecondary('docker cleanup', new Error('Docker rm failed'))
    const innerAgg = inner.toError()

    const outer = createFailureCollector()
    outer.addPrimary(new Error('API crash'))
    outer.addError(innerAgg)

    const a = outer.toError()
    assert.equal(a.primary?.message, 'API crash')
    const dockerSecs = a.secondaryErrors.filter(s => s.type === 'docker cleanup')
    assert.equal(dockerSecs.length, 1)
  })

  it('nested process termination failure survives flattening', () => {
    const inner = createFailureCollector()
    inner.addSecondary('process termination', new Error('SIGKILL failed'))
    const innerAgg = inner.toError()

    const outer = createFailureCollector()
    outer.addError(innerAgg)

    const a = outer.toError()
    assert.equal(a.primary.message, 'Unknown failure')
    const termSecs = a.secondaryErrors.filter(s => s.type === 'process termination')
    assert.equal(termSecs.length, 1)
  })

  it('duplicate secondary is emitted once', () => {
    const c = createFailureCollector()
    c.addSecondary('dup', new Error('same error'))
    c.addSecondary('dup', new Error('same error'))
    const a = c.toError()
    const dups = a.secondaryErrors.filter(s => s.type === 'dup')
    assert.equal(dups.length, 1)
  })

  it('same message with different failure types remains distinct', () => {
    const c = createFailureCollector()
    const err = new Error('was cancelled')
    c.addSecondary('docker cleanup', err)
    c.addSecondary('child-process termination', err)
    const a = c.toError()
    const docker = a.secondaryErrors.filter(s => s.type === 'docker cleanup')
    const term = a.secondaryErrors.filter(s => s.type === 'child-process termination')
    assert.equal(docker.length, 1)
    assert.equal(term.length, 1)
  })

  it('original primary remains unchanged', () => {
    const err = new Error('original')
    const c = createFailureCollector()
    c.addPrimary(err)
    assert.equal(c.primary, err)
  })

  it('original Error.cause is retained', () => {
    const cause = new Error('root cause')
    const err = new Error('wrapper')
    err.cause = cause
    const c = createFailureCollector()
    c.addPrimary(err)
    assert.equal(c.primary.cause, cause)
  })

  it('toError returns null with no errors', () => {
    const c = createFailureCollector()
    assert.equal(c.toError(), null)
  })
})

describe('primary deduplication (F5)', () => {
  it('primary merged back from identical aggregate is not duplicated', () => {
    const c = createFailureCollector()
    c.addPrimary(new Error('API crash'))

    // Simulate: withIsolatedTestDatabase wraps aggregate and we merge back.
    const inner = createFailureCollector()
    inner.addError(new Error('API crash'))
    const agg = inner.toError()

    c.addError(agg)

    assert.equal(c.primary?.message, 'API crash')
    const primaries = c.secondary.filter(s => s.type === 'primary')
    assert.equal(primaries.length, 0, 'no duplicate primary as secondary')
  })

  it('same primary object is not duplicated', () => {
    const err = new Error('unique failure')
    const c = createFailureCollector()
    c.addPrimary(err)
    c.addPrimary(err)  // same reference
    const a = c.toError()
    assert.equal(a.primary, err)
    assert.equal(a.secondaryErrors.length, 0)
  })

  it('equivalent primary wrapped in another aggregate is not duplicated', () => {
    const c = createFailureCollector()
    c.addPrimary(new Error('exit code 1'))

    // Simulate nested aggregate from withIsolatedTestDatabase.
    const inner = createFailureCollector()
    inner.addPrimary(new Error('exit code 1'))
    inner.addSecondary('docker cleanup', new Error('rm failed'))
    const agg = inner.toError()

    c.addError(agg)

    // Primary unchanged, docker cleanup survives, no duplicate primary.
    assert.equal(c.primary?.message, 'exit code 1')
    const docker = c.secondary.filter(s => s.type === 'docker cleanup')
    assert.equal(docker.length, 1)
    const dupPrimary = c.secondary.filter(s => s.type === 'primary')
    assert.equal(dupPrimary.length, 0)
  })

  it('genuinely different later primary is retained as typed secondary', () => {
    const c = createFailureCollector()
    c.addPrimary(new Error('first failure'))
    c.addPrimary(new Error('different failure'))
    const a = c.toError()
    assert.equal(a.primary?.message, 'first failure')
    const later = a.secondaryErrors.filter(s => s.type === 'primary')
    assert.equal(later.length, 1)
    assert.ok(later[0].error?.message?.includes('different'))
  })

  it('nested aggregates three levels deep remain deterministic', () => {
    const l3 = createFailureCollector()
    l3.addPrimary(new Error('l3'))
    l3.addSecondary('l3s', new Error('l3-sec'))
    const l3a = l3.toError()

    const l2 = createFailureCollector()
    l2.addPrimary(new Error('l2'))
    l2.addError(l3a)
    const l2a = l2.toError()

    const l1 = createFailureCollector()
    l1.addError(l2a)
    l1.addSecondary('cleanup', new Error('final'))

    const a = l1.toError()
    assert.equal(a.primary?.message, 'l2')
    // l3's primary becomes 'primary' secondary, l3s and cleanup are secondaries.
    const primarySecs = a.secondaryErrors.filter(s => s.type === 'primary')
    assert.equal(primarySecs.length, 1)
    assert.ok(primarySecs[0].error?.message?.includes('l3'))
    const l3secs = a.secondaryErrors.filter(s => s.type === 'l3s')
    assert.equal(l3secs.length, 1)
    const cleanupSecs = a.secondaryErrors.filter(s => s.type === 'cleanup')
    assert.equal(cleanupSecs.length, 1)
  })

  it('final message contains each unique diagnostic once', () => {
    const c = createFailureCollector()
    c.addPrimary(new Error('api exit 1'))
    c.addSecondary('docker cleanup', new Error('rm failed'))
    c.addSecondary('process termination', new Error('kill failed'))
    const a = c.toError()
    assert.ok(a.message.includes('api exit 1'))
    assert.ok(a.message.includes('[docker cleanup]'))
    assert.ok(a.message.includes('[process termination]'))
    // The same entries should appear only once.
    const matches = (a.message.match(/\[docker cleanup\]/g) || []).length
    assert.equal(matches, 1)
  })
})
