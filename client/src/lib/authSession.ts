export interface AuthUser {
  id: string
  email: string
  name: string
  role?: string
}

const TOKEN_STORAGE_KEY = 'token'
const USER_STORAGE_KEY = 'user'
const AUTH_SESSION_CHANGED_EVENT = 'auth:session-changed'

function dispatchAuthSessionChanged(user: AuthUser | null) {
  if (typeof window === 'undefined') return

  window.dispatchEvent(new CustomEvent<AuthSessionChangedDetail>(AUTH_SESSION_CHANGED_EVENT, {
    detail: { user },
  }))
}

export function getStoredToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY)
}

export function getStoredUser(): AuthUser | null {
  const storedUser = localStorage.getItem(USER_STORAGE_KEY)

  if (!storedUser) return null

  try {
    return JSON.parse(storedUser) as AuthUser
  } catch {
    clearAuthSession()
    return null
  }
}

export function setAuthSession(token: string, user: AuthUser) {
  localStorage.setItem(TOKEN_STORAGE_KEY, token)
  localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user))
  dispatchAuthSessionChanged(user)
}

export function clearAuthSession() {
  localStorage.removeItem(TOKEN_STORAGE_KEY)
  localStorage.removeItem(USER_STORAGE_KEY)
  dispatchAuthSessionChanged(null)
}

interface AuthSessionChangedDetail {
  user: AuthUser | null
}

export function subscribeToAuthSession(callback: (user: AuthUser | null) => void) {
  if (typeof window === 'undefined') return () => {}

  const handleSessionChanged = (event: Event) => {
    const detail = (event as CustomEvent<AuthSessionChangedDetail>).detail
    callback(detail?.user ?? getStoredUser())
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === TOKEN_STORAGE_KEY || event.key === USER_STORAGE_KEY) {
      callback(getStoredUser())
    }
  }

  window.addEventListener(AUTH_SESSION_CHANGED_EVENT, handleSessionChanged as EventListener)
  window.addEventListener('storage', handleStorage)

  return () => {
    window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, handleSessionChanged as EventListener)
    window.removeEventListener('storage', handleStorage)
  }
}
