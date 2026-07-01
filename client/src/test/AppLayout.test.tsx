import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import AppLayout from '../components/layout/AppLayout'

// AppLayout uses useAuth() to show user name — mock it so the test doesn't need AuthProvider

// ThemeToggle accesses localStorage in a useState initializer — provide a mock
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    clear: () => { store = {} },
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock })
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { name: 'Test User', email: 'test@example.com' },
    logout: vi.fn(),
  }),
}))

describe('AppLayout', () => {
  it('renders a Guide link that opens the user guide in a new tab', () => {
    render(
      <MemoryRouter>
        <AppLayout>page content</AppLayout>
      </MemoryRouter>,
    )

    const link = screen.getByRole('link', { name: 'Guide' })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute('href', expect.stringContaining('docs/user-guide.md'))
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })
})
