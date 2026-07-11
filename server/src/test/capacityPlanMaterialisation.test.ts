import { describe, it, expect } from 'vitest'
import { materializeResourceTrajectories } from '../lib/capacityPlanMaterialisation.js'

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
