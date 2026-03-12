import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { getCustomers, createCustomer, updateCustomer, deleteCustomer } from '../lib/api'

interface Customer {
  id: string
  name: string
  description?: string
  accountCode?: string
  crmLink?: string
  orgId?: string
  org?: { id: string; name: string }
}

interface CustomerForm {
  name: string
  description: string
  accountCode: string
  crmLink: string
}

const emptyForm: CustomerForm = { name: '', description: '', accountCode: '', crmLink: '' }

export default function CustomersPage() {
  const { user, logout } = useAuth()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState<CustomerForm>(emptyForm)

  useEffect(() => { loadCustomers() }, [])

  async function loadCustomers() {
    try {
      const data = await getCustomers()
      setCustomers(data)
    } catch {
      setError('Failed to load customers')
    } finally {
      setLoading(false)
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    try {
      if (editId) {
        const updated = await updateCustomer(editId, form)
        setCustomers(prev => prev.map(c => c.id === editId ? updated : c))
      } else {
        const created = await createCustomer(form)
        setCustomers(prev => [created, ...prev])
      }
      setShowForm(false)
      setEditId(null)
      setForm(emptyForm)
    } catch {
      setError('Failed to save customer')
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this customer?')) return
    await deleteCustomer(id)
    setCustomers(prev => prev.filter(c => c.id !== id))
  }

  function handleEdit(customer: Customer) {
    setEditId(customer.id)
    setForm({ name: customer.name, description: customer.description ?? '', accountCode: customer.accountCode ?? '', crmLink: customer.crmLink ?? '' })
    setShowForm(true)
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
            <Link to="/projects" className="font-semibold text-gray-900">Monrad Estimator</Link>
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
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Customers</h1>
          <button
            onClick={() => { setShowForm(true); setEditId(null); setForm(emptyForm) }}
            className="bg-red-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-red-700"
          >
            + New Customer
          </button>
        </div>

      {error && <div className="mb-4 p-3 bg-red-50 text-red-600 rounded">{error}</div>}

      {showForm && (
        <div className="mb-6 bg-white border border-gray-200 rounded-lg p-4">
          <h2 className="text-lg font-medium text-gray-900 mb-4">{editId ? 'Edit Customer' : 'New Customer'}</h2>
          <form onSubmit={handleSave} className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
              <input
                type="text"
                value={form.name}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                required
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input
                type="text"
                value={form.description}
                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Account Code</label>
                <input
                  type="text"
                  value={form.accountCode}
                  onChange={e => setForm(p => ({ ...p, accountCode: e.target.value }))}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-600"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">CRM Link</label>
                <input
                  type="url"
                  value={form.crmLink}
                  onChange={e => setForm(p => ({ ...p, crmLink: e.target.value }))}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-600"
                />
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <button type="submit" className="bg-red-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-red-700">
                {editId ? 'Update' : 'Create'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setEditId(null) }} className="text-gray-600 text-sm hover:text-gray-800">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {customers.length === 0 ? (
        <p className="text-gray-500">No customers yet.</p>
      ) : (
        <div className="space-y-2">
          {customers.map(customer => (
            <div key={customer.id} className="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-4 py-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-900">{customer.name}</span>
                  {customer.accountCode && <span className="text-xs text-gray-500">({customer.accountCode})</span>}
                  {customer.org && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                      {customer.org.name}
                    </span>
                  )}
                </div>
                {customer.description && <p className="text-sm text-gray-500">{customer.description}</p>}
                {customer.crmLink && (
                  <a href={customer.crmLink} target="_blank" rel="noopener noreferrer" className="text-xs text-red-600 hover:underline">
                    CRM →
                  </a>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={() => handleEdit(customer)} className="text-gray-500 text-sm hover:text-gray-700">Edit</button>
                <button onClick={() => handleDelete(customer.id)} className="text-red-600 text-sm hover:text-red-800">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
      </main>
    </div>
  )
}