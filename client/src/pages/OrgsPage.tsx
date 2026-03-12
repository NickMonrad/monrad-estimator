import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { getOrgs, createOrg, getOrgMembers, removeOrgMember, inviteToOrg } from '../lib/api'

interface OrgMember {
  id: string
  userId: string
  role: 'OWNER' | 'ADMIN' | 'MEMBER'
  joinedAt: string
  user: { id: string; name: string; email: string }
}

interface Org {
  id: string
  name: string
  role: 'OWNER' | 'ADMIN' | 'MEMBER'
  _count: { members: number }
}

export default function OrgsPage() {
  const { user, logout } = useAuth()
  const [orgs, setOrgs] = useState<Org[]>([])
  const [newOrgName, setNewOrgName] = useState('')
  const [expandedOrgId, setExpandedOrgId] = useState<string | null>(null)
  const [members, setMembers] = useState<Record<string, OrgMember[]>>({})
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'MEMBER' | 'ADMIN'>('MEMBER')
  const [inviteStatus, setInviteStatus] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    loadOrgs()
  }, [])

  async function loadOrgs() {
    try {
      const data = await getOrgs()
      setOrgs(data)
    } catch {
      setError('Failed to load organisations')
    } finally {
      setLoading(false)
    }
  }

  async function handleCreateOrg(e: React.FormEvent) {
    e.preventDefault()
    if (!newOrgName.trim()) return
    try {
      const org = await createOrg({ name: newOrgName.trim() })
      setOrgs(prev => [org, ...prev])
      setNewOrgName('')
    } catch {
      setError('Failed to create organisation')
    }
  }

  async function handleExpand(orgId: string) {
    if (expandedOrgId === orgId) { setExpandedOrgId(null); return }
    setExpandedOrgId(orgId)
    if (!members[orgId]) {
      const data = await getOrgMembers(orgId)
      setMembers(prev => ({ ...prev, [orgId]: data }))
    }
  }

  async function handleRemoveMember(orgId: string, userId: string) {
    await removeOrgMember(orgId, userId)
    setMembers(prev => ({ ...prev, [orgId]: prev[orgId].filter(m => m.userId !== userId) }))
  }

  async function handleInvite(e: React.FormEvent, orgId: string) {
    e.preventDefault()
    try {
      await inviteToOrg(orgId, { email: inviteEmail, role: inviteRole })
      setInviteStatus(prev => ({ ...prev, [orgId]: `Invite sent to ${inviteEmail}` }))
      setInviteEmail('')
    } catch {
      setInviteStatus(prev => ({ ...prev, [orgId]: 'Failed to send invite' }))
    }
  }

  if (loading) return <div className="p-6">Loading...</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-red-600 rounded-lg flex items-center justify-center">
              <span className="text-white text-xs font-bold">M</span>
            </div>
            <Link to="/" className="font-semibold text-gray-900">Monrad Estimator</Link>
            <Link to="/resource-types" className="text-sm text-gray-500 hover:text-red-600 transition-colors ml-2">Resource Types</Link>
            <Link to="/templates" className="text-sm text-gray-500 hover:text-red-600 transition-colors ml-2">Templates</Link>
            <Link to="/rate-cards" className="text-sm text-gray-500 hover:text-red-600 transition-colors ml-2">Rate Cards</Link>
            <Link to="/orgs" className="text-sm text-gray-500 hover:text-red-600 transition-colors ml-2">Team</Link>
            <Link to="/customers" className="text-sm text-gray-500 hover:text-red-600 transition-colors ml-2">Customers</Link>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{user?.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 hover:text-gray-700">Sign out</button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Team</h1>

      {error && <div className="mb-4 p-3 bg-red-50 text-red-600 rounded">{error}</div>}

      <form onSubmit={handleCreateOrg} className="mb-8 flex gap-3">
        <input
          type="text"
          value={newOrgName}
          onChange={e => setNewOrgName(e.target.value)}
          placeholder="New organisation name"
          className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-600"
        />
        <button type="submit" className="bg-red-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-red-700">
          Create Organisation
        </button>
      </form>

      {orgs.length === 0 ? (
        <p className="text-gray-500">No organisations yet. Create one above.</p>
      ) : (
        <div className="space-y-3">
          {orgs.map(org => (
            <div key={org.id} className="border border-gray-200 rounded-lg overflow-hidden">
              <button
                onClick={() => handleExpand(org.id)}
                className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-50"
              >
                <div>
                  <span className="font-medium text-gray-900">{org.name}</span>
                  <span className="ml-2 text-sm text-gray-500">{org._count.members} member{org._count.members !== 1 ? 's' : ''}</span>
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">{org.role}</span>
                </div>
                <span className="text-gray-400">{expandedOrgId === org.id ? '▲' : '▼'}</span>
              </button>

              {expandedOrgId === org.id && (
                <div className="border-t border-gray-200 p-4 bg-gray-50">
                  {/* Members list */}
                  <h3 className="text-sm font-medium text-gray-700 mb-3">Members</h3>
                  <div className="space-y-2 mb-4">
                    {(members[org.id] ?? []).map(member => (
                      <div key={member.id} className="flex items-center justify-between bg-white rounded px-3 py-2 border border-gray-200">
                        <div>
                          <span className="text-sm font-medium text-gray-900">{member.user.name}</span>
                          <span className="text-sm text-gray-500 ml-2">{member.user.email}</span>
                          <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">{member.role}</span>
                        </div>
                        {['OWNER', 'ADMIN'].includes(org.role) && (
                          <button
                            onClick={() => handleRemoveMember(org.id, member.userId)}
                            className="text-red-600 text-sm hover:text-red-800"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Invite form */}
                  {['OWNER', 'ADMIN'].includes(org.role) && (
                    <div>
                      <h3 className="text-sm font-medium text-gray-700 mb-2">Invite Member</h3>
                      <form onSubmit={e => handleInvite(e, org.id)} className="flex gap-2">
                        <input
                          type="email"
                          value={inviteEmail}
                          onChange={e => setInviteEmail(e.target.value)}
                          placeholder="Email address"
                          className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-600"
                        />
                        <select
                          value={inviteRole}
                          onChange={e => setInviteRole(e.target.value as 'MEMBER' | 'ADMIN')}
                          className="border border-gray-300 rounded px-3 py-2 text-sm"
                        >
                          <option value="MEMBER">Member</option>
                          <option value="ADMIN">Admin</option>
                        </select>
                        <button type="submit" className="bg-red-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-red-700">
                          Invite
                        </button>
                      </form>
                      {inviteStatus[org.id] && (
                        <p className="text-sm mt-2 text-green-600">{inviteStatus[org.id]}</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      </main>
    </div>
  )
}