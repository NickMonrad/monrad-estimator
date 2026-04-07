import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { asyncHandler } from '../lib/asyncHandler.js'

function makeExpressArgs() {
  const req = {} as Request
  const res = {} as Response
  const next = vi.fn() as unknown as NextFunction
  return { req, res, next }
}

describe('asyncHandler', () => {
  it('calls next with the error when the wrapped handler rejects', async () => {
    const error = new Error('something went wrong')
    const handler = asyncHandler(async () => { throw error })

    const { req, res, next } = makeExpressArgs()
    handler(req, res, next)

    // Give the microtask queue a tick to resolve
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(next).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledWith(error)
  })

  it('calls next with the error when the wrapped handler returns a rejected promise', async () => {
    const error = new Error('rejected promise')
    const handler = asyncHandler(() => Promise.reject(error))

    const { req, res, next } = makeExpressArgs()
    handler(req, res, next)

    await new Promise<void>(resolve => setImmediate(resolve))

    expect(next).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledWith(error)
  })

  it('does NOT call next when the wrapped handler resolves successfully', async () => {
    const handler = asyncHandler(async (_req, res) => {
      ;(res as any).json = vi.fn()
      ;(res as any).status = vi.fn().mockReturnThis()
    })

    const { req, res, next } = makeExpressArgs()
    handler(req, res, next)

    await new Promise<void>(resolve => setImmediate(resolve))

    expect(next).not.toHaveBeenCalled()
  })

  it('does NOT call next when the wrapped handler resolves with a value', async () => {
    const handler = asyncHandler(async () => 'some-return-value')

    const { req, res, next } = makeExpressArgs()
    handler(req, res, next)

    await new Promise<void>(resolve => setImmediate(resolve))

    expect(next).not.toHaveBeenCalled()
  })

  it('passes req, res, and next through to the wrapped handler', async () => {
    const innerFn = vi.fn().mockResolvedValue(undefined)
    const handler = asyncHandler(innerFn)

    const { req, res, next } = makeExpressArgs()
    handler(req, res, next)

    await new Promise<void>(resolve => setImmediate(resolve))

    expect(innerFn).toHaveBeenCalledWith(req, res, next)
  })
})
