import type { CapacityPlanConfig } from '../lib/capacity-planner.js'
import type {
  SchedulerEpic,
  SchedulerFeature,
  SchedulerInput,
  SchedulerResourceType,
  SchedulerStory,
} from '../lib/scheduler.js'

export function makeTask(
  hoursEffort: number,
  resourceTypeId: string,
  resourceTypeName: string,
  hoursPerDay = 8,
  durationDays: number | null = null,
) {
  return {
    resourceTypeId,
    hoursEffort,
    durationDays,
    resourceType: { id: resourceTypeId, name: resourceTypeName, hoursPerDay },
  }
}

export function makeStory(
  id: string,
  tasks: ReturnType<typeof makeTask>[],
  order = 0,
): SchedulerStory {
  return { id, order, isActive: true, tasks }
}

export function makeFeature(
  id: string,
  stories: SchedulerStory[],
  order = 0,
  dependencies: Array<{ featureId: string; dependsOnId: string }> = [],
): SchedulerFeature {
  return {
    id,
    order,
    isActive: true,
    timelineStartWeek: null,
    userStories: stories,
    dependencies,
  }
}

export function makeEpic(
  id: string,
  features: SchedulerFeature[],
  order = 0,
  options: Partial<Pick<SchedulerEpic, 'featureMode' | 'scheduleMode' | 'timelineStartWeek'>> = {},
): SchedulerEpic {
  return {
    id,
    name: id,
    order,
    isActive: true,
    featureMode: 'sequential',
    scheduleMode: 'sequential',
    timelineStartWeek: null,
    features,
    ...options,
  }
}

export function makeResourceType(
  id: string,
  name: string,
  count: number,
  hoursPerDay = 8,
  extra: Partial<SchedulerResourceType> = {},
): SchedulerResourceType {
  return { id, name, count, hoursPerDay, namedResources: [], ...extra }
}

export function makeInput(
  epics: SchedulerEpic[],
  resourceTypes: SchedulerResourceType[],
  overrides: Partial<SchedulerInput> = {},
): SchedulerInput {
  return {
    project: { hoursPerDay: 8 },
    epics,
    resourceTypes,
    epicDeps: [],
    manualFeatureEntries: [],
    manualStoryEntries: [],
    resourceLevel: true,
    ...overrides,
  }
}

const dev = () => makeResourceType('rt-dev', 'Developer', 1)

export function serialCriticalPath(): SchedulerInput {
  const first = makeFeature(
    'serial-f0',
    [makeStory('serial-s0', [makeTask(40, 'rt-dev', 'Developer', 8, 10)])],
    0,
  )
  const second = makeFeature(
    'serial-f1',
    [makeStory('serial-s1', [makeTask(40, 'rt-dev', 'Developer', 8, 10)])],
    1,
    [{ featureId: 'serial-f1', dependsOnId: 'serial-f0' }],
  )
  return makeInput([makeEpic('serial-epic', [first, second])], [dev()])
}

export function parallelSameRole(): SchedulerInput {
  const features = [0, 1].map(index => makeFeature(
    `parallel-f${index}`,
    [makeStory(`parallel-s${index}`, [makeTask(80, 'rt-dev', 'Developer')])],
    index,
  ))
  return makeInput([
    makeEpic('parallel-epic', features, 0, { featureMode: 'parallel' }),
  ], [dev()])
}

export function roleHandoff(): SchedulerInput {
  const feature = makeFeature('handoff-f', [
    makeStory('handoff-dev', [makeTask(40, 'rt-dev', 'Developer')], 0),
    makeStory('handoff-qa', [makeTask(40, 'rt-qa', 'QA')], 1),
  ])
  return makeInput([
    makeEpic('handoff-epic', [feature]),
  ], [
    dev(),
    makeResourceType('rt-qa', 'QA', 1),
  ])
}

export function sparseSpecialist(): SchedulerInput {
  const feature = makeFeature('sparse-f', [makeStory('sparse-s', [
    makeTask(160, 'rt-dev', 'Developer'),
    makeTask(8, 'rt-specialist', 'Specialist'),
  ])])
  return makeInput([
    makeEpic('sparse-epic', [feature]),
  ], [
    dev(),
    makeResourceType('rt-specialist', 'Specialist', 1),
  ])
}

export function explicitRoleMaximum(): {
  input: SchedulerInput
  config: CapacityPlanConfig
} {
  const features = [0, 1].map(index => makeFeature(
    `cap-f${index}`,
    [makeStory(`cap-s${index}`, [makeTask(80, 'rt-dev', 'Developer')])],
    index,
  ))
  const input = makeInput([
    makeEpic('cap-epic', features, 0, { featureMode: 'parallel' }),
  ], [makeResourceType('rt-dev', 'Developer', 4)])
  return {
    input,
    config: {
      targetDurationWeeks: 2,
      periodWeeks: 4,
      maxDeltaPerPeriod: 10,
      minFloor: new Map([['rt-dev', 0]]),
      maxCap: new Map([['rt-dev', 1]]),
      dayRates: new Map(),
      smoothingMode: 'exact',
      maxParallelismPerFeature: 2,
    },
  }
}

export function manualCapacityAndScheduleLock(): SchedulerInput {
  const locked = makeFeature('locked-f', [
    makeStory('locked-s', [makeTask(80, 'rt-dev', 'Developer')]),
  ])
  const following = makeFeature(
    'following-f',
    [makeStory('following-s', [makeTask(40, 'rt-dev', 'Developer')])],
    1,
    [{ featureId: 'following-f', dependsOnId: 'locked-f' }],
  )
  const lockedRole = makeResourceType('rt-dev', 'Developer', 1, 8, {
    roleSegments: [{ startWeek: 3, endWeek: 7, allocationPercent: 100 }],
  })
  return makeInput([
    makeEpic('locked-epic', [locked, following]),
  ], [lockedRole], {
    manualFeatureEntries: [{ featureId: 'locked-f', startWeek: 3, durationWeeks: 2 }],
  })
}
export function epicDependencyViolation(): SchedulerInput {
  const predecessor = makeFeature('dependency-predecessor', [
    makeStory('dependency-predecessor-story', [makeTask(40, 'rt-dev', 'Developer')]),
  ])
  const dependent = makeFeature('dependency-dependent', [
    makeStory('dependency-dependent-story', [makeTask(40, 'rt-dev', 'Developer')]),
  ])
  return makeInput([
    makeEpic('dependency-source-epic', [predecessor]),
    makeEpic('dependency-dependent-epic', [dependent], 1),
  ], [dev()], {
    epicDeps: [{ epicId: 'dependency-dependent-epic', dependsOnId: 'dependency-source-epic' }],
    manualFeatureEntries: [{ featureId: 'dependency-dependent', startWeek: 0, durationWeeks: 1 }],
  })
}
export function implicitEpicDependencyViolation(): SchedulerInput {
  const predecessor = makeFeature('implicit-dependency-predecessor', [
    makeStory('implicit-dependency-predecessor-story', [makeTask(40, 'rt-dev', 'Developer')]),
  ])
  const dependent = makeFeature('implicit-dependency-dependent', [
    makeStory('implicit-dependency-dependent-story', [makeTask(40, 'rt-dev', 'Developer')]),
  ])
  return makeInput([
    makeEpic('implicit-dependency-source-epic', [predecessor]),
    makeEpic('implicit-dependency-dependent-epic', [dependent], 1),
  ], [dev()], {
    manualFeatureEntries: [{ featureId: 'implicit-dependency-dependent', startWeek: 0, durationWeeks: 1 }],
  })
}


export function mixedProgramme(): SchedulerInput {
  const foundation = makeFeature('mixed-foundation', [
    makeStory('mixed-foundation-s', [
      makeTask(80, 'rt-dev', 'Developer'),
      makeTask(40, 'rt-qa', 'QA'),
    ]),
  ])
  const parallelA = makeFeature('mixed-parallel-a', [
    makeStory('mixed-parallel-a-s', [makeTask(80, 'rt-dev', 'Developer')]),
  ], 0, [{ featureId: 'mixed-parallel-a', dependsOnId: 'mixed-foundation' }])
  const parallelB = makeFeature('mixed-parallel-b', [
    makeStory('mixed-parallel-b-s', [makeTask(40, 'rt-dev', 'Developer')]),
  ], 1, [{ featureId: 'mixed-parallel-b', dependsOnId: 'mixed-foundation' }])
  const closeout = makeFeature('mixed-closeout', [
    makeStory('mixed-closeout-s', [makeTask(40, 'rt-qa', 'QA')]),
  ], 2, [{ featureId: 'mixed-closeout', dependsOnId: 'mixed-parallel-a' }])

  return makeInput([
    makeEpic('mixed-foundation-epic', [foundation]),
    makeEpic('mixed-delivery-epic', [parallelA, parallelB, closeout], 1, {
      featureMode: 'parallel',
    }),
  ], [dev(), makeResourceType('rt-qa', 'QA', 1)])
}

/**
 * Deterministic synthetic large-programme benchmark for planner validation.
 *
 * The programme is generated from explicit index-based rules so its size,
 * effort distribution, dependency shape and capacity constraint are synthetic
 * rather than derived from a customer project.
 */
export const SYNTHETIC_LARGE_PROGRAMME_FACTS = {
  epicCount: 14,
  featureCount: 210,
  roleCount: 3,
  roleCounts: { platform: 3, data: 5, cloud: 2 },
  targetDurationWeeks: 48,
  periodWeeks: 4,
  maxDeltaPerPeriod: 1,
  maxParallelismPerFeature: 3,
  maxConcurrentEpics: 4,
  constrainedRoleId: 'synthetic-role-data',
  constrainedProfileEndWeek: 6,
  constrainedAllocationPercent: 100,
} as const

const SYNTHETIC_ROLE_SPECS = [
  ['synthetic-role-platform', 'Platform Engineer', SYNTHETIC_LARGE_PROGRAMME_FACTS.roleCounts.platform],
  ['synthetic-role-data', 'Data Engineer', SYNTHETIC_LARGE_PROGRAMME_FACTS.roleCounts.data],
  ['synthetic-role-cloud', 'Cloud Engineer', SYNTHETIC_LARGE_PROGRAMME_FACTS.roleCounts.cloud],
] as const

type SyntheticLargeProgrammeFacts = typeof SYNTHETIC_LARGE_PROGRAMME_FACTS & {
  totalEffortHours: number
  effortHoursByRole: Record<string, number>
  taskCountByRole: Record<string, number>
}

export type SyntheticLargeProgrammeBenchmark = {
  input: SchedulerInput
  config: CapacityPlanConfig
  facts: SyntheticLargeProgrammeFacts
}

function syntheticEffortHours(featureIndex: number, roleIndex: number): number {
  const roleIsOptional = roleIndex === 1
    ? featureIndex % 7 === 0
    : roleIndex === 2
      ? featureIndex % 4 === 0
      : featureIndex % 6 === 0
  if (roleIsOptional) return 0
  return 16 + ((featureIndex * 7 + roleIndex * 11) % 8) * 8
}

function syntheticFeatureDependencies(featureIndex: number, featureIndexWithinEpic: number): number[] {
  const dependencies: number[] = []
  if (featureIndexWithinEpic % 4 === 1) dependencies.push(featureIndex - 1)
  if (featureIndexWithinEpic % 4 === 2) dependencies.push(featureIndex - 2)
  if (featureIndexWithinEpic >= 7 && featureIndexWithinEpic % 7 === 0) dependencies.push(featureIndex - 7)
  return dependencies
}

export function syntheticLargeProgrammeBenchmark(): SyntheticLargeProgrammeBenchmark {
  const roleTypes = SYNTHETIC_ROLE_SPECS.map(([id, name, count], roleIndex) => makeResourceType(
    id,
    name,
    count,
    8,
    roleIndex === 1
      ? {
          roleSegments: [{
            startWeek: 0,
            endWeek: SYNTHETIC_LARGE_PROGRAMME_FACTS.constrainedProfileEndWeek,
            allocationPercent: SYNTHETIC_LARGE_PROGRAMME_FACTS.constrainedAllocationPercent,
          }],
        }
      : {},
  ))
  const roleIds = roleTypes.map(role => role.id)
  const roleNames = roleTypes.map(role => role.name)
  const features: SchedulerFeature[] = []

  for (let epicIndex = 0; epicIndex < SYNTHETIC_LARGE_PROGRAMME_FACTS.epicCount; epicIndex++) {
    for (let featureIndexWithinEpic = 0; featureIndexWithinEpic < 15; featureIndexWithinEpic++) {
      const featureIndex = epicIndex * 15 + featureIndexWithinEpic
      const featureId = `synthetic-feature-${String(featureIndex + 1).padStart(3, '0')}`
      const tasks = [0, 1, 2].flatMap(roleIndex => {
        const hours = syntheticEffortHours(featureIndex, roleIndex)
        return hours > 0
          ? [makeTask(hours, roleIds[roleIndex], roleNames[roleIndex])]
          : []
      })
      features.push(makeFeature(
        featureId,
        [makeStory(`synthetic-story-${String(featureIndex + 1).padStart(3, '0')}`, tasks)],
        featureIndexWithinEpic,
        syntheticFeatureDependencies(featureIndex, featureIndexWithinEpic).map(dependsOnIndex => ({
          featureId,
          dependsOnId: `synthetic-feature-${String(dependsOnIndex + 1).padStart(3, '0')}`,
        })),
      ))
    }
  }

  const epics: SchedulerEpic[] = []
  for (let epicIndex = 0; epicIndex < SYNTHETIC_LARGE_PROGRAMME_FACTS.epicCount; epicIndex++) {
    const firstFeatureIndex = epicIndex * 15
    epics.push(makeEpic(
      `synthetic-epic-${String(epicIndex + 1).padStart(2, '0')}`,
      features.slice(firstFeatureIndex, firstFeatureIndex + 15),
      epicIndex,
      { featureMode: epicIndex % 2 === 0 ? 'parallel' : 'sequential' },
    ))
  }

  const input = makeInput(epics, roleTypes, {
    resourceLevel: false,
    maxParallelismPerFeature: SYNTHETIC_LARGE_PROGRAMME_FACTS.maxParallelismPerFeature,
    epicDeps: [4, 8, 12].map(epicIndex => ({
      epicId: epics[epicIndex].id,
      dependsOnId: epics[epicIndex - 2].id,
    })),
  })

  const effortHoursByRole = Object.fromEntries(roleTypes.map(role => [role.id, 0])) as Record<string, number>
  const taskCountByRole = Object.fromEntries(roleTypes.map(role => [role.id, 0])) as Record<string, number>
  for (const epic of input.epics) {
    for (const feature of epic.features) {
      for (const task of feature.userStories.flatMap(story => story.tasks)) {
        if (!task.resourceTypeId) continue
        effortHoursByRole[task.resourceTypeId] += task.hoursEffort
        taskCountByRole[task.resourceTypeId] += 1
      }
    }
  }
  const totalEffortHours = Object.values(effortHoursByRole).reduce((total, effort) => total + effort, 0)

  return {
    facts: {
      ...SYNTHETIC_LARGE_PROGRAMME_FACTS,
      totalEffortHours,
      effortHoursByRole,
      taskCountByRole,
    },
    input,
    config: {
      targetDurationWeeks: SYNTHETIC_LARGE_PROGRAMME_FACTS.targetDurationWeeks,
      periodWeeks: SYNTHETIC_LARGE_PROGRAMME_FACTS.periodWeeks,
      maxDeltaPerPeriod: SYNTHETIC_LARGE_PROGRAMME_FACTS.maxDeltaPerPeriod,
      minFloor: new Map(roleTypes.map(role => [role.id, 0])),
      dayRates: new Map(),
      maxParallelismPerFeature: SYNTHETIC_LARGE_PROGRAMME_FACTS.maxParallelismPerFeature,
      maxConcurrentEpics: SYNTHETIC_LARGE_PROGRAMME_FACTS.maxConcurrentEpics,
    },
  }
}
