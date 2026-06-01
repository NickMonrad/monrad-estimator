import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../lib/api'
import {
  clearAuthSession,
  getStoredUser,
  setAuthSession,
  subscribeToAuthSession,
  type AuthUser,
} from '../lib/authSession'

interface AuthContextType {
  user: AuthUser | null
  login: (email: string, password: string) => Promise<void>
  register: (email: string, name: string, password: string) => Promise<boolean>
  logout: () => void
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser())

  useEffect(() => subscribeToAuthSession(setUser), [])

  const login = async (email: string, password: string) => {
    const { data } = await api.post('/auth/login', { email, password })
    setAuthSession(data.token, data.user)
  }

  const register = async (email: string, name: string, password: string): Promise<boolean> => {
    const { data } = await api.post('/auth/register', { email, name, password })
    // Server returns no token for existing emails (enumeration prevention).
    // Only log the user in when a real token is returned (HTTP 201).
    if (data.token) {
      setAuthSession(data.token, data.user)
      return true  // navigable — user is now logged in
    }
    return false  // existing email — show generic success, don't navigate
  }

  const logout = () => {
    clearAuthSession()
  }

  return <AuthContext.Provider value={{ user, login, register, logout }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
