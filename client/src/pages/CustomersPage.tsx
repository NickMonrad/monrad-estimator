import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import AppLayout from '../components/layout/AppLayout'
import { getCustomers, createCustomer, updateCustomer, deleteCustomer, getOrgs } from '../lib/api'

interface Customer {
  id: string
  name: string
  description?: string
  accountCode?: string
  crmLink?: string
  orgId?: string
  org?: { id: string; name: string }
}

interface Org {
  id: string
  name: string
}

interface CustomerForm {
  name: string
  description: string
  accountCode: string
  crmLink: string
  orgId: string
}

const emptyForm: CustomerForm = { name: '', description: '', accountCode: '', crmLink: '', orgId: '' }

export default function CustomersPage() {
  const queryClient = useQueryClient()
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState<CustomerForm>(emptyForm)

  const { data: customers = [], isLoading } = useQuery<Customer[]>({
    queryKey: ['customers'],
    queryFn: getCustomers,
  })

  const { data: orgs = [] } = useQuery<Org[]>({
    queryKey: ['orgs'],
    queryFn: getOrgs,
  })

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (editId) return updateCustomer(editId, form)
      return createCustomer(form)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] })
      setShowForm(false)
      setEditId(null)
      setForm(emptyForm)
    },
    onError: () => setError('Failed to save customer'),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteCustomer,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['customers'] }),
    onError: () => setError('Failed to delete customer'),
  })

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    saveMutation.mutate()
  }

  function handleDelete(id: string) {
    if (!confirm('Delete this customer?')) return
    deleteMutation.mutate(id)
  }

  function handleEdit(customer: Customer) {
    setEditId(customer.id)
    setForm({ name: customer.name, description: customer.description ?? '', accountCode: customer.accountCode ?? '', crmLink: customer.crmLink ?? '', orgId: customer.orgId ?? '' })
    setShowForm(true)
  }

  if (isLoading) return <div className="p-6">Loading...</div>

  return (
    <AppLayout>
      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Customers</h1>
          <button
            onClick={() => { setShowForm(true); setEditId(null); setForm(emptyForm) }}
            className="bg-red-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-red-700"
          >
            + New Customer
          </button>
        </div>

      {error && <div className="mb-4 p-3 bg-red-50 text-red-600 rounded">{error}</div>}

      {showForm && (
        <div className="mb-6 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
          <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-4">{editId ? 'Edit Customer' : 'New Customer'}</h2>
          <form onSubmit={handleSave} className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name *</label>
              <input
                type="text"
                value={form.name}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                required
                className="w-full border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
              <input
                type="text"
                value={form.description}
                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                className="w-full border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Account Code</label>
                <input
                  type="text"
                  value={form.accountCode}
                  onChange={e => setForm(p => ({ ...p, accountCode: e.target.value }))}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-600"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">CRM Link</label>
                <input
                  type="url"
                  value={form.crmLink}
                  onChange={e => setForm(p => ({ ...p, crmLink: e.target.value }))}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-600"
                />
              </div>
            </div>
            {orgs.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Team (Organisation)</label>
                <select
                  value={form.orgId}
                  onChange={e => setForm(p => ({ ...p, orgId: e.target.value }))}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-600"
                >
                  <option value="">No team</option>
                  {orgs.map(o => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Changing the team will also move all unassigned projects for this customer.</p>
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <button type="submit" className="bg-red-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-red-700">
                {editId ? 'Update' : 'Create'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setEditId(null) }} className="text-gray-600 dark:text-gray-400 text-sm hover:text-gray-800 dark:hover:text-gray-200">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {customers.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400">No customers yet.</p>
      ) : (
        <div className="space-y-2">
          {customers.map(customer => (
            <div key={customer.id} className="flex items-center justify-between bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-900 dark:text-white">{customer.name}</span>
                  {customer.accountCode && <span className="text-xs text-gray-500 dark:text-gray-400">({customer.accountCode})</span>}
                  {customer.org && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                      {customer.org.name}
                    </span>
                  )}
                </div>
                {customer.description && <p className="text-sm text-gray-500 dark:text-gray-400 truncate">{customer.description}</p>}
                {customer.crmLink && (
                  <a href={customer.crmLink} target="_blank" rel="noopener noreferrer" className="text-xs text-red-600 hover:underline">
                    CRM →
                  </a>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={() => handleEdit(customer)} className="text-xs px-3 py-1 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 font-medium transition-colors">Edit</button>
                <button onClick={() => handleDelete(customer.id)} className="text-xs px-3 py-1 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 font-medium transition-colors">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
      </main>

  </AppLayout>
  )
}