import { createHash, randomBytes } from 'node:crypto'
import { extensionIdSchema } from '../../src/lib/extension/contracts.ts'
import { ExperimentError } from '../ai/experiments.ts'

export interface PairedLibrary {
  extensionId: string
  ownerId: string
  libraryToken: string
  expiresAt: number
  connectionId: string
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export class ExtensionPairing {
  private pending = new Map<string, Omit<PairedLibrary, 'connectionId'>>()
  private connections = new Map<string, PairedLibrary>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  private prune() {
    for (const [key, value] of this.pending)
      if (value.expiresAt <= this.now()) this.pending.delete(key)
    for (const [key, value] of this.connections)
      if (value.expiresAt <= this.now()) this.connections.delete(key)
  }

  create(extensionId: string, ownerId: string, libraryToken: string) {
    extensionIdSchema.parse(extensionId)
    this.prune()
    for (const [key, value] of this.pending) if (value.ownerId === ownerId) this.pending.delete(key)
    if (this.pending.size >= 100)
      throw new ExperimentError('Too many pending extension connections.', 429)
    const code = randomBytes(32).toString('hex')
    const expiresAt = this.now() + 2 * 60_000
    this.pending.set(digest(code), { extensionId, ownerId, libraryToken, expiresAt })
    return { code, expiresAt }
  }

  exchange(extensionId: string, code: string) {
    this.prune()
    const pending = this.pending.get(digest(code))
    if (!pending || pending.extensionId !== extensionId)
      throw new ExperimentError(
        'The connection approval expired or belongs to another extension. Connect again.',
        401,
      )
    this.pending.delete(digest(code))
    for (const [key, value] of this.connections)
      if (value.ownerId === pending.ownerId && value.extensionId === extensionId)
        this.connections.delete(key)
    const token = randomBytes(32).toString('hex')
    const connectionId = digest(token)
    const expiresAt = this.now() + 30 * 60_000
    this.connections.set(connectionId, { ...pending, connectionId, expiresAt })
    return { token, expiresAt }
  }

  authorize(extensionId: string, token: string): PairedLibrary {
    this.prune()
    const connection = this.connections.get(digest(token))
    if (!connection || connection.extensionId !== extensionId)
      throw new ExperimentError('Reconnect the extension to your local Novelist library.', 401)
    return connection
  }

  revoke(extensionId: string, token: string) {
    const connection = this.authorize(extensionId, token)
    this.connections.delete(connection.connectionId)
  }
}
