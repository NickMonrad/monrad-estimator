import { Request, Response, NextFunction } from 'express'
import { logger } from '../lib/logger.js'

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  // Structured domain errors (e.g. CapacityIntegrityError) include a stable code and
  // actionable message safe to return in all environments.
  const code = (err as any).code as string | undefined
  const userMessage = (err as any).userMessage as string | undefined
  const status = (err as any).status ?? 500

  if (code) {
    res.status(status).json({
      error: userMessage ?? err.message,
      code,
    })
    return
  }

  logger.error({ err, url: req.url, method: req.method }, 'Unhandled error')
  res.status(status).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  })
}
