import React, { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth } from './hooks/useAuth'
import { useTheme } from './hooks/useTheme'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'))
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'))
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'))
const ProjectDetailPage = lazy(() => import('./pages/ProjectDetailPage'))
const BacklogPage = lazy(() => import('./pages/BacklogPage'))
const TemplateLibraryPage = lazy(() => import('./pages/TemplateLibraryPage'))
const ProjectSettingsPage = lazy(() => import('./pages/ProjectSettingsPage'))
const EffortReviewPage = lazy(() => import('./pages/EffortReviewPage'))
const GlobalResourceTypesPage = lazy(() => import('./pages/GlobalResourceTypesPage'))
const RateCardsPage = lazy(() => import('./pages/RateCardsPage'))
const TimelinePage = lazy(() => import('./pages/TimelinePage'))
const ResourceProfilePage = lazy(() => import('./pages/ResourceProfilePage'))
const ProjectResourceTypesPage = lazy(() => import('./pages/ProjectResourceTypesPage'))
const DocumentsPage = lazy(() => import('./pages/DocumentsPage'))
const OrgsPage = lazy(() => import('./pages/OrgsPage'))
const AcceptInvitePage = lazy(() => import('./pages/AcceptInvitePage'))
const CustomersPage = lazy(() => import('./pages/CustomersPage'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,  // 5 minutes
      refetchOnWindowFocus: false,
    },
  },
})

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  return user ? <>{children}</> : <Navigate to="/login" replace />
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  return user ? <Navigate to="/" replace /> : <>{children}</>
}

function AppRoutes() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen text-gray-500">Loading...</div>}>
      <Routes>
        <Route path="/login" element={<PublicRoute><LoginPage /></PublicRoute>} />
        <Route path="/register" element={<PublicRoute><RegisterPage /></PublicRoute>} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/" element={<PrivateRoute><ProjectsPage /></PrivateRoute>} />
        <Route path="/projects/:id" element={<PrivateRoute><ProjectDetailPage /></PrivateRoute>} />
        <Route path="/projects/:id/backlog" element={<PrivateRoute><BacklogPage /></PrivateRoute>} />
        <Route path="/projects/:id/effort" element={<PrivateRoute><EffortReviewPage /></PrivateRoute>} />
        <Route path="/projects/:id/timeline" element={<PrivateRoute><TimelinePage /></PrivateRoute>} />
        <Route path="/projects/:id/resource-profile" element={<PrivateRoute><ResourceProfilePage /></PrivateRoute>} />
        <Route path="/projects/:id/resource-types" element={<PrivateRoute><ProjectResourceTypesPage /></PrivateRoute>} />
        <Route path="/projects/:id/documents" element={<PrivateRoute><DocumentsPage /></PrivateRoute>} />
        <Route path="/projects/:id/settings" element={<PrivateRoute><ProjectSettingsPage /></PrivateRoute>} />
        <Route path="/templates" element={<PrivateRoute><TemplateLibraryPage /></PrivateRoute>} />
        <Route path="/resource-types" element={<PrivateRoute><GlobalResourceTypesPage /></PrivateRoute>} />
        <Route path="/rate-cards" element={<PrivateRoute><RateCardsPage /></PrivateRoute>} />
        <Route path="/orgs" element={<PrivateRoute><OrgsPage /></PrivateRoute>} />
        <Route path="/customers" element={<PrivateRoute><CustomersPage /></PrivateRoute>} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
      </Routes>
    </Suspense>
  )
}

export default function App() {
  useTheme()
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}
