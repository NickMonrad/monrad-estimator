import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const mockAdminUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  name: 'Admin User',
  password: 'hashed-password',
  role: 'ADMIN' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const mockExistingUser = {
  id: 'user-1',
  email: 'existing@example.com',
  name: 'Regular User',
  password: 'hashed-password',
  role: 'USER' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const validBootstrapPayload = {
  name: 'Admin User',
  email: 'admin@example.com',
  password: 'securePassword123!',
}

const validBootstrapToken = 'test-bootstrap-token'

// Controlled mock transaction client — each test can configure the user
// mocks and verify lock acquisition independently of the setup.ts default.
const mockQueryRawUnsafe = vi.fn()
const mockTxUserCount = vi.fn()
const mockTxUserFindUnique = vi.fn()
const mockTxUserCreate = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('ADMIN_BOOTSTRAP_TOKEN', '')
  vi.stubEnv('NODE_ENV', 'test')
  // Default: no admin exists, email not taken
  mockQueryRawUnsafe.mockResolvedValue([{ pg_advisory_xact_lock: null }])
  mockTxUserCount.mockResolvedValue(0)
  mockTxUserFindUnique.mockResolvedValue(null)
  mockTxUserCreate.mockResolvedValue(mockAdminUser)

  // Override $transaction to provide a controlled mock tx with user methods
  vi.mocked(prisma.$transaction).mockImplementation((fn: unknown) => {
    if (typeof fn !== 'function') return Promise.resolve(fn)
    const tx = {
      $queryRawUnsafe: mockQueryRawUnsafe,
      user: {
        count: mockTxUserCount,
        findUnique: mockTxUserFindUnique,
        create: mockTxUserCreate,
      },
    }
    return fn(tx)
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/bootstrap/admin', () => {
  it('rejects non-local bootstrap when ADMIN_BOOTSTRAP_TOKEN is not configured', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ADMIN_BOOTSTRAP_TOKEN', '')

    const res = await request(app)
      .post('/api/bootstrap/admin')
      .send(validBootstrapPayload)

    expect(res.status).toBe(403)
    expect(res.body.error).toContain('ADMIN_BOOTSTRAP_TOKEN')
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled()
  })

  it('rejects a configured bootstrap token when the request header is missing', async () => {
    vi.stubEnv('ADMIN_BOOTSTRAP_TOKEN', validBootstrapToken)

    const res = await request(app)
      .post('/api/bootstrap/admin')
      .send(validBootstrapPayload)

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Bootstrap token is required')
    expect(res.body.error).not.toContain(validBootstrapToken)
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled()
  })

  it('rejects an empty configured bootstrap token header', async () => {
    vi.stubEnv('ADMIN_BOOTSTRAP_TOKEN', validBootstrapToken)

    const res = await request(app)
      .post('/api/bootstrap/admin')
      .set('X-Bootstrap-Token', '')
      .send(validBootstrapPayload)

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Bootstrap token is required')
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled()
  })

  it('rejects the wrong configured bootstrap token', async () => {
    const wrongToken = 'nope-bootstrap-token'
    vi.stubEnv('ADMIN_BOOTSTRAP_TOKEN', validBootstrapToken)

    const res = await request(app)
      .post('/api/bootstrap/admin')
      .set('X-Bootstrap-Token', wrongToken)
      .send(validBootstrapPayload)

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid bootstrap token')
    expect(res.body.error).not.toContain(validBootstrapToken)
    expect(res.body.error).not.toContain(wrongToken)
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled()
  })

  it('creates the first admin when the configured bootstrap token matches', async () => {
    vi.stubEnv('ADMIN_BOOTSTRAP_TOKEN', validBootstrapToken)

    const res = await request(app)
      .post('/api/bootstrap/admin')
      .set('X-Bootstrap-Token', validBootstrapToken)
      .send(validBootstrapPayload)

    expect(res.status).toBe(201)
    expect(res.body.user).toMatchObject({
      email: 'admin@example.com',
      name: 'Admin User',
      role: 'ADMIN',
    })
  })

  it('creates the first admin on a fresh DB (201)', async () => {
    const res = await request(app)
      .post('/api/bootstrap/admin')
      .send({ name: 'Admin User', email: 'admin@example.com', password: 'securePassword123!' })

    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty('token')
    expect(res.body).toHaveProperty('user')
    expect(res.body.user).toMatchObject({
      email: 'admin@example.com',
      name: 'Admin User',
      role: 'ADMIN',
    })
  })

  it('stores the user with role ADMIN', async () => {
    await request(app)
      .post('/api/bootstrap/admin')
      .send({ name: 'Admin User', email: 'admin@example.com', password: 'securePassword123!' })

    expect(mockTxUserCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: 'ADMIN' }),
    })
  })

  it('acquires the PostgreSQL advisory lock inside the transaction', async () => {
    await request(app)
      .post('/api/bootstrap/admin')
      .send({ name: 'Admin User', email: 'admin@example.com', password: 'securePassword123!' })

    // The lock SQL must be the first operation inside the transaction
    expect(mockQueryRawUnsafe).toHaveBeenCalled()
    const lockCall = mockQueryRawUnsafe.mock.calls[0]
    expect(lockCall[0]).toContain('pg_advisory_xact_lock')
  })

  it('runs all user queries on the transaction client (not directly on prisma)', async () => {
    await request(app)
      .post('/api/bootstrap/admin')
      .send({ name: 'Admin User', email: 'admin@example.com', password: 'securePassword123!' })

    // Route must use tx.user not prisma.user for all DB operations
    expect(prisma.user.count).not.toHaveBeenCalled()
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
    expect(prisma.user.create).not.toHaveBeenCalled()
    // All calls go through the transaction client
    expect(mockTxUserCount).toHaveBeenCalled()
    expect(mockTxUserFindUnique).toHaveBeenCalled()
    expect(mockTxUserCreate).toHaveBeenCalled()
  })

  it('returns 409 when an admin already exists with a correct bootstrap token', async () => {
    vi.stubEnv('ADMIN_BOOTSTRAP_TOKEN', validBootstrapToken)
    mockTxUserCount.mockResolvedValue(1)

    const res = await request(app)
      .post('/api/bootstrap/admin')
      .set('X-Bootstrap-Token', validBootstrapToken)
      .send(validBootstrapPayload)
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('admin already exists')
    // Must not attempt to create a user when admin exists
    expect(mockTxUserCreate).not.toHaveBeenCalled()
  })

  it('returns 409 when the email is already taken by a regular user with a correct bootstrap token', async () => {
    vi.stubEnv('ADMIN_BOOTSTRAP_TOKEN', validBootstrapToken)
    mockTxUserFindUnique.mockResolvedValue(mockExistingUser)

    const res = await request(app)
      .post('/api/bootstrap/admin')
      .set('X-Bootstrap-Token', validBootstrapToken)
      .send({ ...validBootstrapPayload, email: 'existing@example.com' })
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('already exists')
    expect(mockTxUserCreate).not.toHaveBeenCalled()
  })

  it('prevents concurrent bootstrap attempts with a correct bootstrap token from creating multiple admins', async () => {
    // Simulate PostgreSQL advisory lock serialisation by making the mock
    // $transaction queue concurrent callers until the active one finishes.
    let transactionInProgress = false
    const waitQueue: Array<() => void> = []
    vi.stubEnv('ADMIN_BOOTSTRAP_TOKEN', validBootstrapToken)

    vi.mocked(prisma.$transaction).mockImplementation(async (fn: unknown) => {
      if (typeof fn !== 'function') return Promise.resolve(fn)

      if (transactionInProgress) {
        await new Promise<void>((resolve) => waitQueue.push(resolve))
      }

      transactionInProgress = true
      try {
        const tx = {
          $queryRawUnsafe: mockQueryRawUnsafe,
          user: {
            count: mockTxUserCount,
            findUnique: mockTxUserFindUnique,
            create: mockTxUserCreate,
          },
        }
        return await fn(tx)
      } finally {
        transactionInProgress = false
        const next = waitQueue.shift()
        if (next) next()
      }
    })

    // First request to create sets a flag; second sees existing admin
    let adminCreated = false
    mockTxUserCount.mockImplementation(() => Promise.resolve(adminCreated ? 1 : 0))
    mockTxUserCreate.mockImplementation(() => {
      adminCreated = true
      return Promise.resolve(mockAdminUser)
    })

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/bootstrap/admin')
        .set('X-Bootstrap-Token', validBootstrapToken)
        .send({ name: 'Admin Alpha', email: 'alpha@example.com', password: 'securePassword123!' }),
      request(app)
        .post('/api/bootstrap/admin')
        .set('X-Bootstrap-Token', validBootstrapToken)
        .send({ name: 'Admin Beta', email: 'beta@example.com', password: 'securePassword123!' }),
    ])

    // Exactly one must succeed, the other must be rejected
    const statuses = [res1.status, res2.status].sort()
    expect(statuses).toEqual([201, 409])
    // Exactly one create call must have happened
    expect(mockTxUserCreate).toHaveBeenCalledTimes(1)
  })

  it('returns 400 when password is too short', async () => {
    const res = await request(app)
      .post('/api/bootstrap/admin')
      .send({ name: 'Admin User', email: 'admin@example.com', password: '123' })

    expect(res.status).toBe(400)
    // Validation happens before the transaction — no lock or DB calls
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled()
  })

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/bootstrap/admin')
      .send({ email: 'admin@example.com', password: 'securePassword123!' })

    expect(res.status).toBe(400)
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled()
  })

  it('returns 400 when email is invalid', async () => {
    const res = await request(app)
      .post('/api/bootstrap/admin')
      .send({ name: 'Admin User', email: 'not-an-email', password: 'securePassword123!' })

    expect(res.status).toBe(400)
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled()
  })
})

describe('POST /api/auth/register', () => {
  it('creates normal registered users as USER accounts', async () => {
    const registeredUser = {
      ...mockExistingUser,
      id: 'user-2',
      email: 'new-user@example.com',
      name: 'Registered User',
      role: 'USER' as const,
    }

    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.user.create).mockResolvedValue(registeredUser as never)

    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Registered User', email: 'new-user@example.com', password: 'securePassword123!' })

    expect(res.status).toBe(201)
    expect(res.body.user).toMatchObject({
      email: 'new-user@example.com',
      name: 'Registered User',
      role: 'USER',
    })
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'new-user@example.com',
        name: 'Registered User',
      }),
    })

    const createData = (vi.mocked(prisma.user.create).mock.calls[0][0] as { data: Record<string, unknown> }).data
    expect(createData.role).toBeUndefined()
  })
})
