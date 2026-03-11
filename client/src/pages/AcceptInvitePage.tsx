import { useEffect, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { acceptOrgInvite } from '../lib/api'

export default function AcceptInvitePage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get('token')
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!token) {
      setStatus('error')
      setMessage('Invalid invite link.')
      return
    }

    const storedToken = localStorage.getItem('token')
    if (!storedToken) {
      // Not logged in — redirect to login with return URL
      navigate(`/login?redirect=/accept-invite?token=${encodeURIComponent(token)}`)
      return
    }

    acceptOrgInvite(token)
      .then((data: { orgId: string }) => {
        setStatus('success')
        setMessage('You have joined the organisation!')
        setTimeout(() => navigate('/orgs'), 2000)
      })
      .catch(() => {
        setStatus('error')
        setMessage('Failed to accept invite. It may have expired or already been used.')
      })
  }, [token, navigate])

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white rounded-lg shadow p-8 max-w-md w-full text-center">
        {status === 'loading' && <p className="text-gray-600">Processing invite...</p>}
        {status === 'success' && (
          <div>
            <div className="text-green-600 text-4xl mb-4">✓</div>
            <p className="text-gray-900 font-medium">{message}</p>
            <p className="text-gray-500 text-sm mt-2">Redirecting to your organisations...</p>
          </div>
        )}
        {status === 'error' && (
          <div>
            <div className="text-red-600 text-4xl mb-4">✗</div>
            <p className="text-gray-900 font-medium">{message}</p>
            <button onClick={() => navigate('/')} className="mt-4 text-red-600 hover:text-red-800 text-sm">
              Go to home
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
