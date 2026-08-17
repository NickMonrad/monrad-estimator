import { CapacityIntegrityError } from '../lib/capacityIntegrityError.js'
import { ReplanRequiredError } from '../lib/projectPlanningState.js'
import { ProjectNotFoundError } from '../lib/projectPlanningModel.js'
import { ScheduleValidationError } from '../lib/scheduleProject.js'
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

  // Only a genuinely missing/unauthorised project maps to 404.
  if (err instanceof ProjectNotFoundError) {
    res.status(404).json({ error: err.userMessage })
    return
  }

  // Actionable input-validation failures remain 400-class.
  if (err instanceof ScheduleValidationError) {
    res.status(err.status).json({ error: err.userMessage })
    return
  }

  logger.error({ err, url: req.url, method: req.method }, 'Unhandled error')
  const status = (err as any).status ?? 500
  res.status(status).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  })
}
