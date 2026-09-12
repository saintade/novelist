import { z } from 'zod'

export const SCRAPER_CONTRACT_VERSION = 'book-pages-v1'
export const MAX_CAPTURE_CHARACTERS = 80_000
export const MAX_TOTAL_CAPTURE_CHARACTERS = 160_000

export function publicPageUrl(value: string): string {
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase()
  const route = /^#!?\//.test(url.hash)
    ? new URL(url.hash.replace(/^#!/, '').replace(/^#/, ''), url.origin)
    : null
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !hostname.includes('.') ||
    /^[\d.]+$/.test(hostname) ||
    hostname.includes(':') ||
    /(?:^|\.)(?:localhost|local|internal)$/.test(hostname) ||
    (route !== null && route.origin !== url.origin) ||
    [...url.searchParams.keys(), ...(route?.searchParams.keys() ?? [])].some((key) =>
      /^(?:access_token|token|api_?key|password|secret|session|signature|authorization)$/i.test(
        key,
      ),
    )
  )
    throw new Error('Use a public HTTP(S) page URL without credentials or secret query parameters.')
  if (!route) url.hash = ''
  return url.href
}

const pageUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      publicPageUrl(value)
      return true
    } catch {
      return false
    }
  }, 'Use a public HTTP(S) page URL without credentials.')

export const capturedPageSchema = z
  .object({
    url: pageUrlSchema,
    html: z.string().min(1).max(MAX_CAPTURE_CHARACTERS),
  })
  .strict()
export type CapturedPage = z.infer<typeof capturedPageSchema>

export const scraperRequestSchema = z
  .object({
    pages: z.array(capturedPageSchema).min(1).max(3),
    expectedKind: z.enum(['chapter', 'index']).optional(),
    forceRegenerate: z.boolean().default(false),
    rightsConfirmed: z.literal(true),
    sendToModelConfirmed: z.literal(true),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.pages.reduce((total, page) => total + page.html.length, 0) >
      MAX_TOTAL_CAPTURE_CHARACTERS
    )
      context.addIssue({
        code: 'custom',
        message: 'Captured pages exceed the 160,000 character budget.',
      })
    let urls: string[]
    try {
      urls = request.pages.map((page) => publicPageUrl(page.url))
    } catch {
      return
    }
    if (new Set(urls.map((url) => new URL(url).origin)).size !== 1)
      context.addIssue({ code: 'custom', message: 'Use pages from a single origin per scraper.' })
    if (new Set(urls).size !== request.pages.length)
      context.addIssue({ code: 'custom', message: 'Each captured page URL must be distinct.' })
  })
export type ScraperRequest = z.infer<typeof scraperRequestSchema>

const titleSchema = z.string().min(1).max(500)
const chapterLinkSchema = z
  .object({ title: titleSchema, url: z.string().min(1).max(2048) })
  .strict()
export const scrapedPageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('index'),
      title: titleSchema,
      author: z.string().min(1).max(300).nullable(),
      language: z.string().min(1).max(35).nullable(),
      synopsis: z.string().min(1).max(10_000).nullable(),
      chapters: z.array(chapterLinkSchema).min(1).max(3000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('chapter'),
      title: titleSchema,
      contentSelector: z.string().min(1).max(300),
      paragraphs: z.array(z.string().min(1).max(10_000)).min(1).max(2000),
      nextPageUrl: z.string().min(1).max(2048).nullable(),
      nextChapterUrl: z.string().min(1).max(2048).nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('blocked'), reason: z.string().min(1).max(500) }).strict(),
])
export type ScrapedPage = z.infer<typeof scrapedPageSchema>

export const scraperCodeSchema = z.object({
  code: z.string().min(1).max(24_000),
  explanation: z.string().min(1).max(1000),
  limitations: z.array(z.string().max(500)).max(8),
})
export type ScraperCode = z.infer<typeof scraperCodeSchema>

export interface PageCheck {
  url: string
  passed: boolean
  issues: string[]
  output?: ScrapedPage
}

export interface ScraperReport {
  id: string
  mode: 'live' | 'fixture' | 'provided-code'
  model: string | null
  contractVersion: string
  promptVersion: string
  sandboxImage: string
  createdAt: string
  status: 'failed' | 'blocked' | 'needs_review'
  sourceHashes: { url: string; hash: string }[]
  attempts: {
    number: number
    codeHash?: string
    checks: PageCheck[]
    inputTokens: number
    outputTokens: number
    error?: string
  }[]
  heldOut: PageCheck[]
  inputTokens: number
  outputTokens: number
  durationMs: number
  note: string
  adapter?: { origin: string; codeHash: string; strategy: 'generated' | 'reused' | 'repaired' }
  persistenceWarning?: string
}

export interface ScraperToolResult {
  report: ScraperReport
  code: string | null
}
