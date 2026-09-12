import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchChapterSample } from './sample'
import { trainingFixtures } from '../scraper/fixtures'

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('node:http', async (original) => ({
  ...(await original<typeof import('node:http')>()),
  request: mocks.request,
}))
vi.mock('node:https', async (original) => ({
  ...(await original<typeof import('node:https')>()),
  request: mocks.request,
}))
afterEach(() => vi.resetAllMocks())

function response(statusCode: number, body: string, contentType = 'text/html; charset=utf-8') {
  mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }])
  let closed = false
  mocks.request.mockImplementation((_options, callback) => {
    const incoming = Object.assign(Readable.from([Buffer.from(body)]), {
      statusCode,
      headers: { 'content-type': contentType },
    })
    const request = Object.assign(new EventEmitter(), {
      end: () => queueMicrotask(() => callback(incoming)),
      destroy: (error?: Error) => {
        incoming.destroy()
        if (error) request.emit('error', error)
      },
    })
    incoming.on('close', () => {
      closed = true
      request.emit('close')
    })
    return request
  })
  return () => closed
}

describe('restricted public chapter fetch', () => {
  const page = trainingFixtures[0].page
  const url = trainingFixtures[1].page.url
  it('pins the public DNS result while preserving TLS hostname and omitting credentials', async () => {
    response(
      200,
      '<html><body><h1>Chapter one</h1><p>Readable chapter.</p><form><input value="private-data"></form></body></html>',
    )
    const sample = await fetchChapterSample(page, url)
    expect(sample.html).toContain('Readable chapter.')
    expect(sample.html).not.toContain('private-data')
    expect(mocks.lookup).toHaveBeenCalledWith('books.example.test', { all: true, verbatim: true })
    const options = mocks.request.mock.calls[0][0]
    expect(options).toMatchObject({
      hostname: '1.1.1.1',
      servername: 'books.example.test',
      method: 'GET',
      path: '/river-ledger/1',
    })
    expect(options.headers.Cookie).toBeUndefined()
    expect(options.headers.Authorization).toBeUndefined()
  })
  it('does not issue a request for private DNS results or follow redirects', async () => {
    mocks.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    await expect(fetchChapterSample(page, url)).rejects.toThrow('network destinations')
    expect(mocks.request).not.toHaveBeenCalled()
    const closed = response(302, 'Redirect to another page')
    await expect(fetchChapterSample(page, url)).rejects.toThrow('redirects')
    await vi.waitFor(() => expect(closed()).toBe(true))
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
  it('stops oversized and non-HTML responses', async () => {
    response(200, 'a'.repeat(1_000_001))
    await expect(fetchChapterSample(page, url)).rejects.toThrow('1 MB')
    response(200, '{}', 'application/json')
    await expect(fetchChapterSample(page, url)).rejects.toThrow('HTML pages')
  })
})
