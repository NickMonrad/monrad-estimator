import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import { loginLimiter, GET_LOGIN_LIMITER_KEY } from '../routes/auth.js'

const email = 'user@example.com'
const userId = 'user-1'
const resetToken = 'reset-token'
const originalNodeEnv = process.env.NODE_ENV
const loopbackKeys = ['::1', '::ffff:127.0.0.1', '127.0.0.1']

async function clearLoginLimiter() {
  await Promise.all(loopbackKeys.map(async (key) => {
    await Promise.resolve(loginLimiter.resetKey(key)).catch(() => undefined)
  }))
}

describe('auth password reset rate-limit regression', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.NODE_ENV = 'development'
    await clearLoginLimiter()

    let currentPasswordHash = await bcrypt.hash('OriginalPassword123!', 10)
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex')
    ;(prisma.passwordResetToken.findUnique as any).mockImplementation(async ({ where }: any) => {
      expect(where).toEqual({ tokenHash: resetTokenHash })

      return {
        userId,
        tokenHash: resetTokenHash,
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
      } as any
    })


    ;(prisma.user.findUnique as any).mockImplementation(async ({ where }: any) => {
      if (where.email !== email) return null

      return {
        id: userId,
        email,
        name: 'Test User',
        role: 'USER',
        password: currentPasswordHash,
      } as any
    })

    ;(prisma.passwordResetToken.update as any).mockImplementation(async ({ where }: any) => {
      expect(where).toEqual({ tokenHash: resetTokenHash })

      return {
        userId,
        tokenHash: resetTokenHash,
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: new Date(),
      } as any
    })

    ;(prisma.user.update as any).mockImplementation(async ({ where, data }: any) => {
      expect(where).toEqual({ id: userId })
      currentPasswordHash = data.password

      return {
        id: userId,
        email,
        name: 'Test User',
        role: 'USER',
        password: currentPasswordHash,
      } as any
    })

    ;(prisma.$transaction as any).mockImplementation(async (fn: any) =>
      fn({
        passwordResetToken: { update: prisma.passwordResetToken.update },
        user: { update: prisma.user.update },
      }),
    )
  })

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv
    await clearLoginLimiter()
  })

  it('allows immediate login after a successful password reset clears prior failed login attempts', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failedLogin = await request(app)
        .post('/api/auth/login')
        .send({ email, password: 'WrongPassword123!' })

      expect(failedLogin.status).toBe(401)
    }

    const resetResponse = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: resetToken, password: 'NewPassword123!' })

    expect(resetResponse.status).toBe(200)
    expect(resetResponse.body).toEqual({ message: 'Password reset successfully' })

    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'NewPassword123!' })

    expect(loginResponse.status).toBe(200)
    expect(loginResponse.body.user).toMatchObject({
      id: userId,
      email,
      name: 'Test User',
    })
    expect(loginResponse.body.token).toEqual(expect.any(String))
  })
})


describe('rate-limiter IPv6 /64 subnet key', () => {
  const mockReq = (ip: string) => ({ ip, socket: { remoteAddress: undefined } }) as any

  it('compressed IPv6 addresses in the same /64 map to the same bucket key', () => {
    const key1 = GET_LOGIN_LIMITER_KEY(mockReq('2001:db8::1'))
    const key2 = GET_LOGIN_LIMITER_KEY(mockReq('2001:db8::2'))
    expect(key1).toBe(key2)
    expect(key1).toContain('ipv6:/64:')
  })

  it('different IPv6 /64 subnets map to different bucket keys', () => {
    const key1 = GET_LOGIN_LIMITER_KEY(mockReq('2001:db8::1'))
    const key2 = GET_LOGIN_LIMITER_KEY(mockReq('2001:db9::1'))
    expect(key1).not.toBe(key2)
  })

  it('IPv4 addresses return the raw IP unchanged', () => {
    const key = GET_LOGIN_LIMITER_KEY(mockReq('203.0.113.42'))
    expect(key).toBe('203.0.113.42')
  })

  it('IPv4-mapped IPv6 addresses return the embedded IPv4', () => {
    const key = GET_LOGIN_LIMITER_KEY(mockReq('::ffff:203.0.113.42'))
    expect(key).toBe('203.0.113.42')
  })

  it('IPv6 loopback returns ::1', () => {
    const key = GET_LOGIN_LIMITER_KEY(mockReq('::1'))
    expect(key).toBe('::1')
  })
})