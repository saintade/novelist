import { createServer } from 'node:http'
import { productionConfiguration, verifyHostedDatabase } from './config.ts'
import { createProductionApp } from './http.ts'

const configuration = productionConfiguration(process.env, process.cwd())
await verifyHostedDatabase(configuration)
const { app, batches } = createProductionApp(configuration)
const server = createServer(app)
const port = Number(process.env.PORT || 3000)
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be a valid TCP port.')
server.requestTimeout = 240000
server.headersTimeout = 20000
server.listen(port, '0.0.0.0', () =>
  console.log(`Novelist production server listening on port ${port}`),
)
let stopping = false
const shutdown = () => {
  if (stopping) return
  stopping = true
  batches.stop()
  const deadline = setTimeout(() => {
    server.closeAllConnections()
    process.exit(1)
  }, 240000).unref()
  void Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    batches.drain(),
  ]).then(() => clearTimeout(deadline))
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
