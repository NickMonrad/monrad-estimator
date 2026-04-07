import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { logger } from '../lib/logger.js'

export interface AuthRequest extends Request {
  userId?: string
  user?: { id: string; role: string }
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    logger.info({ url: req.url, method: req.method }, '401 Unauthorized - missing token')
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string; role?: string }
    req.userId = payload.userId
    req.user = { id: payload.userId, role: payload.role ?? 'USER' }
    next()
  } catch {
    logger.info({ url: req.url, method: req.method }, '401 Unauthorized - invalid token')
    res.status(401).json({ error: 'Invalid token' })
    return
  }
}
