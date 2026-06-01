import React from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, beforeEach } from 'vitest'
import { AuthProvider, useAuth } from '@/hooks/useAuth'
import { clearAuthSession, getStoredUser, setAuthSession } from '@/lib/authSession'

function AuthState() {
  const { user } = useAuth()

  return <div>{user ? user.email : 'logged-out'}</div>
}

describe('auth session', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('stores and clears token and user together', () => {
    const user = { id: 'user-1', email: 'alex@example.com', name: 'Alex' }

    setAuthSession('token-123', user)

    expect(localStorage.getItem('token')).toBe('token-123')
    expect(localStorage.getItem('user')).toBe(JSON.stringify(user))
    expect(getStoredUser()).toEqual(user)

    act(() => {
      clearAuthSession()
    })

    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('user')).toBeNull()
    expect(getStoredUser()).toBeNull()
  })

  it('updates AuthProvider immediately when the session is cleared externally', async () => {
    setAuthSession('token-123', { id: 'user-1', email: 'alex@example.com', name: 'Alex' })

    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(screen.getByText('alex@example.com')).toBeInTheDocument()

    act(() => {
      clearAuthSession()
    })

    await waitFor(() => {
      expect(screen.getByText('logged-out')).toBeInTheDocument()
    })
  })

  it('clears an invalid stored session payload', () => {
    localStorage.setItem('token', 'token-123')
    localStorage.setItem('user', '{bad json')

    expect(getStoredUser()).toBeNull()
    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('user')).toBeNull()
  })
})
