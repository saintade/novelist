import { describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureAdapterCode } from './fixture-adapter'
import { heldOutFixtures, trainingFixtures } from './fixtures'
import { runAdapter, sandboxImageId } from './sandbox'
import { checkScrapedPage } from './validate'
import { runScraperExperiment } from './experiment'
import type { GenerationContext } from './generator'
import { runScraperTool } from './tool'
import { findSiteScraper } from './cache'
import { createHash } from 'node:crypto'

const { parseResponse } = vi.hoisted(() => ({ parseResponse: vi.fn() }))
vi.mock('openai', () => ({
  default: class {
    responses = { parse: parseResponse }
  },
}))

describe.runIf(process.env.RUN_SCRAPER_TESTS === '1')('isolated scraper execution', () => {
  it('runs real JavaScript against original index, chapter and pagination fixtures', async () => {
    expect(await sandboxImageId()).toMatch(/^sha256:/)
    for (const fixture of [...trainingFixtures, ...heldOutFixtures]) {
      const output = await runAdapter(fixtureAdapterCode, fixture.page)
      expect(checkScrapedPage(output, fixture.page, fixture.expected).issues).toEqual([])
    }
  }, 30_000)

  it('runs unprivileged without host credentials, root writes, or external networking', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'host-only-test-secret')
    try {
      const output = await runAdapter(
        `export default async function () {
      const filesystem = await import('node:fs/promises');
      let rootWritable = false;
      let networkReachable = false;
      try { await filesystem.writeFile('/app/probe.txt', 'test'); rootWritable = true; } catch {}
      try { await fetch('http://1.1.1.1/', { signal: AbortSignal.timeout(250) }); networkReachable = true; } catch {}
      return { uid: process.getuid(), rootWritable, networkReachable,
        hasKey: Boolean(process.env.OPENAI_API_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY),
        noNewPrivileges: (await filesystem.readFile('/proc/self/status', 'utf8')).includes('NoNewPrivs:\\t1') };
    }`,
        trainingFixtures[0].page,
      )
      expect(output).toEqual({
        uid: 1000,
        rootWritable: false,
        networkReachable: false,
        hasKey: false,
        noNewPrivileges: true,
      })
    } finally {
      vi.unstubAllEnvs()
    }
  }, 10_000)

  it('terminates a non-returning adapter instead of blocking the host', async () => {
    await expect(
      runAdapter('export default function () { while (true) {} }', trainingFixtures[0].page),
    ).rejects.toThrow('limit')
  }, 15_000)

  it('rejects output flooding', async () => {
    await expect(
      runAdapter(
        'export default function () { process.stdout.write("x".repeat(700000)); return {}; }',
        trainingFixtures[0].page,
      ),
    ).rejects.toThrow()
  }, 10_000)

  it('repairs failed training output, persists code, and never sends held-out pages to generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'novelist-scraper-test-'))
    const requests: GenerationContext[] = []
    try {
      const result = await runScraperExperiment({
        training: trainingFixtures,
        heldOut: heldOutFixtures,
        artifactRoot: root,
        mode: 'fixture',
        model: null,
        generate: async (request) => {
          requests.push(request)
          return {
            adapter: {
              code: request.previous ? fixtureAdapterCode : 'export default () => ({})',
              explanation: 'Scripted fixture, not an AI generation result.',
              limitations: [],
            },
            inputTokens: 0,
            outputTokens: 0,
          }
        },
      })
      expect(result.report.status).toBe('needs_review')
      expect(result.report.attempts).toHaveLength(2)
      expect(result.report.heldOut).toHaveLength(3)
      expect(result.report.heldOut.every((check) => check.passed)).toBe(true)
      expect(result.report.inputTokens).toBe(0)
      expect(requests[1].previous?.failures).toHaveLength(2)
      expect(JSON.stringify(requests)).not.toContain('At the crossing, Tomas')
      expect(await readFile(join(result.artifactDirectory, 'attempt-2.mjs'), 'utf8')).toBe(
        fixtureAdapterCode,
      )
      expect(
        JSON.parse(await readFile(join(result.artifactDirectory, 'report.json'), 'utf8')).status,
      ).toBe('needs_review')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('stops at three generation attempts instead of retrying indefinitely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'novelist-scraper-budget-'))
    let requests = 0
    try {
      const result = await runScraperExperiment({
        training: [trainingFixtures[0]],
        artifactRoot: root,
        mode: 'fixture',
        model: null,
        generate: async () => {
          requests++
          return {
            adapter: {
              code: 'export default () => ({})',
              explanation: 'Invalid test output.',
              limitations: [],
            },
            inputTokens: 0,
            outputTokens: 0,
          }
        },
      })
      expect(requests).toBe(3)
      expect(result.report.status).toBe('failed')
      expect(result.report.heldOut).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)

  it('flags a held-out layout change without using it as repair feedback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'novelist-scraper-layout-'))
    let requests = 0
    try {
      const result = await runScraperExperiment({
        training: trainingFixtures,
        heldOut: heldOutFixtures,
        artifactRoot: root,
        mode: 'fixture',
        model: null,
        generate: async () => {
          requests++
          return {
            adapter: {
              code: fixtureAdapterCode.replace("'#reader-text'", "'.missing-reader'"),
              explanation: 'Adapter deliberately limited to the training layout.',
              limitations: [],
            },
            inputTokens: 0,
            outputTokens: 0,
          }
        },
      })
      expect(result.report.attempts[0].checks.every((check) => check.passed)).toBe(true)
      expect(result.report.status).toBe('failed')
      expect(result.report.heldOut.some((check) => !check.passed)).toBe(true)
      expect(requests).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)

  it.runIf(process.env.RUN_SUPABASE_TESTS === '1')(
    'authenticates the plugin-facing tool and stores sanitized owner-scoped artifacts',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'novelist-scraper-tool-'))
      const client = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } },
      )
      const signedIn = await client.auth.signInAnonymously()
      expect(signedIn.error).toBeNull()
      const token = signedIn.data.session!.access_token
      const configuration = {
        root,
        supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
        publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        apiKey: 'test-only',
        model: 'test-only',
        scraperModel: 'scraper-test-only',
        liveEnabled: true,
      }
      const request = {
        pages: trainingFixtures.map((fixture) => ({
          ...fixture.page,
          html: fixture.page.html.replace(
            '</body>',
            '<form><input value="PRIVATE_SECRET" /></form></body>',
          ),
        })),
        rightsConfirmed: true,
        sendToModelConfirmed: true,
      }
      try {
        await expect(
          runScraperTool(token, request, { ...configuration, liveEnabled: false }),
        ).rejects.toMatchObject({ status: 403 })
        await expect(
          runScraperTool('invalid-session', request, configuration),
        ).rejects.toMatchObject({ status: 401 })
        await expect(
          runScraperTool(token, { ...request, sendToModelConfirmed: false }, configuration),
        ).rejects.toThrow()
        parseResponse.mockResolvedValueOnce({
          status: 'completed',
          output_parsed: {
            code: fixtureAdapterCode,
            explanation: 'Mock provider adapter.',
            limitations: ['Test only.'],
          },
          usage: { input_tokens: 12, output_tokens: 34 },
        })
        const result = await runScraperTool(token, request, configuration)
        expect(result.code).toBe(fixtureAdapterCode)
        expect(result.report.status).toBe('needs_review')
        expect(result.report.heldOut).toEqual([])
        expect(result.report).toMatchObject({
          inputTokens: 12,
          outputTokens: 34,
          model: 'scraper-test-only',
        })
        expect(JSON.stringify(parseResponse.mock.lastCall)).not.toContain('PRIVATE_SECRET')
        const captures = await readFile(
          join(
            root,
            '.novelist',
            'scraper',
            signedIn.data.user!.id,
            result.report.id,
            'captures.json',
          ),
          'utf8',
        )
        expect(captures).not.toContain('PRIVATE_SECRET')
        const providerCalls = parseResponse.mock.calls.length
        const chapterRequest = {
          ...request,
          pages: [
            { ...heldOutFixtures[0].page, url: 'https://books.example.test/another-novel/1' },
          ],
          expectedKind: 'chapter',
        }
        const reused = await runScraperTool(token, chapterRequest, {
          ...configuration,
          apiKey: '',
          liveEnabled: false,
        })
        expect(reused.report).toMatchObject({
          status: 'needs_review',
          mode: 'provided-code',
          model: null,
          inputTokens: 0,
          outputTokens: 0,
          adapter: { strategy: 'reused', origin: new URL(chapterRequest.pages[0].url).origin },
        })
        expect(parseResponse).toHaveBeenCalledTimes(providerCalls)
        const records = await client.from('site_scrapers').select('origin,page_kind,code_hash')
        expect(records.error).toBeNull()
        expect(records.data?.map((row) => row.page_kind).sort()).toEqual(['chapter', 'index'])
        const artifactRoot = join(root, '.novelist', 'scraper', signedIn.data.user!.id)
        expect(
          await findSiteScraper(client, 'https://unrelated.example.test', 'chapter', artifactRoot),
        ).toBeNull()
        const outsider = createClient(configuration.supabaseUrl, configuration.publishableKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
        await outsider.auth.signInAnonymously()
        expect((await outsider.from('site_scrapers').select('*')).data).toEqual([])
        await outsider.auth.signOut()
        await client.from('site_scrapers').delete().eq('page_kind', 'chapter')
        const recovered = await runScraperTool(token, chapterRequest, {
          ...configuration,
          liveEnabled: false,
        })
        expect(recovered.report.adapter?.strategy).toBe('reused')
        expect(parseResponse).toHaveBeenCalledTimes(providerCalls)
        const staleCode = 'export default () => ({})'
        await client
          .from('site_scrapers')
          .update({
            code: staleCode,
            code_hash: createHash('sha256').update(staleCode).digest('hex'),
          })
          .eq('page_kind', 'chapter')
        parseResponse.mockResolvedValueOnce({
          status: 'completed',
          output_parsed: {
            code: fixtureAdapterCode,
            explanation: 'Repair the changed layout.',
            limitations: [],
          },
          usage: { input_tokens: 8, output_tokens: 12 },
        })
        const repaired = await runScraperTool(token, chapterRequest, configuration)
        expect(repaired.report).toMatchObject({
          status: 'needs_review',
          adapter: { strategy: 'repaired' },
          inputTokens: 8,
          outputTokens: 12,
        })
        expect(parseResponse).toHaveBeenCalledTimes(providerCalls + 1)
        expect(JSON.stringify(parseResponse.mock.lastCall)).toContain(staleCode)
        expect(JSON.stringify(parseResponse.mock.lastCall)).toContain('failures')
        await expect(
          runScraperTool(token, { ...chapterRequest, forceRegenerate: true }, configuration, false),
        ).rejects.toMatchObject({ status: 402 })
        expect(parseResponse).toHaveBeenCalledTimes(providerCalls + 1)
        parseResponse.mockResolvedValueOnce({
          status: 'completed',
          output_parsed: {
            code: fixtureAdapterCode,
            explanation: 'Fresh extraction.',
            limitations: [],
          },
        })
        const rebuilt = await runScraperTool(
          token,
          { ...chapterRequest, forceRegenerate: true },
          configuration,
        )
        expect(rebuilt.report.adapter?.strategy).toBe('generated')
        expect(parseResponse).toHaveBeenCalledTimes(providerCalls + 2)
        parseResponse.mockRejectedValue(new Error('Provider unavailable'))
        const failed = await runScraperTool(
          token,
          { ...chapterRequest, forceRegenerate: true },
          configuration,
        )
        expect(failed.report.status).toBe('failed')
        expect(
          await findSiteScraper(client, 'https://books.example.test', 'chapter', artifactRoot),
        ).toBe(fixtureAdapterCode)
      } finally {
        await client.from('site_scrapers').delete().eq('owner_id', signedIn.data.user!.id)
        await client.auth.signOut()
        await rm(root, { recursive: true, force: true })
      }
    },
    40_000,
  )
})
