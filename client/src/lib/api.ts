import axios from 'axios'

const baseURL = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api'

export const api = axios.create({ baseURL })

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const isAuthRoute = err.config?.url?.startsWith('/auth/')
    if (err.response?.status === 401 && !isAuthRoute) {
      localStorage.removeItem('token')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

// Orgs
export const getOrgs = () => api.get('/orgs').then(r => r.data)
export const createOrg = (data: { name: string }) => api.post('/orgs', data).then(r => r.data)
export const getOrgMembers = (orgId: string) => api.get(`/orgs/${orgId}/members`).then(r => r.data)
export const removeOrgMember = (orgId: string, userId: string) => api.delete(`/orgs/${orgId}/members/${userId}`).then(r => r.data)
export const updateOrgMemberRole = (orgId: string, userId: string, role: string) => api.put(`/orgs/${orgId}/members/${userId}`, { role }).then(r => r.data)
export const inviteToOrg = (orgId: string, data: { email: string; role?: string }) => api.post(`/orgs/${orgId}/invites`, data).then(r => r.data)
export const acceptOrgInvite = (token: string) => api.post('/orgs/accept-invite', { token }).then(r => r.data)
export const moveProjectToOrg = (projectId: string, orgId: string) => api.post(`/projects/${projectId}/move-to-org`, { orgId }).then(r => r.data)

// Customers
export const getCustomers = () => api.get('/customers').then(r => r.data)
export const createCustomer = (data: { name: string; description?: string; accountCode?: string; crmLink?: string; orgId?: string }) => api.post('/customers', data).then(r => r.data)
export const updateCustomer = (id: string, data: { name?: string; description?: string; accountCode?: string; crmLink?: string; orgId?: string }) => api.put(`/customers/${id}`, data).then(r => r.data)
export const deleteCustomer = (id: string) => api.delete(`/customers/${id}`).then(r => r.data)
