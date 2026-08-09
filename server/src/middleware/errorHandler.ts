import { CapacityIntegrityError } from '../lib/capacityIntegrityError.js'
import { ReplanRequiredError } from '../lib/projectPlanningState.js'
import { Request, Response, NextFunction } from 'express'
import { logger } from '../lib/logger.js'
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  // Structured domain errors (e.g. CapacityIntegrityError) include a stable code and
  // actionable message safe to return in all environments.
  if (err instanceof CapacityIntegrityError) {
    res.status(err.status).json({
      error: err.userMessage,
      code: err.code,
    })
    return
  }

  // Expected quarantine condition: the project is explicitly NEEDS_REPLAN.
  if (err instanceof ReplanRequiredError) {
    res.status(err.status).json({
      error: err.userMessage,
      code: err.code,
    })
    return
  }

  logger.error({ err, url: req.url, method: req.method }, 'Unhandled error')
  const status = (err as any).status ?? 500
  res.status(status).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  })
}
