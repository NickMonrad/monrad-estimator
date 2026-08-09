// ─── Capacity Profile type unions (mirrors server CapacityProfileMapping) ──

export type CapacityProfilePlanningBasis =
  | 'demandFollowing'
  | 'availabilityWindow'
  | 'wholeProjectAllocation'
  | 'capacityProfile'

export type CapacityProfileSource =
  | 'fixed'
  | 'manual'
  | 'availabilityWindow'
  | 'squadPlanner'
  | 'imported'
  | 'derived'
  | 'legacy'

export type CapacityProfileResolutionSource = 'PROFILE' | 'LEGACY' | 'ACTIVE_CAPACITY_PLAN'

export interface GlobalResourceType {
  id: string
  name: string
  category: string
  description?: string
  defaultHoursPerDay?: number | null
  defaultDayRate?: number | null
  isDefault: boolean
}

export interface ResourceType {
  id: string
  name: string
  category: 'ENGINEERING' | 'GOVERNANCE' | 'PROJECT_MANAGEMENT'
  count: number
  hoursPerDay?: number | null
  dayRate?: number | null
  proposedName?: string
  globalTypeId?: string
  globalType?: GlobalResourceType
  projectId: string
  allocationMode?: string
  allocationPercent?: number
  allocationStartWeek?: number | null
  allocationEndWeek?: number | null
}

export interface Task {
  id: string
  name: string
  description?: string
  assumptions?: string
  hoursEffort: number
  durationDays?: number
  order: number
  userStoryId: string
  resourceTypeId: string | null
  resourceType: ResourceType | null
}

export interface UserStory {
  id: string
  name: string
  description?: string
  assumptions?: string
  order: number
  featureId: string
  appliedTemplateId?: string | null
  isActive?: boolean
  tasks: Task[]
}

export interface Feature {
  id: string
  name: string
  description?: string
  assumptions?: string
  order: number
  epicId: string
  isActive?: boolean
  featureMode?: string
  userStories: UserStory[]
}

export interface Epic {
  id: string
  name: string
  description?: string | null
  assumptions?: string | null
  order: number
  projectId: string
  isActive?: boolean
  featureMode?: string
  features: Feature[]
}

export interface ProjectCustomer {
  id: string
  name: string
}

export interface Project {
  id: string
  name: string
  description?: string
  customer?: string | ProjectCustomer | null
  status: string
  /** Explicit project-level planning state (issue #449). */
  planningState?: 'CURRENT' | 'NEEDS_REPLAN'
  hoursPerDay: number
  bufferWeeks?: number
  onboardingWeeks?: number
  startDate?: string
  updatedAt: string
  taxRate?: number | null
  taxLabel?: string
}

export interface ProjectDiscount {
  id: string
  projectId: string
  resourceTypeId: string | null
  type: 'PERCENTAGE' | 'FIXED_AMOUNT'
  value: number
  label: string
  order: number
  resourceType?: ResourceType | null
  createdAt: string
}

export interface RateCardEntry {
  id: string
  rateCardId: string
  globalResourceTypeId: string
  globalResourceType: { id: string; name: string; category: string }
  dayRate: number
}

export interface RateCard {
  id: string
  name: string
  version: number
  isDefault: boolean
  entries: RateCardEntry[]
  createdAt: string
  updatedAt: string
}

export interface TimelineEntry {
  featureId: string
  featureName: string
  epicId: string
  epicName: string
  epicOrder?: number
  epicFeatureMode?: string
  epicScheduleMode?: string
  epicTimelineStartWeek?: number | null
  featureOrder?: number
  startWeek: number
  durationWeeks: number
  isManual: boolean
  startDate: string | null
  endDate: string | null
  resourceBreakdown?: { name: string; days: number }[]
  effectiveEngineers?: { name: string; engineerEquivalent: number; totalEngineers: number }[]
  timelineColour?: string | null
}

export interface ParallelWarning {
  epicId: string
  epicName: string
  resourceTypeName: string
  demandDays: number
  capacityDays: number
}

export interface StoryTimelineEntry {
  storyId: string
  storyName: string
  featureId: string
  startWeek: number
  durationWeeks: number
  isManual: boolean
}

export interface FeatureDependency {
  featureId: string
  dependsOnId: string
}

export interface StoryDependency {
  storyId: string
  dependsOnId: string
}

export type PricingModel = 'ACTUAL_DAYS' | 'PRO_RATA'

export interface NamedResourceEntry {
  id?: string
  resourceTypeId?: string
  resourceTypeName: string
  name: string
  startWeek: number | null
  endWeek: number | null
  allocationPct: number
  pricingModel?: PricingModel
  allocationMode?: string
  allocationPercent?: number
  allocationStartWeek?: number | null
  allocationEndWeek?: number | null
  actualAllocatedDays?: number
  actualAllocationStartWeek?: number | null
  actualAllocationEndWeek?: number | null
  actualAllocatedWeeks?: Array<{
    week: number
    days: number
    capacityDays: number
  }>
  actualAllocationSegments?: Array<{
    startWeek: number
    endWeek: number
    days: number
  }>
  synthetic?: boolean
  resourceIdentity?: 'NAMED_PERSON' | 'PLANNED_RESOURCE'
}

export interface TimelineSummary {
  projectId: string
  startDate: string | null
  hoursPerDay: number
  projectedEndDate?: string | null
  bufferWeeks?: number
  onboardingWeeks?: number
  parallelWarnings?: ParallelWarning[]
  entries: TimelineEntry[]
  storyEntries?: StoryTimelineEntry[]
  featureDependencies?: FeatureDependency[]
  storyDependencies?: StoryDependency[]
  weeklyDemand?: { week: number; resourceTypeName: string; demandDays: number; capacityDays: number }[]
  weeklyCapacity?: { week: number; resourceTypeName: string; capacityDays: number }[]
  namedResources?: NamedResourceEntry[]
}

export interface OverheadItem {
  id: string
  name: string
  resourceTypeId: string | null
  resourceType: ResourceType | null
  type: 'PERCENTAGE' | 'FIXED_DAYS' | 'DAYS_PER_WEEK'
  value: number
  order: number
}

export interface ResourceProfileStory {
  storyId: string
  storyName: string
  hours: number
  days: number
}

export interface ResourceProfileFeature {
  featureId: string
  featureName: string
  hours: number
  days: number
  stories: ResourceProfileStory[]
}

export interface ResourceProfileEpic {
  epicId: string
  epicName: string
  hours: number
  days: number
  features: ResourceProfileFeature[]
}

export interface ResourceProfileRow {
  resourceTypeId: string
  name: string
  category: string
  count: number
  hoursPerDay: number
  dayRate: number | null
  totalHours: number
  totalDays: number
  effortDays: number
  allocatedDays: number
  allocationMode: string
  allocationPercent: number
  allocationStartWeek: number | null
  allocationEndWeek: number | null
  derivedStartWeek: number | null
  derivedEndWeek: number | null
  estimatedCost: number | null
  epics: ResourceProfileEpic[]
  namedResources?: Array<{
    id: string
    name: string
    pricingModel?: PricingModel
    allocationMode: string
    allocationPercent: number
    allocationStartWeek: number | null
    allocationEndWeek: number | null
    startWeek: number | null
    endWeek: number | null
    allocatedDays: number
    derivedStartWeek: number | null
    derivedEndWeek: number | null
    actualAllocatedDays: number
    actualAllocationStartWeek: number | null
    actualAllocationEndWeek: number | null
    actualAllocatedWeeks: Array<{
      week: number
      days: number
      capacityDays: number
    }>
    actualAllocationSegments: Array<{
      startWeek: number
      endWeek: number
      days: number
    }>
    synthetic: boolean
    resourceIdentity?: 'NAMED_PERSON' | 'PLANNED_RESOURCE'
    capacityProfile?: {
      planningBasis: CapacityProfilePlanningBasis
      source: CapacityProfileSource
      defaultPercent: number | null
      startWeek: number | null
      endWeek: number | null
      segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>
      resolutionSource: CapacityProfileResolutionSource
    }
  }>
  capacityProfile?: {
    planningBasis: CapacityProfilePlanningBasis
    source: CapacityProfileSource
    defaultPercent: number | null
    startWeek: number | null
    endWeek: number | null
    segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>
    resolutionSource: CapacityProfileResolutionSource
  }
}

export interface OverheadProfileRow {
  overheadId: string
  name: string
  resourceTypeId: string | null
  resourceTypeName: string | null
  dayRate: number | null
  type: 'PERCENTAGE' | 'FIXED_DAYS' | 'DAYS_PER_WEEK'
  value: number
  computedDays: number
  estimatedCost: number | null
  /** FTE required to deliver this overhead workload (computedDays / (projectDurationWeeks × 5)) */
  requiredFTE: number
  /** Current count of the linked resource type, if linked */
  currentCount: number | null
}

export interface ResourceProfile {
  projectId: string
  /** Explicit project-level planning state (issue #449). */
  planningState?: 'CURRENT' | 'NEEDS_REPLAN'
  hoursPerDay: number
  projectDurationWeeks: number
  bufferWeeks: number
  onboardingWeeks: number
  resourceRows: ResourceProfileRow[]
  overheadRows: OverheadProfileRow[]
  summary: {
    totalHours: number
    totalDays: number
    totalCost: number | null
    hasCost: boolean
  }
}
