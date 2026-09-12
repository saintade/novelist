import { z } from 'zod'
import type { NavigationPlanResult } from './navigation.ts'
import type { LibraryMatches } from './library-catalog.ts'
import { metadataReferenceSchema, type MetadataReferenceSummary } from './metadata.ts'
import type { IdentificationCost } from '../ai/pricing.ts'
import { textModelPrices } from '../ai/pricing.ts'
import {
  capturedPageSchema,
  type CapturedPage,
  type ScraperToolResult,
} from '../scraper/contracts.ts'

export const extensionIdSchema = z.string().regex(/^[a-p]{32}$/)
export const novelIdSchema = z.guid()
export const extensionConnectNonceSchema = z.string().uuid()
export const extensionConnectMessageSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('novelist-connect-ready'), nonce: extensionConnectNonceSchema })
    .strict(),
  z
    .object({
      type: z.literal('novelist-pair'),
      nonce: extensionConnectNonceSchema,
      code: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
])
export type ExtensionConnectMessage = z.infer<typeof extensionConnectMessageSchema>
export const analysisModelSchema = z.enum(textModelPrices.map((price) => price.model))
export type AnalysisModel = z.infer<typeof analysisModelSchema>
export const outputLanguageSchema = z.enum([
  'en',
  'zh',
  'ja',
  'ko',
  'es',
  'fr',
  'de',
  'pt',
  'ru',
  'vi',
])
export type OutputLanguage = z.infer<typeof outputLanguageSchema>
export const outputLanguages: { value: OutputLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ru', label: 'Russian' },
  { value: 'vi', label: 'Vietnamese' },
]
export const translatedVersionSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    language: outputLanguageSchema,
    url: capturedPageSchema.shape.url,
  })
  .strict()
export type TranslatedVersion = z.infer<typeof translatedVersionSchema>
export const inspectPageRequestSchema = z
  .object({
    page: capturedPageSchema,
    outputLanguage: outputLanguageSchema.default('en'),
    model: analysisModelSchema.optional(),
    referenceVersions: z.array(translatedVersionSchema).max(5).default([]),
    metadataReference: metadataReferenceSchema.optional(),
    sendToModelConfirmed: z.literal(true),
  })
  .strict()
export const estimatePageRequestSchema = inspectPageRequestSchema.omit({
  sendToModelConfirmed: true,
})

export const novelInspectionSchema = z
  .object({
    classification: z.enum(['index', 'chapter', 'catalog', 'other', 'uncertain', 'blocked']),
    title: z.string().min(1).max(500).nullable(),
    originalTitle: z.string().max(500).nullable(),
    author: z.string().min(1).max(300).nullable(),
    originalAuthor: z.string().max(300).nullable(),
    language: z.string().min(1).max(35).nullable(),
    synopses: z
      .array(
        z
          .object({
            label: z.string().min(1).max(120),
            text: z.string().min(1).max(6000),
            originalText: z.string().max(6000).nullable(),
          })
          .strict(),
      )
      .max(8),
    coverImage: z
      .object({ url: z.string().min(1).max(2048), alt: z.string().max(300) })
      .strict()
      .nullable(),
    genres: z.array(z.string().max(120)).max(12),
    tags: z.array(z.string().max(120)).max(30),
    publicationStatus: z.string().max(160).nullable(),
    chapterCount: z.number().int().min(0).nullable(),
    wordCount: z.number().int().min(0).nullable(),
    updatedAt: z.string().max(160).nullable(),
    additionalMetadata: z
      .array(
        z
          .object({
            field: z.string().min(1).max(120),
            value: z
              .union([
                z.string().max(3000),
                z.number(),
                z.boolean(),
                z.array(z.string().max(500)).max(30),
              ])
              .nullable(),
            originalField: z.string().max(120).nullable(),
            originalValue: z.string().max(3000).nullable(),
          })
          .strict(),
      )
      .max(40),
    reason: z.string().min(1).max(800),
    chapterLinks: z
      .array(z.object({ title: z.string().min(1).max(500), url: z.string().max(2048) }).strict())
      .max(40),
    indexUrl: z.string().max(2048).nullable(),
  })
  .strict()
export type NovelInspection = z.infer<typeof novelInspectionSchema>

export const CONTENTS_LINK_LIMIT = 20_000
export const CONTENTS_CHARACTER_LIMIT = 1_500_000

export const contentsCaptureSchema = z
  .object({
    url: z.string().url().max(2048),
    title: z.string().max(500),
    links: z
      .array(z.object({ title: z.string().max(500), url: z.string().max(2048) }).strict())
      .max(CONTENTS_LINK_LIMIT),
    truncated: z.boolean(),
  })
  .strict()
export type ContentsCapture = z.infer<typeof contentsCaptureSchema>

export interface ContentsDiscovery {
  url: string
  foundCount: number
  numberedCount: number
  reportedCount: number | null
  pageOrder: 'oldest-first' | 'newest-first' | 'mixed' | 'unknown'
  chapters: { url: string; title: string; sourceTitle: string; number: number | null }[]
  nextContentsUrls: string[]
  truncated: boolean
}

export const catalogMetadataSchema = z.object({
  inspection: novelInspectionSchema.strip(),
  sourceLanguage: z.string().nullable(),
  outputLanguage: outputLanguageSchema,
  canonicalUrl: z.string().url(),
  contents: z
    .object({
      url: z.string().url(),
      foundCount: z.number().int().min(0),
      numberedCount: z.number().int().min(0),
      reportedCount: z.number().int().nullable(),
      pageOrder: z.enum(['oldest-first', 'newest-first', 'mixed', 'unknown']),
      chapters: z
        .array(
          z.object({
            url: z.string().url(),
            title: z.string(),
            sourceTitle: z.string(),
            number: z.number().nullable(),
          }),
        )
        .max(CONTENTS_LINK_LIMIT),
      nextContentsUrls: z.array(z.string().url()),
      truncated: z.boolean(),
    })
    .nullable()
    .catch(null),
})
export type CatalogMetadata = z.infer<typeof catalogMetadataSchema>

export const addNovelRequestSchema = z
  .object({
    recordId: z.string().uuid(),
    title: z.string().trim().min(1).max(500),
    author: z.string().trim().min(1).max(300),
    referenceVersions: z.array(translatedVersionSchema).max(5).default([]),
    contents: contentsCaptureSchema.optional(),
    novelUpdatesUrl: z.string().url().max(2048).optional(),
    overwrite: z.boolean().default(false),
    confirmed: z.literal(true),
  })
  .strict()
export const addedNovelSchema = z.object({
  bookId: z.string().regex(/^[a-f0-9]{32}$/),
  novelId: novelIdSchema,
  alreadySaved: z.boolean(),
  updated: z.boolean(),
})
export type AddedNovel = z.infer<typeof addedNovelSchema>

export const testScrapeRequestSchema = z
  .object({
    page: capturedPageSchema,
    expectedKind: z.literal('chapter').optional(),
    fetchOnly: z.boolean().default(false),
    forceRegenerate: z.boolean().default(false),
    browserPages: z.array(capturedPageSchema).max(2).optional(),
    contents: contentsCaptureSchema.optional(),
    sampleUrls: z
      .array(z.string().max(2048))
      .max(2)
      .refine((urls) => new Set(urls).size === urls.length),
    rightsConfirmed: z.literal(true),
    sendToModelConfirmed: z.literal(true),
  })
  .strict()

export interface InspectionResult {
  inspection: NovelInspection
  schemaVersion?: number
  sourceUrl?: string
  rawExtraction?: NovelInspection
  recordId?: string
  storageWarning?: string
  cost?: IdentificationCost
  contents?: ContentsDiscovery
  referenceVersions?: TranslatedVersion[]
  metadataReference?: MetadataReferenceSummary
  sourceLanguage?: string | null
  outputLanguage?: OutputLanguage
  model: string
  inputTokens: number
  outputTokens: number
}

export interface ScrapeTestResult extends ScraperToolResult {
  sampledPages: { url: string; error?: string }[]
}

export type ExtensionJob = {
  id: string
  operation: 'inspect' | 'test' | 'navigate' | 'match' | 'download'
  state: 'running' | 'completed' | 'failed'
  stage: string
  inspection?: InspectionResult
  scrape?: ScrapeTestResult
  navigation?: NavigationPlanResult
  matches?: LibraryMatches
  download?: (
    | { state: 'ready'; title: string; cached: boolean }
    | { state: 'needs_scraper' | 'needs_browser'; message: string }
  ) & { canonicalUrl?: string }
  error?: string
}

export interface ExtensionConnection {
  token: string
  expiresAt: number
}

export interface ExtensionPageCapture {
  page: CapturedPage
  pageTitle: string
  preview: string
  tabId: number
}
