import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import rateLimit from 'express-rate-limit'
import { prisma } from '../lib/prisma.js'
import { sendEmail } from '../lib/email.js'
import { logger } from '../lib/logger.js'
import {
  loginSchema,
  registerSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  validate,
} from '../lib/validation.js'

const router = Router()

// Skip rate limiting in test environments so Playwright/Vitest suites are not
// throttled by their own repeated auth calls from the same IP (127.0.0.1).
const skipInTest = () => process.env.NODE_ENV === 'test'

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skip: skipInTest,
  message: { error: 'Too many login attempts, please try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
})

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  skip: skipInTest,
  message: { error: 'Too many password reset requests, please try again in an hour' },
  standardHeaders: true,
  legacyHeaders: false,
})

router.post('/register', loginLimiter, validate(registerSchema), async (req: Request, res: Response) => {
  const { email, name, password } = req.body

  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    // Return 200 to prevent email enumeration — notify the existing user silently
    logger.info({ email }, 'Registration attempted for existing email')
    const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:5173'
    await sendEmail({
      to: email,
      subject: 'Someone tried to register with your email',
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #dc2626;">Monrad Estimator</h2>
          <p>Someone tried to register a new account using your email address.</p>
          <p>If this was you, you can <a href="${clientUrl}/login" style="color: #dc2626;">log in here</a> or reset your password if you've forgotten it.</p>
          <p style="color: #6b7280; font-size: 0.875rem;">If this wasn't you, you can safely ignore this email.</p>
        </div>
      `,
    }).catch(() => { /* swallow email errors */ })
    res.status(200).json({ message: 'If that email is not already registered, an account has been created.' })
    return
  }

  const hashed = await bcrypt.hash(password, 10)
  const user = await prisma.user.create({ data: { email, name, password: hashed } })
  logger.info({ userId: user.id }, 'New user registered')
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: '7d' })
  res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name } })
})

router.post('/login', loginLimiter, validate(loginSchema), async (req: Request, res: Response) => {
  const { email, password } = req.body
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user || !(await bcrypt.compare(password, user.password))) {
    logger.info({ email }, 'Failed login attempt')
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }
  logger.info({ userId: user.id }, 'User logged in')
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: '7d' })
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } })
})

router.post('/forgot-password', forgotPasswordLimiter, validate(forgotPasswordSchema), async (req: Request, res: Response) => {
  const { email } = req.body
  const successMessage = 'If that email is registered, a reset link has been sent.'

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    res.json({ message: successMessage })
    return
  }

  const token = crypto.randomBytes(32).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

  // Delete any existing unused tokens for this user
  await prisma.passwordResetToken.deleteMany({
    where: { userId: user.id, usedAt: null },
  })

  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash, expiresAt },
  })

  const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:5173'
  const resetLink = `${clientUrl}/reset-password?token=${token}`

  await sendEmail({
    to: user.email,
    subject: 'Reset your Monrad Estimator password',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #dc2626;">Monrad Estimator</h2>
        <p>Click the link below to reset your password. It expires in 1 hour.</p>
        <p><a href="${resetLink}" style="color: #dc2626;">${resetLink}</a></p>
        <p style="color: #6b7280; font-size: 0.875rem;">If you did not request a password reset, you can safely ignore this email.</p>
      </div>
    `,
  })

  logger.info({ userId: user.id }, 'Password reset email sent')
  res.json({ message: successMessage })
})

router.post('/reset-password', validate(resetPasswordSchema), async (req: Request, res: Response) => {
  const { token, password } = req.body

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

  // Atomic update: only succeeds if usedAt IS NULL (prevents race condition)
  const resetToken = await prisma.passwordResetToken.update({
    where: { tokenHash, usedAt: null },
    data: { usedAt: new Date() },
  }).catch(() => null)

  if (!resetToken || resetToken.expiresAt < new Date()) {
    res.status(400).json({ error: 'Invalid or expired reset token' })
    return
  }

  const hashed = await bcrypt.hash(password, 10)

  await prisma.user.update({
    where: { id: resetToken.userId },
    data: { password: hashed },
  })

  logger.info({ userId: resetToken.userId }, 'Password reset successfully')
  res.json({ message: 'Password reset successfully' })
})

export default router
