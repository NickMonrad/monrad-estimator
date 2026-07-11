import { describe, it, expect } from 'vitest'
import { materializeResourceTrajectories, materializeRoleCapacitySegments } from '../lib/capacityPlanMaterialisation.js'

describe('materializeResourceTrajectories', () => {
  it('constant 0.25 FTE', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 2, headcount: 0.25 },
      { periodIndex: 1, startWeek: 2, endWeek: 10, headcount: 0.25 },
    ]
    const result = materializeResourceTrajectories(periods)
    expect(result).toHaveLength(1)
    expect(result[0].trajectoryIndex).toBe(0)
    expect(result[0].segments).toHaveLength(1)
    expect(result[0].segments[0].startWeek).toBe(0)
    expect(result[0].segments[0].endWeek).toBe(9)
    expect(result[0].segments[0].allocationPercent).toBe(25)
  })

  it('constant 0.50 FTE', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 10, headcount: 0.5 },
    ]
    const result = materializeResourceTrajectories(periods)
    expect(result).toHaveLength(1)
    expect(result[0].trajectoryIndex).toBe(0)
    expect(result[0].segments).toHaveLength(1)
    expect(result[0].segments[0].startWeek).toBe(0)
    expect(result[0].segments[0].endWeek).toBe(9)
    expect(result[0].segments[0].allocationPercent).toBe(50)
  })

  it('constant 0.75 FTE', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 10, headcount: 0.75 },
    ]
    const result = materializeResourceTrajectories(periods)
    expect(result).toHaveLength(1)
    expect(result[0].trajectoryIndex).toBe(0)
    expect(result[0].segments).toHaveLength(1)
    expect(result[0].segments[0].startWeek).toBe(0)
    expect(result[0].segments[0].endWeek).toBe(9)
    expect(result[0].segments[0].allocationPercent).toBe(75)
  })

  it('constant 1.00 FTE', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 10, headcount: 1.0 },
    ]
    const result = materializeResourceTrajectories(periods)
    expect(result).toHaveLength(1)
    expect(result[0].trajectoryIndex).toBe(0)
    expect(result[0].segments).toHaveLength(1)
    expect(result[0].segments[0].startWeek).toBe(0)
    expect(result[0].segments[0].endWeek).toBe(9)
    expect(result[0].segments[0].allocationPercent).toBe(100)
  })

  it('constant 1.50 FTE', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 10, headcount: 1.5 },
    ]
    const result = materializeResourceTrajectories(periods)
    expect(result).toHaveLength(2)
    // trajectory 0: 100%
    expect(result[0].trajectoryIndex).toBe(0)
    expect(result[0].segments).toHaveLength(1)
    expect(result[0].segments[0].startWeek).toBe(0)
    expect(result[0].segments[0].endWeek).toBe(9)
    expect(result[0].segments[0].allocationPercent).toBe(100)
    // trajectory 1: 50%
    expect(result[1].trajectoryIndex).toBe(1)
    expect(result[1].segments).toHaveLength(1)
    expect(result[1].segments[0].startWeek).toBe(0)
    expect(result[1].segments[0].endWeek).toBe(9)
    expect(result[1].segments[0].allocationPercent).toBe(50)
  })

  it('constant 2.25 FTE', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 10, headcount: 2.25 },
    ]
    const result = materializeResourceTrajectories(periods)
    expect(result).toHaveLength(3)
    // trajectory 0: 100%
    expect(result[0].trajectoryIndex).toBe(0)
    expect(result[0].segments).toHaveLength(1)
    expect(result[0].segments[0].startWeek).toBe(0)
    expect(result[0].segments[0].endWeek).toBe(9)
    expect(result[0].segments[0].allocationPercent).toBe(100)
    // trajectory 1: 100%
    expect(result[1].trajectoryIndex).toBe(1)
    expect(result[1].segments).toHaveLength(1)
    expect(result[1].segments[0].startWeek).toBe(0)
    expect(result[1].segments[0].endWeek).toBe(9)
    expect(result[1].segments[0].allocationPercent).toBe(100)
    // trajectory 2: 25%
    expect(result[2].trajectoryIndex).toBe(2)
    expect(result[2].segments).toHaveLength(1)
    expect(result[2].segments[0].startWeek).toBe(0)
    expect(result[2].segments[0].endWeek).toBe(9)
    expect(result[2].segments[0].allocationPercent).toBe(25)
  })

  it('changing 0.50 to 0.25 FTE', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 4, headcount: 0.5 },
      { periodIndex: 1, startWeek: 4, endWeek: 10, headcount: 0.25 },
    ]
    const result = materializeResourceTrajectories(periods)
    expect(result).toHaveLength(1)
    expect(result[0].trajectoryIndex).toBe(0)
    expect(result[0].segments).toHaveLength(2)
    expect(result[0].segments[0].startWeek).toBe(0)
    expect(result[0].segments[0].endWeek).toBe(3)
    expect(result[0].segments[0].allocationPercent).toBe(50)
    expect(result[0].segments[1].startWeek).toBe(4)
    expect(result[0].segments[1].endWeek).toBe(9)
    expect(result[0].segments[1].allocationPercent).toBe(25)
  })

  it('changing 1.00 to 0.50 FTE', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 4, headcount: 1.0 },
      { periodIndex: 1, startWeek: 4, endWeek: 10, headcount: 0.5 },
    ]
    const result = materializeResourceTrajectories(periods)
    expect(result).toHaveLength(1)
    expect(result[0].trajectoryIndex).toBe(0)
    expect(result[0].segments).toHaveLength(2)
    expect(result[0].segments[0].startWeek).toBe(0)
    expect(result[0].segments[0].endWeek).toBe(3)
    expect(result[0].segments[0].allocationPercent).toBe(100)
    expect(result[0].segments[1].startWeek).toBe(4)
    expect(result[0].segments[1].endWeek).toBe(9)
    expect(result[0].segments[1].allocationPercent).toBe(50)
  })

  it('changing 1.50 to 0.50 FTE', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 4, headcount: 1.5 },
      { periodIndex: 1, startWeek: 4, endWeek: 10, headcount: 0.5 },
    ]
    const result = materializeResourceTrajectories(periods)
    expect(result).toHaveLength(2)
    // trajectory 0: W0-W3 at 100%, W4-W9 at 50%
    expect(result[0].trajectoryIndex).toBe(0)
    expect(result[0].segments).toHaveLength(2)
    expect(result[0].segments[0].startWeek).toBe(0)
    expect(result[0].segments[0].endWeek).toBe(3)
    expect(result[0].segments[0].allocationPercent).toBe(100)
    expect(result[0].segments[1].startWeek).toBe(4)
    expect(result[0].segments[1].endWeek).toBe(9)
    expect(result[0].segments[1].allocationPercent).toBe(50)
    // trajectory 1: W0-W3 at 50%
    expect(result[1].trajectoryIndex).toBe(1)
    expect(result[1].segments).toHaveLength(1)
    expect(result[1].segments[0].startWeek).toBe(0)
    expect(result[1].segments[0].endWeek).toBe(3)
    expect(result[1].segments[0].allocationPercent).toBe(50)
  })

  it('input order determinism', () => {
    const periodsA = [
      { periodIndex: 0, startWeek: 0, endWeek: 4, headcount: 1.5 },
      { periodIndex: 1, startWeek: 4, endWeek: 10, headcount: 0.5 },
    ]
    const periodsB = [
      { periodIndex: 1, startWeek: 4, endWeek: 10, headcount: 0.5 },
      { periodIndex: 0, startWeek: 0, endWeek: 4, headcount: 1.5 },
    ]
    const resultA = materializeResourceTrajectories(periodsA)
    const resultB = materializeResourceTrajectories(periodsB)
    expect(resultA).toEqual(resultB)
  })

  it('empty periods', () => {
    const periods: Array<{ periodIndex: number; startWeek: number; endWeek: number; headcount: number }> = []
    const result = materializeResourceTrajectories(periods)
    expect(result).toHaveLength(0)
  })

  it('zero headcount period', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 10, headcount: 0 },
    ]
    const result = materializeResourceTrajectories(periods)
    expect(result).toHaveLength(0)
  })
})

describe('materializeResourceTrajectories with gap', () => {
  it('creates two segments with a gap between them', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 4, headcount: 1.0 },
      { periodIndex: 1, startWeek: 8, endWeek: 12, headcount: 1.0 },
    ]
    const result = materializeResourceTrajectories(periods)
    expect(result).toHaveLength(1)
    expect(result[0].segments).toHaveLength(2)

    expect(result[0].segments[0].startWeek).toBe(0)
    expect(result[0].segments[0].endWeek).toBe(3)
    expect(result[0].segments[0].allocationPercent).toBe(100)

    expect(result[0].segments[1].startWeek).toBe(8)
    expect(result[0].segments[1].endWeek).toBe(11)
    expect(result[0].segments[1].allocationPercent).toBe(100)

    // No segment bridges the gap (weeks 4-7)
    expect(result[0].segments[0].endWeek).toBeLessThan(result[0].segments[1].startWeek - 1)
  })
})

describe('materializeRoleCapacitySegments', () => {
  it('constant 50%', () => {
    const wh = new Map([[0, 0.5], [1, 0.5], [2, 0.5], [3, 0.5], [4, 0.5], [5, 0.5], [6, 0.5], [7, 0.5]])
    const segs = materializeRoleCapacitySegments(wh)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ startWeek: 0, endWeek: 7, allocationPercent: 50 })
  })

  it('constant 150%', () => {
    const wh = new Map([[0, 1.5], [1, 1.5], [2, 1.5], [3, 1.5]])
    const segs = materializeRoleCapacitySegments(wh)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ startWeek: 0, endWeek: 3, allocationPercent: 150 })
  })

  it('changing 100% → 50%', () => {
    const wh = new Map([[0, 1.0], [1, 1.0], [2, 1.0], [3, 1.0], [4, 0.5], [5, 0.5], [6, 0.5], [7, 0.5]])
    const segs = materializeRoleCapacitySegments(wh)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toMatchObject({ startWeek: 0, endWeek: 3, allocationPercent: 100 })
    expect(segs[1]).toMatchObject({ startWeek: 4, endWeek: 7, allocationPercent: 50 })
  })

  it('discontinuous 100%, gap, 100%', () => {
    const wh = new Map([[0, 1.0], [1, 1.0], [2, 1.0], [3, 1.0], [8, 1.0], [9, 1.0], [10, 1.0], [11, 1.0]])
    const segs = materializeRoleCapacitySegments(wh)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toMatchObject({ startWeek: 0, endWeek: 3, allocationPercent: 100 })
    expect(segs[1]).toMatchObject({ startWeek: 8, endWeek: 11, allocationPercent: 100 })
    // No segment bridges the gap
    expect(segs[0].endWeek).toBeLessThan(segs[1].startWeek - 1)
  })

  it('adjacent identical periods merge', () => {
    // Two periods with same 100% but adjacent (end of one = start of next)
    const wh = new Map([[0, 1.0], [1, 1.0], [2, 1.0], [3, 1.0], [4, 1.0]])
    const segs = materializeRoleCapacitySegments(wh)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ startWeek: 0, endWeek: 4, allocationPercent: 100 })
  })

  it('input week order determinism', () => {
    // Same data but constructed in different insertion order
    const wh1 = new Map([[4, 0.5], [0, 1.0], [3, 1.0], [1, 1.0], [2, 1.0], [5, 0.5], [6, 0.5], [7, 0.5]])
    const wh2 = new Map([[0, 1.0], [1, 1.0], [2, 1.0], [3, 1.0], [4, 0.5], [5, 0.5], [6, 0.5], [7, 0.5]])
    expect(materializeRoleCapacitySegments(wh1)).toEqual(materializeRoleCapacitySegments(wh2))
  })

  it('empty map returns empty array', () => {
    expect(materializeRoleCapacitySegments(new Map())).toEqual([])
  })
})
