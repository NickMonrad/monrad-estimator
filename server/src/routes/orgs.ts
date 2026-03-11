import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { AuthRequest } from '../middleware/auth.js'
import { createHash, randomBytes } from 'crypto'
import { sendEmail } from '../lib/email.js'

const router = Router()

// GET /api/orgs — list orgs for current user
router.get('/', async (req: AuthRequest, res: Response) => {
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
})

// POST /api/orgs — create org
router.post('/', async (req: AuthRequest, res: Response) => {
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
})

// POST /api/orgs/accept-invite — accept an invite (authenticated)
// MUST be before /:id routes
router.post('/accept-invite', async (req: AuthRequest, res: Response) => {
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
})

// GET /api/orgs/:id/members — list members
router.get('/:id/members', async (req: AuthRequest, res: Response) => {
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
})

// DELETE /api/orgs/:id/members/:userId — remove member
router.delete('/:id/members/:userId', async (req: AuthRequest, res: Response) => {
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
})

// POST /api/orgs/:id/invites — invite by email
router.post('/:id/invites', async (req: AuthRequest, res: Response) => {
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
    subject: `You've been invited to join ${org.name} on Monrad Estimator`,
    html: `<p>You've been invited to join <strong>${org.name}</strong>.</p><p><a href="${clientUrl}/accept-invite?token=${token}">Accept invitation</a></p><p>This link expires in 7 days.</p>`,
  })

  res.status(201).json({ message: 'Invite sent' })
})

// PUT /api/orgs/:id/members/:userId — update member role
router.put('/:id/members/:userId', async (req: AuthRequest, res: Response) => {
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
})

export default router
