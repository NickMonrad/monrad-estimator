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
  tasks: Task[]
}

export interface Feature {
  id: string
  name: string
  description?: string
  assumptions?: string
  order: number
  epicId: string
  userStories: UserStory[]
}

export interface Epic {
  id: string
  name: string
  description?: string
  order: number
  projectId: string
  features: Feature[]
}

export interface Project {
  id: string
  name: string
  description?: string
  customer?: string
  status: string
  hoursPerDay: number
  startDate?: string
  updatedAt: string
}

export interface TimelineEntry {
  featureId: string
  featureName: string
  epicId: string
  epicName: string
  startWeek: number
  durationWeeks: number
  isManual: boolean
  startDate: string | null
  endDate: string | null
}

export interface TimelineSummary {
  projectId: string
  startDate: string | null
  hoursPerDay: number
  entries: TimelineEntry[]
}

export interface OverheadItem {
  id: string
  name: string
  resourceTypeId: string | null
  resourceType: ResourceType | null
  type: 'PERCENTAGE' | 'FIXED_DAYS'
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
  estimatedCost: number | null
  epics: ResourceProfileEpic[]
}

export interface OverheadProfileRow {
  overheadId: string
  name: string
  resourceTypeId: string | null
  resourceTypeName: string | null
  dayRate: number | null
  type: 'PERCENTAGE' | 'FIXED_DAYS'
  value: number
  computedDays: number
  estimatedCost: number | null
}

export interface ResourceProfile {
  projectId: string
  hoursPerDay: number
  resourceRows: ResourceProfileRow[]
  overheadRows: OverheadProfileRow[]
  summary: {
    totalHours: number
    totalDays: number
    totalCost: number | null
    hasCost: boolean
  }
}
