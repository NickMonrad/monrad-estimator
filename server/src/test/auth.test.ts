import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import { loginLimiter } from '../routes/auth.js'

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
