import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth } from './hooks/useAuth'
import { useTheme } from './hooks/useTheme'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import ForgotPasswordPage from './pages/ForgotPasswordPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import ProjectsPage from './pages/ProjectsPage'
import ProjectDetailPage from './pages/ProjectDetailPage'
import BacklogPage from './pages/BacklogPage'
import TemplateLibraryPage from './pages/TemplateLibraryPage'
import ProjectSettingsPage from './pages/ProjectSettingsPage'
import EffortReviewPage from './pages/EffortReviewPage'
import GlobalResourceTypesPage from './pages/GlobalResourceTypesPage'
import RateCardsPage from './pages/RateCardsPage'
import TimelinePage from './pages/TimelinePage'
import ResourceProfilePage from './pages/ResourceProfilePage'
import ProjectResourceTypesPage from './pages/ProjectResourceTypesPage'
import DocumentsPage from './pages/DocumentsPage'

const queryClient = new QueryClient()

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
    </Routes>
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
