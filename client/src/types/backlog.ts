export interface GlobalResourceType {
  id: string
  name: string
  category: string
  description?: string
  isDefault: boolean
}

export interface ResourceType {
  id: string
  name: string
  category: 'ENGINEERING' | 'GOVERNANCE' | 'PROJECT_MANAGEMENT'
  count: number
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
