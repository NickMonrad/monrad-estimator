import { useNavigate } from 'react-router-dom'
import AppLayout from '../components/layout/AppLayout'
import { useResourceProfile, formatNumber } from '../hooks/useResourceProfile'
import ResourceProfileTab from '../components/resource-profile/ResourceProfileTab'
import CommercialTab from '../components/resource-profile/CommercialTab'

export default function ResourceProfilePage() {
  const state = useResourceProfile()
  const {
    projectId, project, profile,
    activeTab, setActiveTab,
    handleExportProfile, handleExportFull,
  } = state
  const navigate = useNavigate()

  if (!projectId) return null

  return (
    <AppLayout
      breadcrumb={
        <>
          <span>/</span>
          <button onClick={() => navigate(`/projects/${projectId}`)} className="hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors">
            {project?.name ?? '…'}
          </button>
          <span>/</span>
          <span className="text-gray-700 dark:text-gray-300">Resource Profile</span>
        </>
      }
    >
      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Resource Profile</h1>
            {profile && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Total {formatNumber(profile.summary.totalHours)}h · {formatNumber(profile.summary.totalDays)} days
                {profile.summary.totalCost != null && ` · $${formatNumber(profile.summary.totalCost, 0)}`}
              </p>
            )}
            {(project?.bufferWeeks ?? 0) > 0 && (
              <p className="text-xs text-amber-600 font-medium mt-1">
                + {project!.bufferWeeks} buffer week{project!.bufferWeeks !== 1 ? 's' : ''} applied
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleExportProfile}
              disabled={!profile}
              className="border border-gray-300 text-gray-700 dark:text-gray-300 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              ⬇ Export Resource Profile
            </button>
            <button
              onClick={handleExportFull}
              disabled={!profile}
              className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50"
            >
              ⬇ Export Full Project
            </button>
          </div>
        </div>

        {/* ── Tab bar ── */}
        <div className="border-b border-gray-200 dark:border-gray-700">
          <nav className="flex gap-6">
            <button
              onClick={() => setActiveTab('profile')}
              className={`pb-2 text-sm font-medium transition-colors ${
                activeTab === 'profile'
                  ? 'border-b-2 border-lab3-navy text-lab3-navy dark:border-lab3-blue dark:text-lab3-blue'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              Resource Profile
            </button>
            <button
              onClick={() => setActiveTab('commercial')}
              className={`pb-2 text-sm font-medium transition-colors ${
                activeTab === 'commercial'
                  ? 'border-b-2 border-lab3-navy text-lab3-navy dark:border-lab3-blue dark:text-lab3-blue'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              Commercial
            </button>
          </nav>
        </div>

        {activeTab === 'profile' && <ResourceProfileTab {...state} projectId={projectId} />}
        {activeTab === 'commercial' && <CommercialTab {...state} projectId={projectId} />}
      </main>
    </AppLayout>
  )
}
