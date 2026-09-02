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
 * Sanitised Factory / Supply Chain benchmark derived from the authoritative
 * generated programme-led import and its planning outputs.
 *
 * The committed representation keeps only generic topology, dependency edges,
 * role-level effort and the staffing/profile shape needed by the planners.
 * Customer names, descriptions, story text and identifiers are not retained.
 */
export const FACTORY_SUPPLY_CHAIN_FACTS = {
  source: 'authoritative generated programme-led import and planning outputs',
  epicCount: 18,
  featureCount: 222,
  roleCount: 3,
  totalEffortHours: 16_989.8,
  effortHoursByRole: { pc: 4_062.2, data: 10_024.4, cloud: 2_903.2 },
  taskCountByRole: { pc: 237, data: 281, cloud: 162 },
  targetDurationWeeks: 78,
  sourceProfilePeakCapacity: { pc: 2.25, data: 5.5, cloud: 1.5 },
  constrainedRoleId: 'factory-role-data',
  constrainedProfileEndWeek: 5,
  controlDeliveryWeeks: 53,
} as const

const FACTORY_ROLES = [
  ['factory-role-pc', 'Principal Consultant', 3],
  ['factory-role-data', 'Senior Data Engineer', 6],
  ['factory-role-cloud', 'Senior Cloud Engineer', 2],
] as const

type FactoryFeatureShape = {
  mode: 'parallel' | 'sequential'
  efforts: [number, number, number]
  deps: number[]
}

// One tuple per source feature, in source programme order. Effort is summed
// by role within the feature; dependency indices are source dependency edges.
const FACTORY_FEATURE_SHAPES: readonly FactoryFeatureShape[] = [
  { mode: 'parallel', efforts: [26.6, 0.0, 15.2], deps: [] },
  { mode: 'sequential', efforts: [49.4, 0.0, 0.0], deps: [] },
  { mode: 'sequential', efforts: [22.8, 15.2, 110.2], deps: [] },
  { mode: 'parallel', efforts: [11.4, 7.6, 30.4], deps: [2] },
  { mode: 'parallel', efforts: [106.4, 319.2, 83.6], deps: [8] },
  { mode: 'parallel', efforts: [30.4, 53.2, 30.4], deps: [8] },
  { mode: 'parallel', efforts: [26.6, 72.2, 15.2], deps: [8] },
  { mode: 'parallel', efforts: [19.0, 0.0, 26.6], deps: [8] },
  { mode: 'sequential', efforts: [102.6, 15.2, 0.0], deps: [] },
  { mode: 'sequential', efforts: [0.0, 0.0, 15.2], deps: [8] },
  { mode: 'sequential', efforts: [7.6, 258.4, 0.0], deps: [9] },
  { mode: 'sequential', efforts: [0.0, 7.6, 15.2], deps: [10] },
  { mode: 'sequential', efforts: [41.8, 72.2, 19.0], deps: [11, 4, 5, 6] },
  { mode: 'sequential', efforts: [34.2, 0.0, 30.4], deps: [12] },
  { mode: 'sequential', efforts: [15.2, 30.4, 26.6], deps: [13, 7] },
  { mode: 'sequential', efforts: [11.4, 26.6, 0.0], deps: [14] },
  { mode: 'parallel', efforts: [57.0, 205.2, 22.8], deps: [19] },
  { mode: 'parallel', efforts: [68.4, 205.2, 53.2], deps: [19] },
  { mode: 'parallel', efforts: [11.4, 30.4, 0.0], deps: [19] },
  { mode: 'sequential', efforts: [64.6, 0.0, 0.0], deps: [] },
  { mode: 'sequential', efforts: [0.0, 0.0, 7.6], deps: [19] },
  { mode: 'sequential', efforts: [3.8, 178.6, 0.0], deps: [20] },
  { mode: 'sequential', efforts: [0.0, 3.8, 7.6], deps: [21] },
  { mode: 'sequential', efforts: [19.0, 45.6, 3.8], deps: [22, 16, 17, 18] },
  { mode: 'sequential', efforts: [34.2, 0.0, 30.4], deps: [23] },
  { mode: 'sequential', efforts: [7.6, 19.0, 15.2], deps: [24] },
  { mode: 'sequential', efforts: [7.6, 15.2, 0.0], deps: [25] },
  { mode: 'sequential', efforts: [178.6, 57.0, 0.0], deps: [] },
  { mode: 'sequential', efforts: [0.0, 0.0, 26.6], deps: [27] },
  { mode: 'sequential', efforts: [30.4, 334.4, 0.0], deps: [28] },
  { mode: 'sequential', efforts: [0.0, 7.6, 11.4], deps: [29] },
  { mode: 'sequential', efforts: [38.0, 155.8, 30.4], deps: [30] },
  { mode: 'sequential', efforts: [34.2, 0.0, 30.4], deps: [31] },
  { mode: 'sequential', efforts: [15.2, 30.4, 34.2], deps: [32] },
  { mode: 'sequential', efforts: [11.4, 26.6, 0.0], deps: [33] },
  { mode: 'sequential', efforts: [41.8, 87.4, 64.6], deps: [29] },
  { mode: 'sequential', efforts: [45.6, 174.8, 64.6], deps: [29] },
  { mode: 'sequential', efforts: [15.2, 0.0, 7.6], deps: [] },
  { mode: 'sequential', efforts: [7.6, 15.2, 0.0], deps: [37] },
  { mode: 'sequential', efforts: [7.6, 0.0, 7.6], deps: [37, 38] },
  { mode: 'sequential', efforts: [0.0, 7.6, 0.0], deps: [39] },
  { mode: 'sequential', efforts: [3.8, 7.6, 0.0], deps: [40] },
  { mode: 'sequential', efforts: [3.8, 0.0, 0.0], deps: [41] },
  { mode: 'sequential', efforts: [15.2, 7.6, 0.0], deps: [42] },
  { mode: 'sequential', efforts: [64.6, 15.2, 0.0], deps: [] },
  { mode: 'sequential', efforts: [0.0, 0.0, 7.6], deps: [44] },
  { mode: 'sequential', efforts: [38.0, 171.0, 0.0], deps: [45] },
  { mode: 'sequential', efforts: [11.4, 76.0, 0.0], deps: [45, 46] },
  { mode: 'sequential', efforts: [0.0, 3.8, 7.6], deps: [47] },
  { mode: 'sequential', efforts: [26.6, 38.0, 3.8], deps: [48] },
  { mode: 'sequential', efforts: [22.8, 0.0, 19.0], deps: [49] },
  { mode: 'sequential', efforts: [7.6, 19.0, 15.2], deps: [50] },
  { mode: 'sequential', efforts: [7.6, 15.2, 0.0], deps: [51] },
  { mode: 'sequential', efforts: [57.0, 0.0, 0.0], deps: [] },
  { mode: 'sequential', efforts: [0.0, 0.0, 60.8], deps: [53] },
  { mode: 'sequential', efforts: [41.8, 159.6, 0.0], deps: [54] },
  { mode: 'sequential', efforts: [38.0, 159.6, 0.0], deps: [55] },
  { mode: 'sequential', efforts: [7.6, 273.6, 72.2], deps: [54, 55, 56] },
  { mode: 'sequential', efforts: [0.0, 7.6, 11.4], deps: [57] },
  { mode: 'sequential', efforts: [38.0, 53.2, 68.4], deps: [58] },
  { mode: 'sequential', efforts: [34.2, 0.0, 30.4], deps: [59] },
  { mode: 'sequential', efforts: [15.2, 30.4, 45.6], deps: [60] },
  { mode: 'sequential', efforts: [11.4, 26.6, 0.0], deps: [61] },
  { mode: 'sequential', efforts: [45.6, 174.8, 64.6], deps: [57] },
  { mode: 'sequential', efforts: [57.0, 0.0, 0.0], deps: [] },
  { mode: 'sequential', efforts: [0.0, 0.0, 19.0], deps: [64] },
  { mode: 'sequential', efforts: [0.0, 414.2, 30.4], deps: [65] },
  { mode: 'sequential', efforts: [0.0, 7.6, 11.4], deps: [66] },
  { mode: 'sequential', efforts: [34.2, 49.4, 30.4], deps: [67] },
  { mode: 'sequential', efforts: [22.8, 0.0, 19.0], deps: [68] },
  { mode: 'sequential', efforts: [15.2, 30.4, 45.6], deps: [69] },
  { mode: 'sequential', efforts: [11.4, 26.6, 0.0], deps: [70] },
  { mode: 'sequential', efforts: [106.4, 266.0, 114.0], deps: [66] },
  { mode: 'sequential', efforts: [34.2, 64.6, 60.8], deps: [66] },
  { mode: 'sequential', efforts: [95.0, 76.0, 0.0], deps: [] },
  { mode: 'sequential', efforts: [0.0, 0.0, 15.2], deps: [74] },
  { mode: 'sequential', efforts: [15.2, 83.6, 0.0], deps: [75] },
  { mode: 'sequential', efforts: [0.0, 3.8, 7.6], deps: [76] },
  { mode: 'sequential', efforts: [26.6, 41.8, 15.2], deps: [77] },
  { mode: 'sequential', efforts: [22.8, 0.0, 19.0], deps: [78] },
  { mode: 'sequential', efforts: [7.6, 19.0, 19.0], deps: [79] },
  { mode: 'sequential', efforts: [7.6, 15.2, 0.0], deps: [80] },
  { mode: 'sequential', efforts: [79.8, 15.2, 0.0], deps: [] },
  { mode: 'sequential', efforts: [0.0, 0.0, 7.6], deps: [82] },
  { mode: 'sequential', efforts: [7.6, 53.2, 0.0], deps: [83] },
  { mode: 'sequential', efforts: [0.0, 3.8, 7.6], deps: [84] },
  { mode: 'sequential', efforts: [26.6, 22.8, 3.8], deps: [85] },
  { mode: 'sequential', efforts: [11.4, 0.0, 11.4], deps: [86] },
  { mode: 'sequential', efforts: [7.6, 19.0, 15.2], deps: [87] },
  { mode: 'sequential', efforts: [7.6, 15.2, 0.0], deps: [88] },
  { mode: 'sequential', efforts: [15.2, 0.0, 7.6], deps: [] },
  { mode: 'sequential', efforts: [7.6, 15.2, 0.0], deps: [90] },
  { mode: 'sequential', efforts: [7.6, 0.0, 7.6], deps: [90, 91] },
  { mode: 'sequential', efforts: [0.0, 7.6, 0.0], deps: [92] },
  { mode: 'sequential', efforts: [3.8, 7.6, 0.0], deps: [93] },
  { mode: 'sequential', efforts: [3.8, 0.0, 0.0], deps: [94] },
  { mode: 'sequential', efforts: [15.2, 7.6, 0.0], deps: [95] },
  { mode: 'sequential', efforts: [110.2, 0.0, 0.0], deps: [] },
  { mode: 'sequential', efforts: [0.0, 0.0, 15.2], deps: [97] },
  { mode: 'sequential', efforts: [30.4, 144.4, 11.4], deps: [98] },
  { mode: 'sequential', efforts: [11.4, 395.2, 45.6], deps: [98, 99] },
  { mode: 'sequential', efforts: [0.0, 11.4, 15.2], deps: [100] },
  { mode: 'sequential', efforts: [41.8, 148.2, 11.4], deps: [101] },
  { mode: 'sequential', efforts: [34.2, 0.0, 30.4], deps: [102] },
  { mode: 'sequential', efforts: [15.2, 53.2, 49.4], deps: [103] },
  { mode: 'sequential', efforts: [19.0, 38.0, 0.0], deps: [104] },
  { mode: 'sequential', efforts: [49.4, 186.2, 72.2], deps: [100] },
  { mode: 'sequential', efforts: [76.0, 159.6, 60.8], deps: [100] },
  { mode: 'sequential', efforts: [34.2, 209.0, 0.0], deps: [100] },
  { mode: 'sequential', efforts: [41.8, 0.0, 0.0], deps: [] },
  { mode: 'sequential', efforts: [0.0, 0.0, 30.4], deps: [109] },
  { mode: 'sequential', efforts: [0.0, 543.4, 30.4], deps: [110] },
  { mode: 'sequential', efforts: [0.0, 11.4, 15.2], deps: [111] },
  { mode: 'sequential', efforts: [45.6, 326.8, 49.4], deps: [112] },
  { mode: 'sequential', efforts: [34.2, 0.0, 30.4], deps: [113] },
  { mode: 'sequential', efforts: [15.2, 41.8, 53.2], deps: [114] },
  { mode: 'sequential', efforts: [19.0, 38.0, 0.0], deps: [115] },
  { mode: 'sequential', efforts: [60.8, 224.2, 53.2], deps: [111] },
  { mode: 'sequential', efforts: [64.6, 296.4, 121.6], deps: [111] },
  { mode: 'sequential', efforts: [262.2, 136.8, 0.0], deps: [] },
  { mode: 'sequential', efforts: [0.0, 0.0, 22.8], deps: [119] },
  { mode: 'sequential', efforts: [34.2, 330.6, 0.0], deps: [120] },
  { mode: 'sequential', efforts: [0.0, 7.6, 26.6], deps: [121] },
  { mode: 'sequential', efforts: [155.8, 288.8, 15.2], deps: [122] },
  { mode: 'sequential', efforts: [34.2, 0.0, 30.4], deps: [123] },
  { mode: 'sequential', efforts: [30.4, 38.0, 15.2], deps: [124] },
  { mode: 'sequential', efforts: [19.0, 30.4, 0.0], deps: [125] },
  { mode: 'sequential', efforts: [60.8, 125.4, 0.0], deps: [119] },
  { mode: 'sequential', efforts: [106.4, 0.0, 0.0], deps: [] },
  { mode: 'sequential', efforts: [0.0, 0.0, 15.2], deps: [128] },
  { mode: 'sequential', efforts: [0.0, 440.8, 49.4], deps: [129] },
  { mode: 'sequential', efforts: [0.0, 11.4, 15.2], deps: [130] },
  { mode: 'sequential', efforts: [45.6, 95.0, 34.2], deps: [131] },
  { mode: 'sequential', efforts: [34.2, 0.0, 30.4], deps: [132] },
  { mode: 'sequential', efforts: [15.2, 53.2, 49.4], deps: [133] },
  { mode: 'sequential', efforts: [19.0, 38.0, 0.0], deps: [134] },
  { mode: 'sequential', efforts: [45.6, 209.0, 0.0], deps: [130] },
  { mode: 'sequential', efforts: [34.2, 45.6, 0.0], deps: [130] },
  { mode: 'sequential', efforts: [0.0, 57.0, 57.0], deps: [137] },
  { mode: 'sequential', efforts: [64.6, 269.8, 121.6], deps: [130] },
  { mode: 'sequential', efforts: [15.2, 0.0, 7.6], deps: [] },
  { mode: 'sequential', efforts: [7.6, 15.2, 0.0], deps: [140] },
  { mode: 'sequential', efforts: [7.6, 0.0, 7.6], deps: [140, 141] },
  { mode: 'sequential', efforts: [0.0, 7.6, 0.0], deps: [142] },
  { mode: 'sequential', efforts: [3.8, 7.6, 0.0], deps: [143] },
  { mode: 'sequential', efforts: [3.8, 0.0, 0.0], deps: [144] },
  { mode: 'sequential', efforts: [15.2, 7.6, 0.0], deps: [145] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [147] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [147] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [149] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [149] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [151] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [151] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [151] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [148] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [155] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [149, 151] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [155] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [149, 154] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [148] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [154, 159] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [155] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [158, 159, 201] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [159, 154] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [149] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [165] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [165] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [151, 154] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [168] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [151] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [170, 154] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [171] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [172, 180] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [151] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [174] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [175] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [151] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [177] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [151] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [148] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [151] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [180] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [182] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [151, 180] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [184] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [184] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [180, 181] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [181, 187] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [187, 182, 183] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [151] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [190] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [190, 191] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [151, 180] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [193, 182, 183] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [149] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [149] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [162] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [195, 196, 197] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [150, 198] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [199] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [155] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [172] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [175] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [184] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [187] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [193] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [176] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [176, 207] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [202, 182, 183] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [203, 180, 182, 183] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [205, 182, 183] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [193] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [206] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [212, 180] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [185, 182, 183] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [186] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [167] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [217, 180] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [167] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [219, 182, 183] },
  { mode: 'sequential', efforts: [0.0, 0.0, 0.0], deps: [212, 214, 180, 182, 183] },
]

const FACTORY_FEATURES_PER_EPIC = [2, 2, 12, 11, 10, 7, 9, 11, 10, 8, 8, 7, 12, 10, 9, 12, 7, 75]
const FACTORY_EPIC_MODES = ['parallel', 'parallel', 'parallel', 'parallel', 'parallel', 'parallel', 'parallel', 'parallel', 'parallel', 'parallel', 'parallel', 'parallel', 'parallel', 'parallel', 'parallel', 'parallel', 'parallel', 'parallel'] as const
const FACTORY_EPIC_DEPENDENCIES = [{ epicIndex: 1, dependsOnIndex: 0 }]

export type FactorySupplyChainBenchmark = {
  input: SchedulerInput
  config: CapacityPlanConfig
  facts: typeof FACTORY_SUPPLY_CHAIN_FACTS
}

export function factorySupplyChainBenchmark(): FactorySupplyChainBenchmark {
  const roleTypes = FACTORY_ROLES.map(([id, name, count], roleIndex) => makeResourceType(
    id,
    name,
    count,
    8,
    roleIndex === 1
      ? { roleSegments: [{ startWeek: 0, endWeek: FACTORY_SUPPLY_CHAIN_FACTS.constrainedProfileEndWeek, allocationPercent: 100 }] }
      : {},
  ))
  const roleIds = roleTypes.map(role => role.id)
  const roleNames = roleTypes.map(role => role.name)
  const features: SchedulerFeature[] = FACTORY_FEATURE_SHAPES.map((shape, featureIndex) => makeFeature(
    `factory-feature-${String(featureIndex + 1).padStart(3, '0')}`,
    [makeStory(
      `factory-story-${String(featureIndex + 1).padStart(3, '0')}`,
      shape.efforts.flatMap((hours, roleIndex) => hours > 0
        ? [makeTask(hours, roleIds[roleIndex], roleNames[roleIndex])]
        : []),
    )],
    featureIndex,
    shape.deps.map(dependsOnIndex => ({
      featureId: `factory-feature-${String(featureIndex + 1).padStart(3, '0')}`,
      dependsOnId: `factory-feature-${String(dependsOnIndex + 1).padStart(3, '0')}`,
    })),
  ))

  const epics: SchedulerEpic[] = []
  let featureOffset = 0
  for (let epicIndex = 0; epicIndex < FACTORY_FEATURES_PER_EPIC.length; epicIndex++) {
    const featureCount = FACTORY_FEATURES_PER_EPIC[epicIndex]
    epics.push(makeEpic(
      `factory-epic-${String(epicIndex + 1).padStart(2, '0')}`,
      features.slice(featureOffset, featureOffset + featureCount).map((feature, index) => ({
        ...feature,
        order: index,
      })),
      epicIndex,
      { featureMode: FACTORY_EPIC_MODES[epicIndex] },
    ))
    featureOffset += featureCount
  }

  return {
    facts: FACTORY_SUPPLY_CHAIN_FACTS,
    input: makeInput(epics, roleTypes, {
      resourceLevel: false,
      maxParallelismPerFeature: 2,
      epicDeps: FACTORY_EPIC_DEPENDENCIES.map(({ epicIndex, dependsOnIndex }) => ({
        epicId: `factory-epic-${String(epicIndex + 1).padStart(2, '0')}`,
        dependsOnId: `factory-epic-${String(dependsOnIndex + 1).padStart(2, '0')}`,
      })),
    }),
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
