import express from 'express'
import helmet from 'helmet'
import { resolve } from 'node:path'
import type { AIConfiguration } from './ai/experiments.ts'
import { createAIMiddleware } from './ai/plugin.ts'
import { TranslationBatchManager } from './ai/translation-batches.ts'

export function createProductionApp(
  configuration: AIConfiguration,
  assets = resolve(configuration.root, 'dist'),
) {
  if (!configuration.hosted || !configuration.allowedUserId || !configuration.publicOrigin)
    throw new Error('A production app requires an allowed owner and a public HTTPS origin.')
  const app = express()
  const batches = new TranslationBatchManager(configuration)
  app.disable('x-powered-by')
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", new URL(configuration.supabaseUrl).origin],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  )
  app.get('/health', (_request, response) => {
    response.set('Cache-Control', 'no-store').json({ status: 'ok' })
  })
  app.use(createAIMiddleware(configuration, batches))
  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'Endpoint not found.' })
  })
  app.use((request, response, next) => {
    if (
      /(?:^|\/)(?:\.[^/]+|src|server|supabase|node_modules|@fs|@vite)(?:\/|$)/.test(request.path) ||
      /\.(?:env|pem|key|sql|ts|tsx)$/.test(request.path)
    ) {
      response.sendStatus(404)
      return
    }
    next()
  })
  app.use(
    express.static(assets, {
      dotfiles: 'deny',
      index: false,
      setHeaders: (response, path) => {
        response.setHeader(
          'Cache-Control',
          /\/assets\//.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
        )
      },
    }),
  )
  app.get('/{*path}', (request, response) => {
    if (request.path.includes('.') || !request.accepts('html')) {
      response.sendStatus(404)
      return
    }
    response.set('Cache-Control', 'no-store').sendFile(resolve(assets, 'index.html'))
  })
  return { app, batches }
}
