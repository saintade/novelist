import { describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { publicPageUrl, scraperRequestSchema } from '../../src/lib/scraper/contracts'
import { trainingFixtures, heldOutFixtures } from './fixtures'
import { checkScrapedPage, prepareCapturedPage } from './validate'
import { generateScraper } from './generator'
import { captureCurrentPage } from '../../src/lib/scraper/capture'
import {
  inspectWithOpenAI,
  validateNovelInspection,
  identificationFailure,
  estimateIdentification,
} from '../extension/inspect'
import { identificationCost } from '../../src/lib/ai/pricing'
import { APIError } from 'openai'
import { inspectPageRequestSchema } from '../../src/lib/extension/contracts'
import { approvedSampleUrl } from '../extension/sample'

const { parseResponse } = vi.hoisted(() => ({ parseResponse: vi.fn() }))
vi.mock('openai', async (original) => ({
  ...(await original<typeof import('openai')>()),
  default: class {
    responses = { parse: parseResponse }
  },
}))

describe('scraper page contract', () => {
  it('preserves distinct SPA routes but discards ordinary section anchors', () => {
    expect(publicPageUrl('https://books.example.test/#/book/117659/')).toBe(
      'https://books.example.test/#/book/117659/',
    )
    expect(publicPageUrl('https://books.example.test/#!/chapter/2?page=1')).toBe(
      'https://books.example.test/#!/chapter/2?page=1',
    )
    expect(publicPageUrl('https://books.example.test/book#summary')).toBe(
      'https://books.example.test/book',
    )
    expect(() => publicPageUrl('https://books.example.test/#/chapter?token=secret')).toThrow(
      'credentials',
    )
    expect(() => publicPageUrl('https://books.example.test/#//untrusted.example/chapter')).toThrow()
    const pages = [1, 2].map((number) => ({
      url: `https://books.example.test/#/chapter/${number}`,
      html: `<h1>Chapter ${number}</h1>`,
    }))
    expect(
      scraperRequestSchema.safeParse({ pages, rightsConfirmed: true, sendToModelConfirmed: true })
        .success,
    ).toBe(true)
    expect(() => approvedSampleUrl(pages[0], pages[1].url)).toThrow('browser navigation')
  })
  it('removes form values, scripts, comments, and secret attributes before model submission', () => {
    const page = {
      url: trainingFixtures[0].page.url,
      html: '<!doctype html><html><body><script>const secret = "SCRIPT_SECRET";</script><!-- COMMENT_SECRET --><form><input value="FORM_SECRET" /></form><main data-token="ATTRIBUTE_SECRET" onclick="EVENT_SECRET"><h1>River Ledger</h1><p>A readable paragraph.</p><a href="/chapter/1">Chapter one</a><a href="/account?token=URL_SECRET">Account</a></main></body></html>',
    }
    const dom = new JSDOM(page.html, { url: page.url })
    for (const captured of [captureCurrentPage(dom.window.document), prepareCapturedPage(page)]) {
      expect(captured.html).not.toContain('SECRET')
      expect(captured.html).toContain('A readable paragraph.')
      expect(captured.html).toContain('href="/chapter/1"')
    }
    dom.window.close()
  })
  it('preserves safe cover-image and lazy-image URLs without retaining unsafe sources', () => {
    const page = {
      url: trainingFixtures[0].page.url,
      html: '<html><body><img src="/cover.jpg"><img src="data:image/gif,placeholder" data-src="https://images.example.com/book.jpg"><img src="http://127.0.0.1/private"><iframe src="https://example.com/private"></iframe></body></html>',
    }
    const dom = new JSDOM(page.html, { url: page.url })
    for (const capture of [captureCurrentPage(dom.window.document), prepareCapturedPage(page)]) {
      expect(capture.html).toContain('src="https://books.example.test/cover.jpg"')
      expect(capture.html).toContain('src="https://images.example.com/book.jpg"')
      expect(capture.html).not.toContain('127.0.0.1')
      expect(capture.html).not.toContain('iframe')
    }
    dom.window.close()
  })
  it('accepts reviewed original index, chapter and split-page fixtures', () => {
    for (const fixture of [...trainingFixtures, ...heldOutFixtures])
      expect(checkScrapedPage(fixture.expected, fixture.page, fixture.expected).issues).toEqual([])
  })
  it('rejects invented content, omitted paragraphs and off-origin navigation', () => {
    const fixture = trainingFixtures[1]
    if (fixture.expected.kind !== 'chapter') throw new Error('Invalid test fixture')
    expect(
      checkScrapedPage({ ...fixture.expected, paragraphs: ['An invented scene.'] }, fixture.page)
        .passed,
    ).toBe(false)
    expect(
      checkScrapedPage(
        { ...fixture.expected, paragraphs: fixture.expected.paragraphs.slice(0, 1) },
        fixture.page,
        fixture.expected,
      ).passed,
    ).toBe(false)
    expect(
      checkScrapedPage(
        { ...fixture.expected, nextChapterUrl: 'https://evil.example/path' },
        fixture.page,
      ).passed,
    ).toBe(false)
  })
  it('requires explicit model consent and one public origin without secret URL fields', () => {
    const request = {
      pages: trainingFixtures.map((fixture) => fixture.page),
      rightsConfirmed: true,
      sendToModelConfirmed: true,
    }
    expect(scraperRequestSchema.safeParse(request).success).toBe(true)
    expect(
      scraperRequestSchema.safeParse({ ...request, sendToModelConfirmed: false }).success,
    ).toBe(false)
    for (const url of [
      'http://127.0.0.1:55321/',
      'http://169.254.169.254/latest/',
      'https://user:secret@example.com/',
      'https://example.com/?token=secret',
    ])
      expect(
        scraperRequestSchema.safeParse({
          ...request,
          pages: [{ ...trainingFixtures[0].page, url }],
        }).success,
      ).toBe(false)
    expect(
      scraperRequestSchema.safeParse({
        ...request,
        pages: [
          trainingFixtures[0].page,
          { ...trainingFixtures[1].page, url: 'https://other.example/chapter' },
        ],
      }).success,
    ).toBe(false)
  })
})

describe('novel page identification', () => {
  it('distinguishes model access and key failures without exposing provider secrets', () => {
    const unavailable = new APIError(
      404,
      { code: 'model_not_found', message: 'private provider detail' },
      'private provider detail',
      undefined,
    )
    expect(identificationFailure(unavailable).message).toContain('OPENAI_IDENTIFICATION_MODEL')
    const rejectedKey = new APIError(
      401,
      { message: 'Incorrect API key: sk-private-test' },
      'sk-private-test',
      undefined,
    )
    expect(identificationFailure(rejectedKey).message).toContain('OPENAI_API_KEY')
    expect(identificationFailure(rejectedKey).message).not.toContain('sk-private-test')
    expect(identificationFailure(new Error('untrusted input or secret')).message).not.toContain(
      'untrusted input or secret',
    )
  })
  const page = trainingFixtures[0].page
  const inspection = {
    classification: 'index',
    title: 'The River Ledger',
    originalTitle: null,
    author: 'N. Vale',
    originalAuthor: null,
    language: 'en',
    synopses: [
      { label: 'Synopsis', text: 'Two clerks mend a damaged ferry ledger.', originalText: null },
    ],
    coverImage: null,
    genres: [],
    tags: [],
    publicationStatus: null,
    chapterCount: null,
    wordCount: null,
    updatedAt: null,
    additionalMetadata: [],
    reason: 'A novel heading and chapter index are present.',
    chapterLinks: [{ title: '1. The Rain', url: 'https://books.example.test/river-ledger/1' }],
    indexUrl: null,
  }
  it('identifies a novel with grounded metadata without generating or scraping', async () => {
    parseResponse.mockResolvedValueOnce({
      status: 'completed',
      output_parsed: inspection,
      usage: { input_tokens: 150, output_tokens: 100 },
    })
    const result = await inspectWithOpenAI(page, { apiKey: 'test-only', model: 'inspection-model' })
    expect(result.inspection).toEqual(inspection)
    expect(result.inputTokens).toBe(150)
    expect(parseResponse.mock.lastCall![0]).toMatchObject({
      store: false,
      max_output_tokens: 6000,
      model: 'inspection-model',
    })
    expect(JSON.parse(parseResponse.mock.lastCall![0].input[1].content)).toMatchObject({
      detectSourceLanguage: true,
      outputLanguage: 'en',
    })
  })
  it('defaults output to English while recording the independently detected page language', async () => {
    expect(
      inspectPageRequestSchema.parse({ page, sendToModelConfirmed: true }).outputLanguage,
    ).toBe('en')
    expect(
      inspectPageRequestSchema.safeParse({
        page,
        outputLanguage: 'invalid',
        sendToModelConfirmed: true,
      }).success,
    ).toBe(false)
    expect(
      inspectPageRequestSchema.safeParse({ page, sourceLanguage: 'en', sendToModelConfirmed: true })
        .success,
    ).toBe(false)
    parseResponse.mockResolvedValueOnce({ status: 'completed', output_parsed: inspection })
    const result = await inspectWithOpenAI(page, {
      apiKey: 'test-only',
      model: 'inspection-model',
      outputLanguage: 'fr',
    })
    expect(JSON.parse(parseResponse.mock.lastCall![0].input[1].content)).toMatchObject({
      detectSourceLanguage: true,
      outputLanguage: 'fr',
    })
    expect(result).toMatchObject({ sourceLanguage: 'en', outputLanguage: 'fr' })
  })
  it('accepts an explicit analysis model without changing the configured default or language', () => {
    const input = inspectPageRequestSchema.parse({
      page,
      model: 'gpt-4.1-mini',
      outputLanguage: 'en',
      sendToModelConfirmed: true,
    })
    expect(input.model).toBe('gpt-4.1-mini')
    expect(
      inspectPageRequestSchema.parse({ page, sendToModelConfirmed: true }).model,
    ).toBeUndefined()
    expect(
      inspectPageRequestSchema.safeParse({
        page,
        model: 'unapproved-model',
        sendToModelConfirmed: true,
      }).success,
    ).toBe(false)
  })
  it('uses compatible low-cost model settings and retains cache/reasoning usage without double charging', async () => {
    parseResponse.mockResolvedValueOnce({
      status: 'completed',
      output_parsed: inspection,
      usage: {
        input_tokens: 10_000,
        output_tokens: 2000,
        input_tokens_details: { cached_tokens: 2000 },
        output_tokens_details: { reasoning_tokens: 500 },
      },
    })
    const result = await inspectWithOpenAI(page, { apiKey: 'test-only', model: 'gpt-5-nano' })
    expect(parseResponse.mock.lastCall![0]).toMatchObject({
      reasoning: { effort: 'minimal' },
      service_tier: 'default',
    })
    expect(result.cost?.estimatedUsd).toBeCloseTo(0.00121, 8)
    expect(result.cost?.reasoningTokens).toBe(500)
    parseResponse.mockResolvedValueOnce({ status: 'completed', output_parsed: inspection })
    const noUsage = await inspectWithOpenAI(page, { apiKey: 'test-only', model: 'gpt-4.1-nano' })
    expect(parseResponse.mock.lastCall![0].reasoning).toBeUndefined()
    expect(noUsage.cost?.estimatedUsd).toBeNull()
  })
  it('estimates multilingual prompt tokens locally and labels model comparisons as estimates', () => {
    const estimate = estimateIdentification(page, 'en')
    expect(estimate).toMatchObject({
      basis: 'preflight',
      capturedCharacters: page.html.length,
      model: 'gpt-5-nano',
      outputTokens: 2000,
    })
    expect(estimate.inputTokens).toBeGreaterThan(200)
    expect(estimate.comparisons).toHaveLength(8)
    expect(
      identificationCost(
        'unpriced-model',
        { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, reasoningTokens: 0 },
        { basis: 'reported-usage', capturedCharacters: 100 },
      ).estimatedUsd,
    ).toBeNull()
  })
  it('accepts model-provided metadata while excluding off-page navigation', () => {
    expect(
      validateNovelInspection(
        { ...inspection, author: 'An English pen name', title: 'The Ferry Register' },
        page,
      ).author,
    ).toBe('An English pen name')
    expect(
      validateNovelInspection(
        {
          ...inspection,
          chapterLinks: [{ title: '1. The Rain', url: 'https://untrusted.example/1' }],
        },
        page,
      ).chapterLinks,
    ).toEqual([])
    expect(
      validateNovelInspection(
        {
          ...inspection,
          chapterLinks: [{ title: 'Another title', url: inspection.chapterLinks[0].url }],
        },
        page,
      ).chapterLinks[0].title,
    ).toBe('Another title')
  })
  it('keeps readable translated labels when source links include adjacent dates', () => {
    const datedPage = {
      ...page,
      html: page.html.replace(
        '>1. The Rain</a>',
        '><span>1. The Rain</span><span>2025-10-03</span></a>',
      ),
    }
    const result = validateNovelInspection(inspection, datedPage)
    expect(result.chapterLinks).toEqual([
      { title: '1. The Rain', url: inspection.chapterLinks[0].url },
    ])
  })
  it('allows uncertain pages and does not force every page to be a novel', () => {
    expect(
      validateNovelInspection(
        {
          ...inspection,
          classification: 'uncertain',
          title: null,
          author: null,
          synopses: [],
          chapterLinks: [],
          reason: 'No clear novel body is visible.',
        },
        page,
      ).classification,
    ).toBe('uncertain')
  })
  it('retains alternate synopses, original metadata and image URLs in the extraction JSON', async () => {
    const output = {
      ...inspection,
      originalTitle: '\u6cb3\u7554\u8d26\u518c',
      synopses: [
        ...inspection.synopses,
        {
          label: 'Alternate introduction',
          text: 'A missing page leads them to the river.',
          originalText: '\u4e00\u9875\u7f3a\u5931\u7684\u8d26\u518c',
        },
      ],
      coverImage: { url: '/cover.jpg', alt: 'The River Ledger cover' },
      additionalMetadata: [
        { field: 'Publisher', value: 'River Press', originalField: null, originalValue: null },
      ],
    }
    parseResponse.mockResolvedValueOnce({ status: 'completed', output_parsed: output })
    const result = await inspectWithOpenAI(page, { apiKey: 'test-only', model: 'inspection-model' })
    expect(result.rawExtraction).toEqual(output)
    expect(result.inspection.synopses).toHaveLength(2)
    expect(result.inspection.coverImage?.url).toBe('https://books.example.test/cover.jpg')
    expect(result.inspection.additionalMetadata[0].value).toBe('River Press')
    expect(result).toMatchObject({ schemaVersion: 3, sourceLanguage: 'en', outputLanguage: 'en' })
    expect(
      validateNovelInspection(
        { ...output, coverImage: { url: 'http://127.0.0.1/secret', alt: '' } },
        page,
      ).coverImage,
    ).toBeNull()
  })
})

describe('scraper generation contract', () => {
  it('requests real adapter code with supplied HTML and bounded output', async () => {
    const adapter = {
      code: 'export default () => ({ kind: "blocked", reason: "No chapter body" })',
      explanation: 'A parser module.',
      limitations: ['Needs review.'],
    }
    parseResponse.mockResolvedValueOnce({
      status: 'completed',
      output_parsed: adapter,
      usage: { input_tokens: 300, output_tokens: 100 },
    })
    const context = { pages: trainingFixtures.map((fixture) => fixture.page) }
    const result = await generateScraper(context, { model: 'test-model', apiKey: 'test-only' })
    expect(result).toEqual({ adapter, inputTokens: 300, outputTokens: 100 })
    const request = parseResponse.mock.lastCall![0]
    expect(request).toMatchObject({ model: 'test-model', store: false, max_output_tokens: 6000 })
    expect(JSON.parse(request.input[1].content).pages).toEqual(context.pages)
    expect(request.input[1].content).not.toContain('At the crossing, Tomas')
  })
  it('does not treat incomplete provider output as a scraper', async () => {
    parseResponse.mockResolvedValueOnce({ status: 'incomplete', output_parsed: null })
    await expect(
      generateScraper(
        { pages: [trainingFixtures[0].page] },
        { model: 'test-model', apiKey: 'test-only' },
      ),
    ).rejects.toThrow('complete scraper')
  })
})
