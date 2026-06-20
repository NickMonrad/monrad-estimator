import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { asyncHandler } from '../lib/asyncHandler.js'
import { prisma } from '../lib/prisma.js'
import { bootstrapSchema, validate } from '../lib/validation.js'

const router = Router()

// Deterministic PostgreSQL advisory lock ID for bootstrap serialisation.
// This lock serialises concurrent bootstrap attempts so only one admin
// can ever be created, even under racy conditions.
const BOOTSTRAP_LOCK_ID = 900000001

type BootstrapResult =
  | { kind: 'conflict'; error: string }
  | { kind: 'success'; token: string; user: { id: string; email: string; name: string; role: string } }

const BOOTSTRAP_TOKEN_HEADER = 'x-bootstrap-token'

function isDevelopmentOrTestEnvironment() {
  const nodeEnv = process.env.NODE_ENV ?? 'development'
  return nodeEnv === 'development' || nodeEnv === 'test'
}

function bootstrapTokensMatch(requestToken: string, bootstrapToken: string) {
  const requestTokenBuffer = Buffer.from(requestToken)
  const bootstrapTokenBuffer = Buffer.from(bootstrapToken)

  return requestTokenBuffer.length === bootstrapTokenBuffer.length
    && crypto.timingSafeEqual(requestTokenBuffer, bootstrapTokenBuffer)
}

/**
 * POST /api/bootstrap/admin
 *
 * Creates the first global admin user. Staging/production requests must include
 * X-Bootstrap-Token matching ADMIN_BOOTSTRAP_TOKEN. Local development/test may
 * omit the token only when ADMIN_BOOTSTRAP_TOKEN is unset.
 *
 * Only available when no ADMIN role user exists in the database. Returns 409
 * once an admin has been created.
 *
 * Concurrency safety: after the token gate passes, the entire bootstrap
 * check+create runs inside a Prisma $transaction with a PostgreSQL advisory
 * transaction lock (pg_advisory_xact_lock). This serialises concurrent
 * bootstrap attempts so only one admin can ever be created — concurrent
 * requests observe either the old state (no admin → create) or the new state
 * (admin exists → 409), never a stale snapshot of zero admins.
 *
 * Header: X-Bootstrap-Token
 * Body: { name, email, password }
 * Success (201): { token, user: { id, email, name, role: "ADMIN" } }
 * Forbidden (403): { error: "..." }
 * Conflict (409): { error: "..." }
 */
router.post(
  '/admin',
  validate(bootstrapSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { name, email, password } = req.body
    const bootstrapToken = process.env.ADMIN_BOOTSTRAP_TOKEN

    if (bootstrapToken) {
      const requestToken = req.headers[BOOTSTRAP_TOKEN_HEADER]

      if (typeof requestToken !== 'string' || requestToken.length === 0) {
        res.status(403).json({ error: 'Bootstrap token is required' })
        return
      }

      if (!bootstrapTokensMatch(requestToken, bootstrapToken)) {
        res.status(403).json({ error: 'Invalid bootstrap token' })
        return
      }
    } else if (!isDevelopmentOrTestEnvironment()) {
      res.status(403).json({
        error: 'Bootstrap is disabled. Set ADMIN_BOOTSTRAP_TOKEN to enable bootstrap in production.',
      })
      return
    }

    const result = await prisma.$transaction<BootstrapResult>(async (tx) => {
      // Acquire PostgreSQL advisory transaction lock to serialise bootstrap
      // attempts. Only one request at a time can proceed past this point;
      // concurrent attempts queue behind the lock.
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock($1)', BOOTSTRAP_LOCK_ID)

      // Check if any admin already exists — inside the lock, so this is
      // safe from race conditions.
      const adminCount = await tx.user.count({ where: { role: 'ADMIN' } })
      if (adminCount > 0) {
        return { kind: 'conflict', error: 'A global admin already exists. Bootstrap is disabled.' }
      }

      // Check email uniqueness before creating
      const existingUser = await tx.user.findUnique({ where: { email } })
      if (existingUser) {
        return { kind: 'conflict', error: 'A user with this email already exists. Use a different email for the admin account.' }
      }

      // Create the admin user
      const hashed = await bcrypt.hash(password, 10)
      const user = await tx.user.create({
        data: { email, name, password: hashed, role: 'ADMIN' },
      })

      const token = jwt.sign(
        { userId: user.id, role: user.role },
        process.env.JWT_SECRET!,
        { expiresIn: '7d' },
      )

      return { kind: 'success', token, user }
    })

    if (result.kind === 'conflict') {
      res.status(409).json({ error: result.error })
      return
    }

    res.status(201).json({
      token: result.token,
      user: { id: result.user.id, email: result.user.email, name: result.user.name, role: result.user.role },
    })
  }),
)

export default router
