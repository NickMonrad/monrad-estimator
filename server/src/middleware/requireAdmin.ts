import { Request, Response, NextFunction } from 'express'

// #169 RBAC: Middleware to restrict access to ADMIN role users only.
// Must be used after `authenticate` middleware which sets req.user.
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if ((req as any).user?.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}
