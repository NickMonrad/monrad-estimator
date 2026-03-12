import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { AuthRequest } from '../middleware/auth.js'

const router = Router()

// GET /api/customers
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userOrgIds = (await prisma.organisationMember.findMany({
      where: { userId: req.userId! },
      select: { orgId: true },
    })).map(m => m.orgId)

    const customers = await prisma.customer.findMany({
      where: {
        OR: [
          { ownerId: req.userId! },
          ...(userOrgIds.length > 0 ? [{ orgId: { in: userOrgIds } }] : []),
        ],
      },
      include: { org: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    })
    res.json(customers)
  } catch (err) {
    console.error('GET /customers error:', err)
    res.status(500).json({ error: 'Failed to fetch customers' })
  }
})

// POST /api/customers
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, accountCode, crmLink, orgId } = req.body
    if (!name) { res.status(400).json({ error: 'name is required' }); return }

    // Validate org membership if orgId provided
    if (orgId) {
      const membership = await prisma.organisationMember.findUnique({
        where: { orgId_userId: { orgId: orgId as string, userId: req.userId! } },
      })
      if (!membership) { res.status(403).json({ error: 'Not a member of that org' }); return }
    }

    const customer = await prisma.customer.create({
      data: { name, description, accountCode, crmLink, orgId, ownerId: req.userId! },
      include: { org: { select: { id: true, name: true } } },
    })
    res.status(201).json(customer)
  } catch (err) {
    console.error('POST /customers error:', err)
    res.status(500).json({ error: 'Failed to create customer' })
  }
})

// PUT /api/customers/:id
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string
    const customer = await prisma.customer.findUnique({ where: { id } })
    if (!customer) { res.status(404).json({ error: 'Not found' }); return }

    // Check access: owner or org admin/owner
    let canEdit = customer.ownerId === req.userId
    if (!canEdit && customer.orgId) {
      const membership = await prisma.organisationMember.findUnique({
        where: { orgId_userId: { orgId: customer.orgId, userId: req.userId! } },
      })
      canEdit = membership != null && ['OWNER', 'ADMIN'].includes(membership.role)
    }
    if (!canEdit) { res.status(403).json({ error: 'Forbidden' }); return }

    const { name, description, accountCode, crmLink, orgId } = req.body
    const newOrgId = orgId !== undefined ? (orgId || null) : undefined
    const updated = await prisma.customer.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(accountCode !== undefined && { accountCode }),
        ...(crmLink !== undefined && { crmLink }),
        ...(newOrgId !== undefined && { orgId: newOrgId }),
      },
      include: { org: { select: { id: true, name: true } } },
    })

    // If org changed, move all unassigned projects for this customer into the new org
    if (newOrgId !== undefined) {
      await prisma.project.updateMany({
        where: { customerId: id, orgId: null },
        data: { orgId: newOrgId },
      })
    }

    res.json(updated)
  } catch (err) {
    console.error('PUT /customers/:id error:', err)
    res.status(500).json({ error: 'Failed to update customer' })
  }
})

// DELETE /api/customers/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string
    const customer = await prisma.customer.findUnique({ where: { id } })
    if (!customer) { res.status(404).json({ error: 'Not found' }); return }
    if (customer.ownerId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return }

    // Detach linked projects
    await prisma.project.updateMany({
      where: { customerId: id },
      data: { customerId: null },
    })

    await prisma.customer.delete({ where: { id } })
    res.json({ message: 'Customer deleted' })
  } catch (err) {
    console.error('DELETE /customers/:id error:', err)
    res.status(500).json({ error: 'Failed to delete customer' })
  }
})

export default router
