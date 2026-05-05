import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import pinoHttp from 'pino-http'
import { logger } from './lib/logger.js'
import { authenticate } from './middleware/auth.js'
import { errorHandler } from './middleware/errorHandler.js'
import authRoutes from './routes/auth.js'
import projectRoutes from './routes/projects.js'
import epicRoutes from './routes/epics.js'
import featureRoutes from './routes/features.js'
import storyRoutes from './routes/stories.js'
import taskRoutes from './routes/tasks.js'
import resourceTypeRoutes from './routes/resourceTypes.js'
import templateRoutes from './routes/templates.js'
import applyTemplateRoutes from './routes/applyTemplate.js'
import globalResourceTypeRoutes from './routes/globalResourceTypes.js'
import effortRoutes from './routes/effort.js'
import timelineRoutes from './routes/timeline.js'
import snapshotRoutes from './routes/snapshots.js'
import csvRoutes from './routes/csv.js'
import reorderRoutes from './routes/reorder.js'
import discountRoutes from './routes/discounts.js'
import overheadRoutes from './routes/overhead.js'
import resourceProfileRoutes from './routes/resourceProfile.js'
import featureDependenciesRouter from './routes/featureDependencies.js'
import epicDependenciesRouter from './routes/epicDependencies.js'
import rateCardRoutes, { applyRateCardRouter } from './routes/rateCards.js'
import namedResourceRoutes from './routes/namedResources.js'
import orgRoutes from './routes/orgs.js'
import customerRoutes from './routes/customers.js'
import documentRoutes from './routes/documents.js'
import optimiserRoutes from './routes/optimiser.js'
import squadPlanRoutes from './routes/squadPlan.js'

const app = express()
const PORT = process.env.PORT ?? 3001

// JWT_SECRET startup validation
const jwtSecret = process.env.JWT_SECRET ?? ''
if (!jwtSecret || jwtSecret === 'change-me-in-production' || jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be set to a secure random string of 32+ characters')
}

app.use(helmet())
app.use(pinoHttp({ logger }))
app.use(cors({ origin: process.env.CLIENT_URL ?? 'http://localhost:5173' }))
app.use(express.json({ limit: '10mb' }))

app.get('/health', (_req, res) => res.json({ status: 'ok' }))
app.use('/api/auth', authRoutes)
app.use('/api/projects', projectRoutes)
app.use('/api/projects/:projectId/epics', epicRoutes)
app.use('/api/projects/:projectId/resource-types', resourceTypeRoutes)
app.use('/api/epics/:epicId/features', featureRoutes)
app.use('/api/features/:featureId/stories', storyRoutes)
app.use('/api/projects/:projectId/stories', storyRoutes)
app.use('/api/stories/:storyId/tasks', taskRoutes)
app.use('/api/templates', templateRoutes)
app.use('/api/features', applyTemplateRoutes)
app.use('/api/global-resource-types', globalResourceTypeRoutes)
app.use('/api/projects/:projectId/effort', effortRoutes)
app.use('/api/projects/:projectId/timeline', timelineRoutes)
app.use('/api/projects/:projectId/snapshots', snapshotRoutes)
app.use('/api/projects/:projectId/backlog', csvRoutes)
app.use('/api/projects/:projectId/reorder', reorderRoutes)
app.use('/api/projects/:projectId/discounts', discountRoutes)
app.use('/api/projects/:projectId/overhead', overheadRoutes)
app.use('/api/projects/:projectId/resource-profile', resourceProfileRoutes)
app.use('/api/projects/:projectId/resource-types/:rtId/named-resources', namedResourceRoutes)
app.use('/api/projects/:projectId/feature-dependencies', featureDependenciesRouter)
app.use('/api/projects/:projectId/epic-dependencies', epicDependenciesRouter)
app.use('/api/rate-cards', rateCardRoutes)
app.use('/api/projects/:projectId/apply-rate-card', applyRateCardRouter)
app.use('/api/projects/:projectId/documents', documentRoutes)
app.use('/api/projects/:projectId/optimise', optimiserRoutes)
app.use('/api/projects/:projectId/squad-plan', squadPlanRoutes)
app.use('/api/projects/:projectId/squad-plans', squadPlanRoutes)
app.use('/api/orgs', authenticate, orgRoutes)
app.use('/api/customers', authenticate, customerRoutes)

export { app }
app.use(errorHandler)
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))
