import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extensionBridgeMiddleware } from './bridge'
import { trainingFixtures } from '../scraper/fixtures'

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  scrape: vi.fn(),
  sample: vi.fn(),
  authorize: vi.fn(),
  navigate: vi.fn(),
  download: vi.fn(),
}))
vi.mock('./inspect.ts', async (original) => ({
  ...(await original<typeof import('./inspect.ts')>()),
  inspectNovelPage: mocks.inspect,
}))
vi.mock('./sample.ts', async (original) => ({
  ...(await original<typeof import('./sample.ts')>()),
  fetchChapterSample: mocks.sample,
}))
vi.mock('../scraper/tool.ts', () => ({ runScraperTool: mocks.scrape }))
vi.mock('./library.ts', async (original) => ({
  ...(await original<typeof import('./library.ts')>()),
  saveRenderedSourceChapter: mocks.download,
}))
vi.mock('./navigation.ts', async (original) => ({
  ...(await original<typeof import('./navigation.ts')>()),
  planNavigation: mocks.navigate,
}))
vi.mock('../ai/experiments.ts', async (original) => ({
  ...(await original<typeof import('../ai/experiments.ts')>()),
  acquireAILibrary: mocks.authorize,
}))

const servers: Server[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

async function startBridge(liveEnabled = true) {
  const handler = extensionBridgeMiddleware({
    root: '',
    apiKey: 'test-only',
    model: 'test-only',
    liveEnabled,
    supabaseUrl: '',
    publishableKey: '',
  })
  const server = createServer((request, response) =>
    handler(request, response, () => {
      response.statusCode = 404
      response.end()
    }),
  )
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server unavailable')
  return `http://127.0.0.1:${address.port}`
}

describe('paired extension HTTP bridge', () => {
  it('polls rendered download jobs and releases completed slots without cancelling running work', async () => {
    const origin = await startBridge(false)
    const extensionId = 'a'.repeat(32)
    mocks.authorize.mockResolvedValue({ ownerId: 'test-owner', release: () => undefined })
    const approval = await (
      await fetch(`${origin}/api/extension/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer private-library-token',
        },
        body: JSON.stringify({ extensionId }),
      })
    ).json()
    const headers = {
      'Content-Type': 'application/json',
      'X-Novelist-Extension-Id': extensionId,
      Origin: `chrome-extension://${extensionId}`,
    }
    const connection = await (
      await fetch(`${origin}/api/extension/connect`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: approval.code }),
      })
    ).json()
    const authenticated = { ...headers, Authorization: `Bearer ${connection.token}` }
    let finish!: (value: unknown) => void
    mocks.download.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const payload = {
      bookId: 'e'.repeat(32),
      sourceUrl: trainingFixtures[0].page.url,
      page: trainingFixtures[1].page,
      confirmed: false,
    }
    const start = await fetch(`${origin}/api/extension/library/chapter/start`, {
      method: 'POST',
      headers: authenticated,
      body: JSON.stringify(payload),
    })
    expect(start.status).toBe(202)
    const { id } = await start.json()
    expect(
      (
        await fetch(`${origin}/api/extension/jobs/${id}`, {
          method: 'DELETE',
          headers: authenticated,
        })
      ).status,
    ).toBe(409)
    expect((await fetch(`${origin}/api/extension/jobs/${id}`, { headers })).status).toBe(401)
    finish({ state: 'ready', title: 'Chapter 1', cached: true })
    await vi.waitFor(async () =>
      expect(
        await (
          await fetch(`${origin}/api/extension/jobs/${id}`, { headers: authenticated })
        ).json(),
      ).toMatchObject({ state: 'completed', download: { state: 'ready', cached: true } }),
    )
    expect(mocks.download.mock.lastCall?.[0]).toBe('private-library-token')
    expect(mocks.download.mock.lastCall?.[1]).toEqual(payload)
    expect(
      (
        await fetch(`${origin}/api/extension/jobs/${id}`, {
          method: 'DELETE',
          headers: authenticated,
        })
      ).status,
    ).toBe(200)
    expect(
      (await fetch(`${origin}/api/extension/jobs/${id}`, { headers: authenticated })).status,
    ).toBe(404)
    expect(mocks.scrape).not.toHaveBeenCalled()
  })
  it('allows authenticated cached scraper tests with live AI off while identification remains disabled', async () => {
    const origin = await startBridge(false)
    const extensionId = 'a'.repeat(32)
    mocks.authorize.mockResolvedValue({ ownerId: 'test-owner', release: () => undefined })
    const approval = await (
      await fetch(`${origin}/api/extension/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer private-library-token',
        },
        body: JSON.stringify({ extensionId }),
      })
    ).json()
    const headers = {
      'Content-Type': 'application/json',
      'X-Novelist-Extension-Id': extensionId,
      Origin: `chrome-extension://${extensionId}`,
    }
    const connection = await (
      await fetch(`${origin}/api/extension/connect`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: approval.code }),
      })
    ).json()
    const authenticated = { ...headers, Authorization: `Bearer ${connection.token}` }
    mocks.scrape.mockResolvedValue({
      code: 'test-only',
      report: {
        status: 'needs_review',
        attempts: [{ checks: [{ passed: true, output: { kind: 'chapter' } }] }],
        adapter: { strategy: 'reused' },
      },
    })
    const job = await (
      await fetch(`${origin}/api/extension/test`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify({
          page: trainingFixtures[1].page,
          sampleUrls: [],
          expectedKind: 'chapter',
          rightsConfirmed: true,
          sendToModelConfirmed: true,
        }),
      })
    ).json()
    await vi.waitFor(async () =>
      expect(
        await (
          await fetch(`${origin}/api/extension/jobs/${job.id}`, { headers: authenticated })
        ).json(),
      ).toMatchObject({
        state: 'completed',
        scrape: { report: { adapter: { strategy: 'reused' } } },
      }),
    )
    expect(mocks.scrape.mock.lastCall?.[1].expectedKind).toBe('chapter')
    expect(
      (
        await fetch(`${origin}/api/extension/inspect`, {
          method: 'POST',
          headers: authenticated,
          body: JSON.stringify({ page: trainingFixtures[0].page, sendToModelConfirmed: true }),
        })
      ).status,
    ).toBe(403)
    expect(mocks.inspect).not.toHaveBeenCalled()
  })
  it('plans within an approved navigation session and uses rendered samples without HTTP refetch', async () => {
    const origin = await startBridge()
    const extensionId = 'a'.repeat(32)
    mocks.authorize.mockResolvedValue({ ownerId: 'test-owner', release: () => undefined })
    const approval = await (
      await fetch(`${origin}/api/extension/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer private-library-token',
        },
        body: JSON.stringify({ extensionId }),
      })
    ).json()
    const headers = {
      'Content-Type': 'application/json',
      'X-Novelist-Extension-Id': extensionId,
      Origin: `chrome-extension://${extensionId}`,
    }
    const connection = await (
      await fetch(`${origin}/api/extension/connect`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: approval.code }),
      })
    ).json()
    const authenticated = { ...headers, Authorization: `Bearer ${connection.token}` }
    const post = async (path: string, data: unknown) =>
      (
        await fetch(`${origin}/api/extension/${path}`, {
          method: 'POST',
          headers: authenticated,
          body: JSON.stringify(data),
        })
      ).json()
    const page = {
      url: 'https://books.example.test/#/chapter/1',
      html: '<h1>Chapter 1</h1><p>First rendered page.</p>',
    }
    const session = await post('navigation/start', {
      url: page.url,
      goal: 'samples',
      model: 'gpt-5-nano',
      confirmed: true,
    })
    const snapshot = {
      id: crypto.randomUUID(),
      url: page.url,
      title: 'Chapter 1',
      excerpt: 'First rendered page.',
      fingerprint: 'first',
      controls: [],
      linkCount: 0,
      chapterLinkCount: 0,
      chapterSamples: [],
      canScroll: false,
      blocked: false,
    }
    mocks.navigate.mockResolvedValue({
      decision: {
        action: 'finish',
        controlId: null,
        value: null,
        intent: 'inspect',
        pageType: 'chapter',
        repeat: false,
        reason: 'End of available content.',
      },
      model: 'gpt-5-nano',
      inputTokens: 10,
      outputTokens: 10,
    })
    for (let index = 0; index < 3; index++) {
      const job = await post('navigation/plan', { runId: session.id, snapshot, history: [] })
      await vi.waitFor(async () =>
        expect(
          (
            await (
              await fetch(`${origin}/api/extension/jobs/${job.id}`, { headers: authenticated })
            ).json()
          ).state,
        ).toBe('completed'),
      )
    }
    const exhausted = await post('navigation/plan', { runId: session.id, snapshot, history: [] })
    await vi.waitFor(async () =>
      expect(
        (
          await (
            await fetch(`${origin}/api/extension/jobs/${exhausted.id}`, { headers: authenticated })
          ).json()
        ).state,
      ).toBe('failed'),
    )
    expect(mocks.navigate).toHaveBeenCalledTimes(3)
    mocks.scrape.mockResolvedValue({
      report: { status: 'needs_review', attempts: [] },
      code: 'test-only',
    })
    const job = await post('test', {
      page,
      browserPages: [
        {
          url: 'https://books.example.test/#/chapter/2',
          html: '<h1>Chapter 2</h1><p>Second rendered page.</p>',
        },
      ],
      sampleUrls: [],
      rightsConfirmed: true,
      sendToModelConfirmed: true,
    })
    await vi.waitFor(async () =>
      expect(
        (
          await (
            await fetch(`${origin}/api/extension/jobs/${job.id}`, { headers: authenticated })
          ).json()
        ).state,
      ).toBe('completed'),
    )
    expect(mocks.sample).not.toHaveBeenCalled()
    expect(mocks.scrape.mock.calls[0][1].pages.map((entry: { url: string }) => entry.url)).toEqual([
      page.url,
      'https://books.example.test/#/chapter/2',
    ])
    const catalogJob = await post('test', {
      page: {
        url: 'https://www.novelupdates.com/series/fixture/',
        html: '<h1>A metadata catalog</h1><a href="/?p=12">Chapter 12</a>',
      },
      sampleUrls: [],
      rightsConfirmed: true,
      sendToModelConfirmed: true,
    })
    await vi.waitFor(async () =>
      expect(
        await (
          await fetch(`${origin}/api/extension/jobs/${catalogJob.id}`, { headers: authenticated })
        ).json(),
      ).toMatchObject({ state: 'failed', error: expect.stringContaining('metadata catalog') }),
    )
    expect(mocks.scrape).toHaveBeenCalledTimes(1)
    mocks.scrape.mockResolvedValueOnce({
      report: {
        status: 'needs_review',
        attempts: [{ checks: [{ passed: true, output: { kind: 'index', chapters: [] } }] }],
      },
      code: 'test-only',
    })
    const indexTest = await post('test', {
      page,
      sampleUrls: [],
      rightsConfirmed: true,
      sendToModelConfirmed: true,
      expectedKind: 'chapter',
    })
    await vi.waitFor(async () =>
      expect(
        await (
          await fetch(`${origin}/api/extension/jobs/${indexTest.id}`, { headers: authenticated })
        ).json(),
      ).toMatchObject({
        state: 'failed',
        error: expect.stringContaining('did not produce readable chapter text'),
      }),
    )
    expect(mocks.sample).not.toHaveBeenCalled()
  })

  it('samples only confirmed chapter links and reports partial failures', async () => {
    const origin = await startBridge()
    const extensionId = 'a'.repeat(32)
    mocks.authorize.mockResolvedValue({ ownerId: 'test-owner', release: () => undefined })
    const approval = await (
      await fetch(`${origin}/api/extension/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer private-library-token',
        },
        body: JSON.stringify({ extensionId }),
      })
    ).json()
    const headers = {
      'Content-Type': 'application/json',
      'X-Novelist-Extension-Id': extensionId,
      Origin: `chrome-extension://${extensionId}`,
    }
    const connection = await (
      await fetch(`${origin}/api/extension/connect`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: approval.code }),
      })
    ).json()
    const authenticated = { ...headers, Authorization: `Bearer ${connection.token}` }
    const input = {
      page: trainingFixtures[0].page,
      sampleUrls: [trainingFixtures[1].page.url],
      rightsConfirmed: true,
      sendToModelConfirmed: true,
    }
    expect(
      (
        await fetch(`${origin}/api/extension/test`, {
          method: 'POST',
          headers: authenticated,
          body: JSON.stringify({ ...input, rightsConfirmed: false }),
        })
      ).status,
    ).toBe(400)
    expect(mocks.sample).not.toHaveBeenCalled()
    expect(mocks.scrape).not.toHaveBeenCalled()
    mocks.sample.mockRejectedValueOnce(
      new Error('This link redirects. Open the destination manually.'),
    )
    mocks.scrape.mockResolvedValueOnce({
      code: 'test-only adapter',
      report: { status: 'needs_review', attempts: [] },
    })
    const job = await (
      await fetch(`${origin}/api/extension/test`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify(input),
      })
    ).json()
    await vi.waitFor(async () => {
      const result = await (
        await fetch(`${origin}/api/extension/jobs/${job.id}`, { headers: authenticated })
      ).json()
      expect(result.state).toBe('completed')
      expect(result.scrape.sampledPages).toEqual([
        { url: input.sampleUrls[0], error: 'This link redirects. Open the destination manually.' },
      ])
    })
    expect(mocks.sample).toHaveBeenCalledTimes(1)
    expect(mocks.scrape.mock.calls[0][1].pages).toHaveLength(1)
    const rejected = await (
      await fetch(`${origin}/api/extension/test`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify({ ...input, sampleUrls: ['https://untrusted.example/other'] }),
      })
    ).json()
    await vi.waitFor(async () => {
      const result = await (
        await fetch(`${origin}/api/extension/jobs/${rejected.id}`, { headers: authenticated })
      ).json()
      expect(result.state).toBe('failed')
    })
    expect(mocks.sample).toHaveBeenCalledTimes(1)
    expect(mocks.scrape).toHaveBeenCalledTimes(1)
    const direct = { ...input, fetchOnly: true, forceRegenerate: true, expectedKind: 'chapter' }
    mocks.sample.mockResolvedValueOnce(trainingFixtures[1].page)
    mocks.scrape.mockResolvedValueOnce({
      code: 'direct adapter',
      report: {
        status: 'needs_review',
        attempts: [{ checks: [{ passed: true, output: { kind: 'chapter' } }] }],
      },
    })
    const fetched = await (
      await fetch(`${origin}/api/extension/test`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify(direct),
      })
    ).json()
    await vi.waitFor(
      async () => {
        const result = await (
          await fetch(`${origin}/api/extension/jobs/${fetched.id}`, { headers: authenticated })
        ).json()
        expect(result.state).toBe('completed')
      },
      { timeout: 2000 },
    )
    expect(mocks.scrape.mock.lastCall?.[1]).toMatchObject({
      pages: [trainingFixtures[1].page],
      forceRegenerate: true,
      expectedKind: 'chapter',
    })
    for (const failure of ['HTTP 403', 'challenge']) {
      if (failure === 'challenge')
        mocks.sample.mockResolvedValueOnce({
          url: trainingFixtures[1].page.url,
          html: '<title>Just a moment</title><h1>Verify you are human</h1>',
        })
      else mocks.sample.mockRejectedValueOnce(new Error(failure))
      const failed = await (
        await fetch(`${origin}/api/extension/test`, {
          method: 'POST',
          headers: authenticated,
          body: JSON.stringify(direct),
        })
      ).json()
      await vi.waitFor(
        async () => {
          const result = await (
            await fetch(`${origin}/api/extension/jobs/${failed.id}`, { headers: authenticated })
          ).json()
          expect(result.state).toBe('failed')
          expect(result.error).toContain('No model request was made')
        },
        { timeout: 2000 },
      )
    }
    expect(mocks.scrape).toHaveBeenCalledTimes(2)
  })

  it('requires a local authenticated handshake, a bound token and consent before starting an AI job', async () => {
    const origin = await startBridge()
    const extensionId = 'a'.repeat(32)
    const headers = {
      'Content-Type': 'application/json',
      'X-Novelist-Extension-Id': extensionId,
      Origin: `chrome-extension://${extensionId}`,
    }
    mocks.authorize.mockResolvedValue({ ownerId: 'test-owner', release: () => undefined })
    const ready = await fetch(`${origin}/api/extension/ready`, { headers })
    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({ app: 'novelist', protocol: 1 })
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(
      (
        await fetch(`${origin}/api/extension/ready`, {
          headers: { ...headers, Origin: 'https://untrusted.example' },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(`${origin}/api/extension/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' },
          body: JSON.stringify({ extensionId }),
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(`${origin}/api/extension/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ extensionId }),
        })
      ).status,
    ).toBe(401)
    const approval = await (
      await fetch(`${origin}/api/extension/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          Authorization: 'Bearer private-library-token',
        },
        body: JSON.stringify({ extensionId }),
      })
    ).json()
    const connection = await (
      await fetch(`${origin}/api/extension/connect`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: approval.code }),
      })
    ).json()
    expect(JSON.stringify(connection)).not.toContain('private-library-token')
    const authenticated = { ...headers, Authorization: `Bearer ${connection.token}` }
    const estimate = await fetch(`${origin}/api/extension/estimate`, {
      method: 'POST',
      headers: authenticated,
      body: JSON.stringify({ page: trainingFixtures[0].page, outputLanguage: 'fr' }),
    })
    expect(estimate.status).toBe(200)
    expect(await estimate.json()).toMatchObject({
      basis: 'preflight',
      model: 'gpt-5-nano',
      outputTokens: 2000,
    })
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(
      (
        await fetch(`${origin}/api/extension/inspect`, {
          method: 'POST',
          headers: authenticated,
          body: JSON.stringify({ page: trainingFixtures[0].page, sendToModelConfirmed: false }),
        })
      ).status,
    ).toBe(400)
    expect(mocks.inspect).not.toHaveBeenCalled()
    mocks.inspect.mockResolvedValue({
      inspection: { classification: 'index', title: 'The River Ledger', chapterLinks: [] },
      model: 'test-only',
      inputTokens: 1,
      outputTokens: 1,
    })
    const accepted = await fetch(`${origin}/api/extension/inspect`, {
      method: 'POST',
      headers: authenticated,
      body: JSON.stringify({
        page: trainingFixtures[0].page,
        outputLanguage: 'fr',
        sendToModelConfirmed: true,
      }),
    })
    expect(accepted.status).toBe(202)
    const job = await accepted.json()
    await vi.waitFor(async () => {
      const result = await (
        await fetch(`${origin}/api/extension/jobs/${job.id}`, { headers: authenticated })
      ).json()
      expect(result.state).toBe('completed')
    })
    expect(mocks.scrape).not.toHaveBeenCalled()
    expect(mocks.inspect.mock.calls[0][0]).toBe('private-library-token')
    expect(mocks.inspect.mock.calls[0][1]).toMatchObject({ outputLanguage: 'fr' })
    expect(mocks.inspect.mock.calls[0][1]).not.toHaveProperty('sourceLanguage')
    expect(
      (
        await fetch(`${origin}/api/extension/jobs/${job.id}`, {
          headers: { ...authenticated, 'X-Novelist-Extension-Id': 'b'.repeat(32) },
        })
      ).status,
    ).toBe(403)
    await fetch(`${origin}/api/extension/connection`, { method: 'DELETE', headers: authenticated })
    expect((await fetch(`${origin}/api/extension/status`, { headers: authenticated })).status).toBe(
      401,
    )
  })
})
