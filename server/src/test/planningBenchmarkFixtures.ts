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
  const features = [0, 1].map(index => makeFeature(
    `serial-f${index}`,
    [makeStory(`serial-s${index}`, [makeTask(40, 'rt-dev', 'Developer', 8, 10)])],
    index,
  ))
  return makeInput([makeEpic('serial-epic', features)], [dev()])
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
  return makeInput([
    makeEpic('locked-epic', [locked, following]),
  ], [dev()], {
    manualFeatureEntries: [{ featureId: 'locked-f', startWeek: 3, durationWeeks: 2 }],
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
 * Sanitised Factory / Supply Chain representative.
 *
 * No Factory/Supply Chain CSV or workbook exists in this repository or its git
 * history. The published planning facts are retained here: 23 epics, 248
 * features, roughly 26k hours, and seven role types. Names, work-item text,
 * customer data, and exact weekly profiles are intentionally absent.
 */
export const FACTORY_SUPPLY_CHAIN_FACTS = {
  epicCount: 23,
  featureCount: 248,
  roleCount: 7,
  approximateEffortHours: 26_000,
  targetDurationWeeks: 78,
  constrainedRoleId: 'factory-role-data',
  constrainedRoleName: 'Data Integration',
  constrainedProfileEndWeek: 5,
} as const

const FACTORY_ROLES = [
  ['factory-role-data', 'Data Integration'],
  ['factory-role-engineering', 'Platform Engineering'],
  ['factory-role-analytics', 'Analytics'],
  ['factory-role-testing', 'Quality Engineering'],
  ['factory-role-security', 'Security'],
  ['factory-role-change', 'Change and Training'],
  ['factory-role-delivery', 'Delivery Management'],
] as const

export type FactorySupplyChainBenchmark = {
  input: SchedulerInput
  config: CapacityPlanConfig
  facts: typeof FACTORY_SUPPLY_CHAIN_FACTS
}

export function factorySupplyChainBenchmark(): FactorySupplyChainBenchmark {
  const roleTypes = FACTORY_ROLES.map(([id, name], roleIndex) => makeResourceType(
    id,
    name,
    roleIndex === 0 ? 3 : 2,
    8,
    roleIndex === 0
      ? { roleSegments: [{ startWeek: 0, endWeek: FACTORY_SUPPLY_CHAIN_FACTS.constrainedProfileEndWeek, allocationPercent: 100 }] }
      : {},
  ))

  const featuresPerEpic = Array.from({ length: FACTORY_SUPPLY_CHAIN_FACTS.epicCount }, (_, index) =>
    index === FACTORY_SUPPLY_CHAIN_FACTS.epicCount - 1 ? 6 : 11,
  )
  const epics: SchedulerEpic[] = []
  let featureIndex = 0

  for (let epicIndex = 0; epicIndex < featuresPerEpic.length; epicIndex++) {
    const features: SchedulerFeature[] = []
    for (let localIndex = 0; localIndex < featuresPerEpic[epicIndex]; localIndex++) {
      const primaryRole = (featureIndex + epicIndex) % FACTORY_ROLES.length
      const secondaryRole = (primaryRole + 2) % FACTORY_ROLES.length
      const tasks = [
        makeTask(64 + (featureIndex % 3) * 8, FACTORY_ROLES[primaryRole][0], FACTORY_ROLES[primaryRole][1]),
        makeTask(24 + (epicIndex % 2) * 8, FACTORY_ROLES[secondaryRole][0], FACTORY_ROLES[secondaryRole][1]),
      ]
      if (featureIndex % 4 === 0) {
        const tertiaryRole = (primaryRole + 4) % FACTORY_ROLES.length
        tasks.push(makeTask(16, FACTORY_ROLES[tertiaryRole][0], FACTORY_ROLES[tertiaryRole][1]))
      }
      features.push(makeFeature(
        `factory-feature-${String(featureIndex + 1).padStart(3, '0')}`,
        [makeStory(`factory-story-${String(featureIndex + 1).padStart(3, '0')}`, tasks)],
        localIndex,
      ))
      featureIndex++
    }
    epics.push(makeEpic(
      `factory-epic-${String(epicIndex + 1).padStart(2, '0')}`,
      features,
      epicIndex,
      { featureMode: epicIndex % 3 === 0 ? 'parallel' : 'sequential' },
    ))
  }

  return {
    facts: FACTORY_SUPPLY_CHAIN_FACTS,
    input: makeInput(epics, roleTypes, { resourceLevel: false, maxParallelismPerFeature: 2 }),
    config: {
      targetDurationWeeks: FACTORY_SUPPLY_CHAIN_FACTS.targetDurationWeeks,
      periodWeeks: 13,
      maxDeltaPerPeriod: 1,
      minFloor: new Map(roleTypes.map(rt => [rt.id, 0])),
      dayRates: new Map(),
      maxParallelismPerFeature: 2,
      maxConcurrentEpics: 6,
    },
  }
}
