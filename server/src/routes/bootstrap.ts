import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { asyncHandler } from '../lib/asyncHandler.js'
import { prisma } from '../lib/prisma.js'
import { bootstrapSchema, validate } from '../lib/validation.js'

const router = Router()

/**
 * POST /api/bootstrap/admin
 *
 * Creates the first global admin user. Only available when no ADMIN role
 * user exists in the database. Returns 409 once an admin has been created.
 *
 * This is the supported bootstrap path for:
 *   - Fresh deployments with an empty database
 *   - Existing databases that have regular (USER) accounts but no admin yet
 *
 * Body: { name, email, password }
 * Success (201): { token, user: { id, email, name, role: "ADMIN" } }
 * Conflict (409): { error: "A global admin already exists. Bootstrap is disabled." }
 */
router.post(
  '/admin',
  validate(bootstrapSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { name, email, password } = req.body

    // Check if any admin already exists — this is the primary gate.
    // Once set, bootstrap is permanently disabled for the lifetime of the database.
    const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } })
    if (adminCount > 0) {
      res.status(409).json({ error: 'A global admin already exists. Bootstrap is disabled.' })
      return
    }

    // Check email uniqueness before creating
    const existingUser = await prisma.user.findUnique({ where: { email } })
    if (existingUser) {
      res.status(409).json({ error: 'A user with this email already exists. Use a different email for the admin account.' })
      return
    }

    // Create the admin user
    const hashed = await bcrypt.hash(password, 10)
    const user = await prisma.user.create({
      data: { email, name, password: hashed, role: 'ADMIN' },
    })

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' },
    )

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    })
  }),
)

export default router
