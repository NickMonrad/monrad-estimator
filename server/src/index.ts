import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import authRoutes from './routes/auth.js'
import projectRoutes from './routes/projects.js'
import epicRoutes from './routes/epics.js'
import featureRoutes from './routes/features.js'
import storyRoutes from './routes/stories.js'
import taskRoutes from './routes/tasks.js'
import resourceTypeRoutes from './routes/resourceTypes.js'
import templateRoutes from './routes/templates.js'
import applyTemplateRoutes from './routes/applyTemplate.js'

const app = express()
const PORT = process.env.PORT ?? 3001

app.use(cors({ origin: process.env.CLIENT_URL ?? 'http://localhost:5173' }))
app.use(express.json())

app.get('/health', (_req, res) => res.json({ status: 'ok' }))
app.use('/api/auth', authRoutes)
app.use('/api/projects', projectRoutes)
app.use('/api/projects/:projectId/epics', epicRoutes)
app.use('/api/projects/:projectId/resource-types', resourceTypeRoutes)
app.use('/api/epics/:epicId/features', featureRoutes)
app.use('/api/features/:featureId/stories', storyRoutes)
app.use('/api/stories/:storyId/tasks', taskRoutes)
app.use('/api/templates', templateRoutes)
app.use('/api/features', applyTemplateRoutes)

export { app }
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))
