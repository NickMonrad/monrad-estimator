import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { authenticate } from './middleware/auth.js'
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
import rateCardRoutes, { applyRateCardRouter } from './routes/rateCards.js'
import namedResourceRoutes from './routes/namedResources.js'
import orgRoutes from './routes/orgs.js'
import customerRoutes from './routes/customers.js'
import documentRoutes from './routes/documents.js'

const app = express()
const PORT = process.env.PORT ?? 3001

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
app.use('/api/rate-cards', rateCardRoutes)
app.use('/api/projects/:projectId/apply-rate-card', applyRateCardRouter)
app.use('/api/projects/:projectId/documents', documentRoutes)
app.use('/api/orgs', authenticate, orgRoutes)
app.use('/api/customers', authenticate, customerRoutes)

export { app }
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))
