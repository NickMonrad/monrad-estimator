import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import ThemeToggle from './ThemeToggle'

interface AppLayoutProps {
  /** Project-specific breadcrumb JSX (e.g. " / Project Name / Backlog").
   *  When omitted, the global nav links (Resource Types, Templates, …) are shown instead. */
  breadcrumb?: ReactNode
  /** Override the logo button click handler (e.g. for the Geocities easter egg on ProjectsPage). */
  onLogoClick?: () => void
  children: ReactNode
}

/**
 * Shared authenticated page shell: header (logo + nav/breadcrumb + user controls) + page body.
 *
 * Usage — global page (shows nav links):
 *   <AppLayout>{children}</AppLayout>
 *
 * Usage — project page (shows breadcrumb):
 *   <AppLayout breadcrumb={<>...</>}>{children}</AppLayout>
 */
export default function AppLayout({ breadcrumb, onLogoClick, children }: AppLayoutProps) {
  const navigate = useNavigate()
  const { user, logout } = useAuth()

  const handleLogoClick = onLogoClick ?? (() => navigate('/'))

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            {/* Logo */}
            <button
              onClick={handleLogoClick}
              className="flex items-center gap-2 group focus:outline-none"
              aria-label="Monrad Estimator home"
            >
              <div className="w-8 h-8 bg-lab3-navy rounded-lg flex items-center justify-center">
                <span className="text-white text-xs font-bold">M</span>
              </div>
              <span className="font-semibold text-gray-900 dark:text-white group-hover:text-lab3-navy dark:group-hover:text-lab3-blue transition-colors">
                Monrad Estimator
              </span>
            </button>

            {breadcrumb ?? (
              // Global nav links shown on top-level pages
              <>
                <Link
                  to="/resource-types"
                  className="text-sm text-gray-500 dark:text-gray-400 hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors ml-2"
                >
                  Resource Types
                </Link>
                <Link
                  to="/templates"
                  className="text-sm text-gray-500 dark:text-gray-400 hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors ml-2"
                >
                  Templates
                </Link>
                <Link
                  to="/rate-cards"
                  className="text-sm text-gray-500 dark:text-gray-400 hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors ml-2"
                >
                  Rate Cards
                </Link>
                <Link
                  to="/orgs"
                  className="text-sm text-gray-500 dark:text-gray-400 hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors ml-2"
                >
                  Team
                </Link>
                <Link
                  to="/customers"
                  className="text-sm text-gray-500 dark:text-gray-400 hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors ml-2"
                >
                  Customers
                </Link>
              </>
            )}
          </div>

          <div className="flex items-center gap-3">
            <ThemeToggle />
            <span className="text-sm text-gray-500 dark:text-gray-400">{user?.name}</span>
            <button
              onClick={logout}
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {children}
    </div>
  )
}
