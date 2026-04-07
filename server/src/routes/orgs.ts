import { Router, Response } from 'express'
import { asyncHandler } from '../lib/asyncHandler.js'
import { prisma } from '../lib/prisma.js'
import { AuthRequest } from '../middleware/auth.js'
import { createHash, randomBytes } from 'crypto'
import { sendEmail } from '../lib/email.js'

// #170: HTML escape helper to prevent HTML injection in email templates
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const router = Router()

// GET /api/orgs — list orgs for current user
router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const memberships = await prisma.organisationMember.findMany({
    where: { userId: req.userId! },
    include: {
      org: {
        include: {
          _count: { select: { members: true } },
        },
      },
    },
  })
  res.json(memberships.map(m => ({ ...m.org, role: m.role })))
}))

// POST /api/orgs — create org
router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { name } = req.body
  if (!name) { res.status(400).json({ error: 'name is required' }); return }
  const org = await prisma.organisation.create({
    data: {
      name,
      members: { create: { userId: req.userId!, role: 'OWNER' } },
    },
    include: { _count: { select: { members: true } } },
  })
  res.status(201).json({ ...org, role: 'OWNER' })
}))

// POST /api/orgs/accept-invite — accept an invite (authenticated)
// MUST be before /:id routes
router.post('/accept-invite', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { token } = req.body
  if (!token) { res.status(400).json({ error: 'token is required' }); return }

  const tokenHash = createHash('sha256').update(token as string).digest('hex')
  const invite = await prisma.organisationInvite.findUnique({ where: { tokenHash } })
  if (!invite) { res.status(404).json({ error: 'Invalid or expired invite' }); return }
  if (invite.acceptedAt) { res.status(400).json({ error: 'Invite already accepted' }); return }
  if (invite.expiresAt < new Date()) { res.status(400).json({ error: 'Invite has expired' }); return }

  // Add user to org (upsert to handle re-acceptance gracefully)
  await prisma.organisationMember.upsert({
    where: { orgId_userId: { orgId: invite.orgId, userId: req.userId! } },
    update: { role: invite.role },
    create: { orgId: invite.orgId, userId: req.userId!, role: invite.role },
  })

  await prisma.organisationInvite.update({
    where: { tokenHash },
    data: { acceptedAt: new Date() },
  })

  res.json({ message: 'Joined organisation', orgId: invite.orgId })
}))

// GET /api/orgs/:id/members — list members
router.get('/:id/members', asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  const membership = await prisma.organisationMember.findUnique({
    where: { orgId_userId: { orgId: id, userId: req.userId! } },
  })
  if (!membership) { res.status(403).json({ error: 'Forbidden' }); return }
  const members = await prisma.organisationMember.findMany({
    where: { orgId: id },
    include: { user: { select: { id: true, name: true, email: true } } },
  })
  res.json(members)
}))

// DELETE /api/orgs/:id/members/:userId — remove member
router.delete('/:id/members/:userId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  const targetUserId = req.params.userId as string
  const requesterMembership = await prisma.organisationMember.findUnique({
    where: { orgId_userId: { orgId: id, userId: req.userId! } },
  })
  if (!requesterMembership || !['OWNER', 'ADMIN'].includes(requesterMembership.role)) {
    res.status(403).json({ error: 'Forbidden' }); return
  }
  // Cannot remove last OWNER
  const targetMembership = await prisma.organisationMember.findUnique({
    where: { orgId_userId: { orgId: id, userId: targetUserId } },
  })
  if (!targetMembership) { res.status(404).json({ error: 'Member not found' }); return }
  if (targetMembership.role === 'OWNER') {
    const ownerCount = await prisma.organisationMember.count({
      where: { orgId: id, role: 'OWNER' },
    })
    if (ownerCount <= 1) { res.status(400).json({ error: 'Cannot remove the last owner' }); return }
  }
  await prisma.organisationMember.delete({
    where: { orgId_userId: { orgId: id, userId: targetUserId } },
  })
  res.json({ message: 'Member removed' })
}))

// POST /api/orgs/:id/invites/:inviteId/resend — resend a pending invite (BEFORE /:id/invites and /:id/invites/:inviteId)
router.post('/:id/invites/:inviteId/resend', asyncHandler(async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string
    const inviteId = req.params.inviteId as string
    const requesterMembership = await prisma.organisationMember.findUnique({
      where: { orgId_userId: { orgId: id, userId: req.userId! } },
    })
    if (!requesterMembership || !['OWNER', 'ADMIN'].includes(requesterMembership.role)) {
      res.status(403).json({ error: 'Forbidden' }); return
    }
    const invite = await prisma.organisationInvite.findFirst({
      where: { id: inviteId, orgId: id, acceptedAt: null },
    })
    if (!invite) { res.status(404).json({ error: 'Invite not found' }); return }

    const newToken = randomBytes(32).toString('hex')
    const newTokenHash = createHash('sha256').update(newToken).digest('hex')
    const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    const org = await prisma.organisation.findUnique({ where: { id } })
    if (!org) { res.status(404).json({ error: 'Org not found' }); return }

    const updated = await prisma.organisationInvite.update({
      where: { id: inviteId },
      data: { tokenHash: newTokenHash, expiresAt: newExpiresAt },
    })

    const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:5173'
    await sendEmail({
      to: invite.email,
      subject: `You've been invited to join ${esc(org.name)} on Monrad Estimator`,
      html: `<p>You've been invited to join <strong>${esc(org.name)}</strong>.</p><p><a href="${clientUrl}/accept-invite?token=${newToken}">Accept invitation</a></p><p>This link expires in 7 days.</p>`,
    })

    res.json(updated)
  } catch {
    res.status(500).json({ error: 'Failed to resend invite' })
  }
}))

// DELETE /api/orgs/:id/invites/:inviteId — cancel a pending invite
router.delete('/:id/invites/:inviteId', asyncHandler(async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string
    const inviteId = req.params.inviteId as string
    const requesterMembership = await prisma.organisationMember.findUnique({
      where: { orgId_userId: { orgId: id, userId: req.userId! } },
    })
    if (!requesterMembership || !['OWNER', 'ADMIN'].includes(requesterMembership.role)) {
      res.status(403).json({ error: 'Forbidden' }); return
    }
    const invite = await prisma.organisationInvite.findFirst({
      where: { id: inviteId, orgId: id, acceptedAt: null },
    })
    if (!invite) { res.status(404).json({ error: 'Invite not found' }); return }
    await prisma.organisationInvite.delete({ where: { id: inviteId } })
    res.json({ message: 'Invite cancelled' })
  } catch {
    res.status(500).json({ error: 'Failed to cancel invite' })
  }
}))

// GET /api/orgs/:id/invites — list pending invites
router.get('/:id/invites', asyncHandler(async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string
    const membership = await prisma.organisationMember.findUnique({
      where: { orgId_userId: { orgId: id, userId: req.userId! } },
    })
    if (!membership) { res.status(403).json({ error: 'Forbidden' }); return }
    const invites = await prisma.organisationInvite.findMany({
      where: { orgId: id, acceptedAt: null },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })
    res.json(invites)
  } catch {
    res.status(500).json({ error: 'Failed to fetch invites' })
  }
}))

// POST /api/orgs/:id/invites — invite by email
router.post('/:id/invites', asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  const requesterMembership = await prisma.organisationMember.findUnique({
    where: { orgId_userId: { orgId: id, userId: req.userId! } },
  })
  if (!requesterMembership || !['OWNER', 'ADMIN'].includes(requesterMembership.role)) {
    res.status(403).json({ error: 'Forbidden' }); return
  }
  const { email, role = 'MEMBER' } = req.body
  if (!email) { res.status(400).json({ error: 'email is required' }); return }

  const token = randomBytes(32).toString('hex')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  const org = await prisma.organisation.findUnique({ where: { id } })
  if (!org) { res.status(404).json({ error: 'Org not found' }); return }

  await prisma.organisationInvite.create({
    data: { orgId: id, email, tokenHash, role, expiresAt },
  })

  const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:5173'
  await sendEmail({
    to: email,
    subject: `You've been invited to join ${esc(org.name)} on Monrad Estimator`,
    html: `<p>You've been invited to join <strong>${esc(org.name)}</strong>.</p><p><a href="${clientUrl}/accept-invite?token=${token}">Accept invitation</a></p><p>This link expires in 7 days.</p>`,
  })

  res.status(201).json({ message: 'Invite sent' })
}))

// PUT /api/orgs/:id/members/:userId — update member role
router.put('/:id/members/:userId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  const targetUserId = req.params.userId as string
  const requesterMembership = await prisma.organisationMember.findUnique({
    where: { orgId_userId: { orgId: id, userId: req.userId! } },
  })
  if (!requesterMembership || requesterMembership.role !== 'OWNER') {
    res.status(403).json({ error: 'Only owners can change roles' }); return
  }
  const { role } = req.body
  if (!['OWNER', 'ADMIN', 'MEMBER'].includes(role)) {
    res.status(400).json({ error: 'Invalid role' }); return
  }
  const updated = await prisma.organisationMember.update({
    where: { orgId_userId: { orgId: id, userId: targetUserId } },
    data: { role },
  })
  res.json(updated)
}))

export default router
