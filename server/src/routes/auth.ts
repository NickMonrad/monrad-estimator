import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { prisma } from '../lib/prisma.js'
import { sendEmail } from '../lib/email.js'

const router = Router()

router.post('/register', async (req: Request, res: Response) => {
  const { email, name, password } = req.body
  if (!email || !name || !password) {
    res.status(400).json({ error: 'email, name and password are required' })
    return
  }
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    res.status(409).json({ error: 'Email already in use' })
    return
  }
  const hashed = await bcrypt.hash(password, 10)
  const user = await prisma.user.create({ data: { email, name, password: hashed } })
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: '7d' })
  res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name } })
})

router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user || !(await bcrypt.compare(password, user.password))) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: '7d' })
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } })
})

router.post('/forgot-password', async (req: Request, res: Response) => {
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

  res.json({ message: successMessage })
})

router.post('/reset-password', async (req: Request, res: Response) => {
  const { token, password } = req.body
  if (!token || !password) {
    res.status(400).json({ error: 'token and password are required' })
    return
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
  })

  if (!resetToken || resetToken.usedAt !== null || resetToken.expiresAt < new Date()) {
    res.status(400).json({ error: 'Invalid or expired reset token' })
    return
  }

  const hashed = await bcrypt.hash(password, 10)

  await prisma.user.update({
    where: { id: resetToken.userId },
    data: { password: hashed },
  })

  await prisma.passwordResetToken.update({
    where: { id: resetToken.id },
    data: { usedAt: new Date() },
  })

  res.json({ message: 'Password reset successfully' })
})

export default router
