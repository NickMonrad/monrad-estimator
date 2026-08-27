import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'

import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import { commitBacklogGrid, validateBacklogGrid } from '../lib/backlogGrid.js'
import * as projectSnapshotService from '../lib/projectSnapshotService.js'

process.env.JWT_SECRET = 'test-secret'
const userId = 'grid-user'
const projectId = 'grid-project'
const authHeader = `Bearer ${jwt.sign({ userId }, 'test-secret')}`
const project = { id: projectId, ownerId: userId, hoursPerDay: 8, name: 'Grid project' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.project.findFirst).mockResolvedValue(project as never)
  vi.mocked(prisma.project.findUnique).mockResolvedValue({ hoursPerDay: 8 } as never)
  vi.mocked(prisma.epic.findMany).mockResolvedValue([] as never)
  vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{ id: 'rt-dev', name: 'Developer' }] as never)
})

describe('POST /api/projects/:projectId/backlog/grid-commit', () => {
  it('requires project ownership', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const response = await request(app)
      .post(`/api/projects/${projectId}/backlog/grid-commit`)
      .set('Authorization', authHeader)
      .send({ rows: [{ type: 'epic', name: 'Hidden' }] })

    expect(response.status).toBe(404)
    expect(response.body.error).toBe('Project not found')
  })
  it('rejects malformed rows with field errors', async () => {
    const response = await request(app)
      .post(`/api/projects/${projectId}/backlog/grid-commit`)
      .set('Authorization', authHeader)
      .send({ rows: [null] })

    expect(response.status).toBe(400)
    expect(response.body.fieldErrors).toEqual(expect.arrayContaining([expect.objectContaining({ row: 0, field: 'row' })]))
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a new Story that conflicts with an existing Story', async () => {
    vi.mocked(prisma.epic.findMany).mockResolvedValue([{
      id: 'epic-1', name: 'E', features: [{ id: 'feature-1', name: 'F', epicId: 'epic-1', userStories: [{ id: 'story-1', name: 'S', featureId: 'feature-1', tasks: [] }] }],
    }] as never)
    const response = await request(app)
      .post(`/api/projects/${projectId}/backlog/grid-commit`)
      .set('Authorization', authHeader)
      .send({ rows: [{ type: 'story', epicName: 'E', featureName: 'F', name: 'S' }] })

    expect(response.status).toBe(400)
    expect(response.body.fieldErrors).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('existing story') })]))
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a new Task that conflicts with an existing Task', async () => {
    vi.mocked(prisma.epic.findMany).mockResolvedValue([{
      id: 'epic-1', name: 'E', features: [{ id: 'feature-1', name: 'F', epicId: 'epic-1', userStories: [{ id: 'story-1', name: 'S', featureId: 'feature-1', tasks: [{ id: 'task-1', name: 'T' }] }] }],
    }] as never)
    const response = await request(app)
      .post(`/api/projects/${projectId}/backlog/grid-commit`)
      .set('Authorization', authHeader)
      .send({ rows: [{ type: 'task', epicName: 'E', featureName: 'F', storyName: 'S', name: 'T', resourceTypeId: 'rt-dev', hoursEffort: 4 }] })

    expect(response.status).toBe(400)
    expect(response.body.fieldErrors).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('existing task') })]))
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
  it('allows same names under different parent paths', async () => {
    vi.mocked(prisma.epic.findMany).mockResolvedValue([{
      id: 'epic-1', name: 'E1', features: [{ id: 'feature-1', name: 'F', epicId: 'epic-1', userStories: [{ id: 'story-1', name: 'S', featureId: 'feature-1', tasks: [{ id: 'task-1', name: 'T' }] }] }],
    }] as never)

    await expect(validateBacklogGrid(projectId, [
      { type: 'epic', name: 'E2' },
      { type: 'feature', epicName: 'E2', name: 'F' },
      { type: 'story', epicName: 'E2', featureName: 'F', name: 'S' },
      { type: 'task', epicName: 'E2', featureName: 'F', storyName: 'S', name: 'T', resourceTypeId: 'rt-dev', hoursEffort: 4 },
    ])).resolves.toBeDefined()
  })



  it('rejects an unresolved resource type before opening a transaction', async () => {
    const response = await request(app)
      .post(`/api/projects/${projectId}/backlog/grid-commit`)
      .set('Authorization', authHeader)
      .send({ rows: [{ type: 'task', epicName: 'E', featureName: 'F', storyName: 'S', name: 'T', resourceTypeName: 'Typo', hoursEffort: 4 }] })

    expect(response.status).toBe(400)
    expect(response.body.fieldErrors).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'resourceType', message: expect.stringContaining('resolve') })]))
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('creates an epic, feature, story and task in one explicit commit', async () => {
    vi.mocked(prisma.$transaction).mockImplementationOnce(async callback => callback({
      epic: { create: vi.fn().mockResolvedValue({ id: 'epic-id' }), update: vi.fn() },
      feature: { create: vi.fn().mockResolvedValue({ id: 'feature-id' }), update: vi.fn() },
      userStory: { create: vi.fn().mockResolvedValue({ id: 'story-id' }), update: vi.fn() },
      task: { create: vi.fn().mockResolvedValue({ id: 'task-id' }), update: vi.fn() },
      project: { update: vi.fn() },
      backlogSnapshot: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
    } as never) as never)

    const response = await request(app)
      .post(`/api/projects/${projectId}/backlog/grid-commit`)
      .set('Authorization', authHeader)
      .send({ rows: [
        { type: 'task', epicName: 'E', featureName: 'F', storyName: 'S', name: 'T', resourceTypeId: 'rt-dev', hoursEffort: 8 },
        { type: 'story', epicName: 'E', featureName: 'F', name: 'S' },
        { type: 'feature', epicName: 'E', name: 'F' },
        { type: 'epic', name: 'E' },
      ] })

    expect(response.status).toBe(200)
    expect(response.body.message).toBe('Grid entry committed')
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(response.body.rowIds).toEqual(['task-id', 'story-id', 'feature-id', 'epic-id'])
  })
  it('rejects existing-row renames that collide with a sibling hierarchy item', async () => {
    vi.mocked(prisma.epic.findMany).mockResolvedValue([{
      id: 'epic-1', name: 'E', features: [{
        id: 'feature-1', name: 'F', epicId: 'epic-1', userStories: [{
          id: 'story-1', name: 'S', featureId: 'feature-1', tasks: [{ id: 'task-1', name: 'T' }, { id: 'task-2', name: 'T2' }],
        }, {
          id: 'story-2', name: 'S2', featureId: 'feature-1', tasks: [],
        }],
      }, {
        id: 'feature-2', name: 'F2', epicId: 'epic-1', userStories: [],
      }],
    }, {
      id: 'epic-2', name: 'E2', features: [],
    }] as never)

    await expect(validateBacklogGrid(projectId, [
      { id: 'epic-1', type: 'epic', name: 'E2' },
      { id: 'feature-1', type: 'feature', epicName: 'E', name: 'F2' },
      { id: 'story-1', type: 'story', epicName: 'E', featureName: 'F', name: 'S2' },
      { id: 'task-1', type: 'task', epicName: 'E', featureName: 'F', storyName: 'S', name: 'T2', resourceTypeId: 'rt-dev', hoursEffort: 4 },
    ])).rejects.toMatchObject({
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ row: 0, field: 'name', message: expect.stringContaining('existing epic') }),
        expect.objectContaining({ row: 1, field: 'name', message: expect.stringContaining('existing feature') }),
        expect.objectContaining({ row: 2, field: 'name', message: expect.stringContaining('existing story') }),
        expect.objectContaining({ row: 3, field: 'name', message: expect.stringContaining('existing task') }),
      ]),
    })
  })
  it('rejects two existing siblings renamed to the same proposed name', async () => {
    vi.mocked(prisma.epic.findMany).mockResolvedValue([
      { id: 'epic-1', name: 'Epic A', features: [] },
      { id: 'epic-2', name: 'Epic B', features: [] },
    ] as never)

    const response = await request(app)
      .post(`/api/projects/${projectId}/backlog/grid-commit`)
      .set('Authorization', authHeader)
      .send({ rows: [
        { id: 'epic-1', type: 'epic', name: 'X' },
        { id: 'epic-2', type: 'epic', name: 'X' },
      ] })

    expect(response.status).toBe(400)
    expect(response.body.fieldErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 0, message: 'duplicate proposed hierarchy path' }),
      expect.objectContaining({ row: 1, message: 'duplicate proposed hierarchy path' }),
    ]))
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects an existing rename that collides with a newly staged sibling', async () => {
    vi.mocked(prisma.epic.findMany).mockResolvedValue([{ id: 'epic-1', name: 'Epic A', features: [] }] as never)

    const response = await request(app)
      .post(`/api/projects/${projectId}/backlog/grid-commit`)
      .set('Authorization', authHeader)
      .send({ rows: [
        { id: 'epic-1', type: 'epic', name: 'X' },
        { type: 'epic', name: 'X' },
      ] })

    expect(response.status).toBe(400)
    expect(response.body.fieldErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 0, message: 'duplicate proposed hierarchy path' }),
      expect.objectContaining({ row: 1, message: 'duplicate proposed hierarchy path' }),
    ]))
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects duplicate proposed task paths within one existing story', async () => {
    vi.mocked(prisma.epic.findMany).mockResolvedValue([{
      id: 'epic-1', name: 'E', features: [{
        id: 'feature-1', name: 'F', epicId: 'epic-1', userStories: [{
          id: 'story-1', name: 'S', featureId: 'feature-1', tasks: [
            { id: 'task-1', name: 'Task A' },
            { id: 'task-2', name: 'Task B' },
          ],
        }],
      }],
    }] as never)

    const response = await request(app)
      .post(`/api/projects/${projectId}/backlog/grid-commit`)
      .set('Authorization', authHeader)
      .send({ rows: [
        { id: 'task-1', type: 'task', epicName: 'E', featureName: 'F', storyName: 'S', name: 'X', resourceTypeId: 'rt-dev', hoursEffort: 4 },
        { id: 'task-2', type: 'task', epicName: 'E', featureName: 'F', storyName: 'S', name: 'X', resourceTypeId: 'rt-dev', hoursEffort: 4 },
      ] })

    expect(response.status).toBe(400)
    expect(response.body.fieldErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 0, message: 'duplicate proposed hierarchy path' }),
      expect.objectContaining({ row: 1, message: 'duplicate proposed hierarchy path' }),
    ]))
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('assigns contiguous order to new tasks without counting existing updates', async () => {
    vi.mocked(prisma.epic.findMany).mockResolvedValue([{
      id: 'epic-1', name: 'E', features: [{
        id: 'feature-1', name: 'F', epicId: 'epic-1', userStories: [{
          id: 'story-1', name: 'S', featureId: 'feature-1', tasks: [{ id: 'task-1', name: 'Existing' }],
        }],
      }],
    }] as never)
    vi.spyOn(projectSnapshotService, 'buildSnapshot').mockResolvedValue({} as never)
    const taskCreate = vi.fn()
      .mockResolvedValueOnce({ id: 'task-2' })
      .mockResolvedValueOnce({ id: 'task-3' })
    vi.mocked(prisma.$transaction).mockImplementationOnce(async callback => callback({
      backlogSnapshot: { create: vi.fn().mockResolvedValue({ id: 'snapshot-1' }), findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
      task: { update: vi.fn(), create: taskCreate },
      project: { update: vi.fn() },
    } as never) as never)

    await commitBacklogGrid(projectId, userId, [
      { id: 'task-1', type: 'task', epicName: 'E', featureName: 'F', storyName: 'S', name: 'Existing', resourceTypeId: 'rt-dev', hoursEffort: 4 },
      { type: 'task', epicName: 'E', featureName: 'F', storyName: 'S', name: 'New 1', resourceTypeId: 'rt-dev', hoursEffort: 4 },
      { type: 'task', epicName: 'E', featureName: 'F', storyName: 'S', name: 'New 2', resourceTypeId: 'rt-dev', hoursEffort: 4 },
    ])

    expect(taskCreate.mock.calls.map(([args]) => args.data.order)).toEqual([1, 2])
  })
})
