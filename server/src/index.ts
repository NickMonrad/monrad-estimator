export { app } from './app.js'

import 'dotenv/config'
import { app } from './app.js'

const PORT = process.env.PORT ?? 3001

// JWT_SECRET startup validation
const jwtSecret = process.env.JWT_SECRET ?? ''
if (!jwtSecret || jwtSecret === 'change-me-in-production' || jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be set to a secure random string of 32+ characters')
}

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))
