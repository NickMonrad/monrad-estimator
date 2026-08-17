import axios from 'axios'
import { clearAuthSession, getStoredToken } from './authSession'

const baseURL = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api'

export const api = axios.create({ baseURL, timeout: 30000 })

/** Extract the server-provided error message from an axios rejection. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback
}

api.interceptors.request.use((config) => {
  const token = getStoredToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const isAuthRoute = err.config?.url?.startsWith('/auth/')
    if (err.response?.status === 401 && !isAuthRoute) {
      clearAuthSession()
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    return Promise.reject(err)
  }
)

export type BacklogItemType = 'epic' | 'feature' | 'story' | 'task'

export interface DuplicatedBacklogItem {
  type: BacklogItemType
  id: string
  name: string
  parentId: string | null
}

export const duplicateBacklogItem = (projectId: string, type: BacklogItemType, id: string) =>
  api.post<DuplicatedBacklogItem>(`/projects/${projectId}/backlog/duplicate`, { type, id }).then(r => r.data)

// Orgs
export const getOrgs = () => api.get('/orgs').then(r => r.data)
export const createOrg = (data: { name: string }) => api.post('/orgs', data).then(r => r.data)
export const getOrgMembers = (orgId: string) => api.get(`/orgs/${orgId}/members`).then(r => r.data)
export const removeOrgMember = (orgId: string, userId: string) => api.delete(`/orgs/${orgId}/members/${userId}`).then(r => r.data)
export const updateOrgMemberRole = (orgId: string, userId: string, role: string) => api.put(`/orgs/${orgId}/members/${userId}`, { role }).then(r => r.data)
export const inviteToOrg = (orgId: string, data: { email: string; role?: string }) => api.post(`/orgs/${orgId}/invites`, data).then(r => r.data)
export const acceptOrgInvite = (token: string) => api.post('/orgs/accept-invite', { token }).then(r => r.data)
export const getOrgInvites = (orgId: string) => api.get(`/orgs/${orgId}/invites`).then(r => r.data)
export const cancelOrgInvite = (orgId: string, inviteId: string) => api.delete(`/orgs/${orgId}/invites/${inviteId}`).then(r => r.data)
export const resendOrgInvite = (orgId: string, inviteId: string) => api.post(`/orgs/${orgId}/invites/${inviteId}/resend`).then(r => r.data)
export const moveProjectToOrg = (projectId: string, orgId: string) => api.post(`/projects/${projectId}/move-to-org`, { orgId }).then(r => r.data)


// Customers
export const getCustomers = () => api.get('/customers').then(r => r.data)
export const createCustomer = (data: { name: string; description?: string; accountCode?: string; crmLink?: string; orgId?: string }) => api.post('/customers', data).then(r => r.data)
export const updateCustomer = (id: string, data: { name?: string; description?: string; accountCode?: string; crmLink?: string; orgId?: string }) => api.put(`/customers/${id}`, data).then(r => r.data)
export const deleteCustomer = (id: string) => api.delete(`/customers/${id}`).then(r => r.data)

// ---------------------------------------------------------------------------
// Resource Optimiser
// ---------------------------------------------------------------------------

export interface OptimiserCandidateRT {
  resourceTypeId: string
  count: number
  suggestedStartWeek: number
}

export interface OptimiserMetrics {
  deliveryWeeks: number
  avgUtilisationPct: number
  gapWeeksByResourceTypeId: Record<string, number>
  estimatedCost: number
  parallelWarningCount: number
}

export interface OptimiserCandidate {
  resourceTypes: OptimiserCandidateRT[]
  metrics: OptimiserMetrics
  score: number
  scoreBreakdown: Record<string, number>
}

export interface OptimiserResponse {
  candidates: OptimiserCandidate[]
  baseline: OptimiserCandidate
  searchStats: {
    scenariosEvaluated: number
    candidatesFound: number
    durationMs: number
    sampled: boolean
  }
  /** Count of scenarios filtered out due to parallel over-allocation warnings */
  infeasibleCount: number
  resourceTypes: Array<{ id: string; name: string }>
  /** Resource-type IDs from the validated countRanges used by the optimiser. */
  optimiserScopeResourceTypeIds: string[]
}

export interface OptimiserRequest {
  mode: 'speed' | 'utilisation' | 'balanced'
  constraints: {
    countRanges: Array<{ resourceTypeId: string; min: number; max: number }>
    allowRampUp: boolean
    maxBudget?: number
    maxDurationWeeks?: number
    minDurationWeeks?: number
  }
  dayRates?: Record<string, number>
  topN?: number
}

export const runOptimiser = (projectId: string, body: OptimiserRequest): Promise<OptimiserResponse> =>
  api.post<OptimiserResponse>(`/projects/${projectId}/optimise`, body).then(r => r.data)

export const applyOptimiserScenario = (
  projectId: string,
  resourceTypes: Array<{ resourceTypeId: string; count: number; suggestedStartWeek: number }>,
  options: { optimiserScopeResourceTypeIds: string[]; staggerEpics?: boolean },
): Promise<{ message: string; snapshotId: string }> =>
  api
    .post<{ message: string; snapshotId: string }>(`/projects/${projectId}/optimise/apply`, {
      resourceTypes,
      optimiserScopeResourceTypeIds: options.optimiserScopeResourceTypeIds,
      staggerEpics: options.staggerEpics,
    })
    .then(r => r.data)

// ---------------------------------------------------------------------------
// Capacity Profile Transfer
// ---------------------------------------------------------------------------

export interface TransferToManualResult {
  transferred: boolean
  result: {
    profilesTransferred: number
    plannedResourceProfilesTransferred: number
    roleProfileTransferred: boolean
    protectedProfileIds: string[]
  }
}

/**
 * Transfer a Squad Planner-managed role to manual capacity ownership.
 * The role's capacity and segment boundaries are preserved; only the
 * ownership source changes from SQUAD_PLANNER to MANUAL.
 */
export const transferToManualCapacity = (
  projectId: string,
  resourceTypeId: string,
): Promise<TransferToManualResult> =>
  api
    .post<TransferToManualResult>(`/projects/${projectId}/capacity-profiles/transfer-to-manual`, {
      resourceTypeId,
    })
    .then(r => r.data)

// ---------------------------------------------------------------------------
// Reset Planning / Replan project (issue #449)
// ---------------------------------------------------------------------------

export interface ResetPlanningResult {
  projectId: string
  planningState: 'NEEDS_REPLAN'
}

/**
 * Deliberately discard the project's planning state (Reset Planning).
 * Requires explicit `{ confirm: true }` on the wire; preserves the backlog,
 * estimation and business/commercial data and marks the project NEEDS_REPLAN.
 */
export const resetProjectPlanning = (projectId: string): Promise<ResetPlanningResult> =>
  api
    .post<ResetPlanningResult>(`/projects/${projectId}/planning/reset`, { confirm: true })
    .then(r => r.data)

export interface CompleteReplanningResult {
  projectId: string
  planningState: 'CURRENT'
}

export interface ReplanIncompleteResponse {
  error: string
  code: 'REPLAN_INCOMPLETE'
  findings: string[]
}

/**
 * Complete replanning: the server validates the canonical project planning
 * state and atomically returns the project to CURRENT only when valid.
 * Rejects with `ReplanIncompleteResponse` (422) when the plan is incomplete.
 */
export const completeReplanning = (projectId: string): Promise<CompleteReplanningResult> =>
  api
    .post<CompleteReplanningResult>(`/projects/${projectId}/planning/complete`)
    .then(r => r.data)

// ---------------------------------------------------------------------------
// Bulk "Use role counts as As needed" (issue #456)
// ---------------------------------------------------------------------------

export interface BulkAsNeededResult {
  projectId: string
  /** The bulk action never transitions planning state — completion owns that. */
  planningState: 'NEEDS_REPLAN'
  /** Number of canonical ROLE profiles created by this call. */
  created: number
  /** Remaining canonical completeness findings (human-readable names). */
  remainingFindings: string[]
}

/**
 * Persist a canonical demand-following (As needed) ROLE profile for every
 * eligible missing role-only ResourceType while the project NEEDS_REPLAN.
 * Explicit user planning choice only; never overwrites existing profiles and
 * never transitions the project state — the existing Replan project
 * completion performs the canonical validation and state change.
 */
export const applyRoleCountsAsNeeded = (projectId: string): Promise<BulkAsNeededResult> =>
  api
    .post<BulkAsNeededResult>(`/projects/${projectId}/capacity-profiles/bulk-as-needed`)
    .then(r => r.data)
