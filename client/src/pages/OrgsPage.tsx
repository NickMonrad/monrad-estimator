import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import AppLayout from '../components/layout/AppLayout'
import { getOrgs, createOrg, getOrgMembers, removeOrgMember, inviteToOrg, getOrgInvites, cancelOrgInvite, resendOrgInvite } from '../lib/api'

interface OrgMember {
  id: string
  userId: string
  role: 'OWNER' | 'ADMIN' | 'MEMBER'
  joinedAt: string
  user: { id: string; name: string; email: string }
}

interface PendingInvite {
  id: string
  email: string
  role: 'OWNER' | 'ADMIN' | 'MEMBER'
  expiresAt: string
  createdAt: string
}

interface Org {
  id: string
  name: string
  role: 'OWNER' | 'ADMIN' | 'MEMBER'
  _count: { members: number }
}

export default function OrgsPage() {
  const queryClient = useQueryClient()
  const [newOrgName, setNewOrgName] = useState('')
  const [expandedOrgId, setExpandedOrgId] = useState<string | null>(null)
  const [members, setMembers] = useState<Record<string, OrgMember[]>>({})
  const [invites, setInvites] = useState<Record<string, PendingInvite[]>>({})
  const [resendStatus, setResendStatus] = useState<Record<string, string>>({})
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'MEMBER' | 'ADMIN'>('MEMBER')
  const [inviteStatus, setInviteStatus] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  const { data: orgs = [], isLoading } = useQuery<Org[]>({
    queryKey: ['orgs'],
    queryFn: getOrgs,
  })

  const createOrgMutation = useMutation({
    mutationFn: (name: string) => createOrg({ name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orgs'] })
      setNewOrgName('')
    },
    onError: () => setError('Failed to create organisation'),
  })

  async function handleCreateOrg(e: React.FormEvent) {
    e.preventDefault()
    if (!newOrgName.trim()) return
    createOrgMutation.mutate(newOrgName.trim())
  }

  async function handleExpand(orgId: string) {
    if (expandedOrgId === orgId) { setExpandedOrgId(null); return }
    setExpandedOrgId(orgId)
    if (!members[orgId]) {
      const [membersData, invitesData] = await Promise.all([
        getOrgMembers(orgId),
        getOrgInvites(orgId),
      ])
      setMembers(prev => ({ ...prev, [orgId]: membersData }))
      setInvites(prev => ({ ...prev, [orgId]: invitesData }))
    }
  }

  async function handleRemoveMember(orgId: string, userId: string) {
    await removeOrgMember(orgId, userId)
    setMembers(prev => ({ ...prev, [orgId]: prev[orgId].filter(m => m.userId !== userId) }))
  }

  async function handleCancelInvite(orgId: string, inviteId: string) {
    await cancelOrgInvite(orgId, inviteId)
    setInvites(prev => ({ ...prev, [orgId]: prev[orgId].filter(i => i.id !== inviteId) }))
  }

  async function handleResendInvite(orgId: string, inviteId: string) {
    await resendOrgInvite(orgId, inviteId)
    setResendStatus(prev => ({ ...prev, [inviteId]: 'Sent!' }))
    setTimeout(() => setResendStatus(prev => { const n = { ...prev }; delete n[inviteId]; return n }), 3000)
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

  if (isLoading) return <div className="p-6">Loading...</div>

  return (
    <AppLayout>
      <main className="max-w-4xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Team</h1>

      {error && <div className="mb-4 p-3 bg-red-50 text-red-600 rounded">{error}</div>}

      <form onSubmit={handleCreateOrg} className="mb-8 flex gap-3">
        <input
          type="text"
          value={newOrgName}
          onChange={e => setNewOrgName(e.target.value)}
          placeholder="New organisation name"
          className="flex-1 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-600"
        />
        <button type="submit" className="bg-red-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-red-700">
          Create Organisation
        </button>
      </form>

      {orgs.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400">No organisations yet. Create one above.</p>
      ) : (
        <div className="space-y-3">
          {orgs.map(org => (
            <div key={org.id} className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              <button
                onClick={() => handleExpand(org.id)}
                className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                <div>
                  <span className="font-medium text-gray-900 dark:text-white">{org.name}</span>
                  <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">{org._count.members} member{org._count.members !== 1 ? 's' : ''}</span>
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">{org.role}</span>
                </div>
                <span className="text-gray-400 dark:text-gray-500">{expandedOrgId === org.id ? '▲' : '▼'}</span>
              </button>

              {expandedOrgId === org.id && (
                <div className="border-t border-gray-200 dark:border-gray-700 p-4 bg-gray-50 dark:bg-gray-700">
                  {/* Members list */}
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Members</h3>
                  <div className="space-y-2 mb-4">
                    {(members[org.id] ?? []).map(member => (
                      <div key={member.id} className="flex items-center justify-between bg-white dark:bg-gray-800 rounded px-3 py-2 border border-gray-200 dark:border-gray-700">
                        <div>
                          <span className="text-sm font-medium text-gray-900 dark:text-white">{member.user.name}</span>
                          <span className="text-sm text-gray-500 dark:text-gray-400 ml-2">{member.user.email}</span>
                          <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-600 text-gray-700 dark:text-gray-300">{member.role}</span>
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

                  {/* Pending Invites */}
                  {['OWNER', 'ADMIN'].includes(org.role) && (invites[org.id] ?? []).length > 0 && (
                    <div className="mb-4">
                      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Pending Invites</h3>
                      <div className="space-y-2">
                        {(invites[org.id] ?? []).map(invite => (
                          <div key={invite.id} className="flex items-center justify-between bg-white dark:bg-gray-800 rounded px-3 py-2 border border-gray-200 dark:border-gray-700">
                            <div>
                              <span className="text-sm font-medium text-gray-900 dark:text-white">{invite.email}</span>
                              <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-700">{invite.role}</span>
                              <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">expires {new Date(invite.expiresAt).toLocaleDateString()}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {resendStatus[invite.id] ? (
                                <span className="text-xs text-green-600">{resendStatus[invite.id]}</span>
                              ) : (
                                <button
                                  onClick={() => handleResendInvite(org.id, invite.id)}
                                  className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                                >
                                  Resend
                                </button>
                              )}
                              <button
                                onClick={() => handleCancelInvite(org.id, invite.id)}
                                className="text-sm text-red-600 hover:text-red-800"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Invite form */}
                  {['OWNER', 'ADMIN'].includes(org.role) && (
                    <div>
                      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Invite Member</h3>
                      <form onSubmit={e => handleInvite(e, org.id)} className="flex gap-2">
                        <input
                          type="email"
                          value={inviteEmail}
                          onChange={e => setInviteEmail(e.target.value)}
                          placeholder="Email address"
                          className="flex-1 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-600"
                        />
                        <select
                          value={inviteRole}
                          onChange={e => setInviteRole(e.target.value as 'MEMBER' | 'ADMIN')}
                          className="border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
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
  </AppLayout>
  )
}