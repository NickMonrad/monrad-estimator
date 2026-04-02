import { Request, Response, NextFunction } from 'express'
import { logger } from '../lib/logger.js'

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  logger.error({ err, url: req.url, method: req.method }, 'Unhandled error')
  const status = (err as any).status ?? 500
  res.status(status).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  })
}
