import { z } from 'zod'
import type { MetadataReference } from '../src/lib/extension/metadata'
import {
  analysisModelSchema,
  outputLanguageSchema,
  translatedVersionSchema,
  type AnalysisModel,
  type TranslatedVersion,
  type AddedNovel,
} from '../src/lib/extension/contracts'
import type { IdentificationCost } from '../src/lib/ai/pricing'
import { navigationGoalSchema, type NavigationRun } from '../src/lib/extension/navigation'
import {
  libraryMatchRequestSchema,
  pairLibraryRequestSchema,
  type LibraryEntry,
  type LibraryMatches,
  type PairedLibrarySource,
} from '../src/lib/extension/library-catalog'
import type {
  ExtensionConnection,
  ExtensionJob,
  ExtensionPageCapture,
  InspectionResult,
  ContentsCapture,
} from '../src/lib/extension/contracts'

z.config({ jitless: true })

export const DEFAULT_ORIGIN = 'http://127.0.0.1:5173'

export function localAppOrigin(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'Use the HTTP address of your local Novelist app, such as http://127.0.0.1:5173.',
    )
  return url.origin
}

export interface ChapterDownloadBatch {
  id: string
  bookId: string
  sourceUrl: string
  backendOrigin: string
  tabId: number
  capturedAt: string
  urls: string[]
  from: number
  next: number
  saved: number
  skipped: number
  state: 'running' | 'paused' | 'needs_scraper' | 'needs_browser' | 'completed'
  message: string
  jobId?: string
  transport?: 'browser' | 'http'
  delaySeconds?: number
  accessChallenges?: number
  timing?: { browserMs: number; browserPages: number; processingMs: number; processingJobs: number }
}

export interface StoredState {
  connection?: ExtensionConnection
  connectionAttempt?: { nonce: string; origin: string; expiresAt: number; tabId?: number }
  connecting?: boolean
  connectionError?: string
  capture?: ExtensionPageCapture & { capturedAt: string }
  inspection?: InspectionResult
  job?: ExtensionJob
  liveEnabled?: boolean
  model?: string
  identificationModel?: string
  estimate?: { cost: IdentificationCost; outputLanguage: string; capturedAt: string }
  error?: string
  capturing?: boolean
  scanningContents?: boolean
  contentsScan?: { actions: number; reason: string }
  contentsCapture?: ContentsCapture
  referenceVersions?: TranslatedVersion[]
  metadataReference?: MetadataReference
  useMetadataReference?: boolean
  addedNovel?: AddedNovel & { title: string; author: string }
  navigation?: NavigationRun
  library?: LibraryEntry[]
  libraryError?: string
  libraryMatches?: LibraryMatches
  pairedSource?: PairedLibrarySource
  savedSource?: { book: LibraryEntry; url: string }
  novelUpdatesUrl?: string
  sourceLookupError?: string
  contentsSaved?: { bookId: string; foundCount: number; saved: boolean }
  contentsSaveError?: string
  chapterDownload?: {
    url: string
    state: 'ready' | 'needs_scraper' | 'needs_browser'
    message?: string
  }
  chapterBatch?: ChapterDownloadBatch
  directTest?: { jobId: string; sourceUrl: string }
  singleDownload?: { jobId: string; sourceUrl: string; url: string }
}
export interface PanelState extends Omit<StoredState, 'connection' | 'connectionAttempt'> {
  backendOrigin: string
  autoConnect: boolean
  preferredAnalysisModel?: AnalysisModel
  connected: boolean
  expiresAt?: number
  downloadDelaySeconds?: number
  downloadTransport?: 'browser' | 'http'
}

export const panelMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state') }).strict(),
  z.object({ type: z.literal('sync'), refreshLibrary: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('capture') }).strict(),
  z.object({ type: z.literal('contents') }).strict(),
  z.object({ type: z.literal('stop-contents') }).strict(),
  z
    .object({ type: z.literal('set-download-transport'), transport: z.enum(['browser', 'http']) })
    .strict(),
  z
    .object({
      type: z.literal('download-chapters'),
      mode: z.enum(['all', 'range']),
      from: z.number().int().min(1).max(20000).optional(),
      to: z.number().int().min(1).max(20000).optional(),
      delaySeconds: z.number().int().min(1).max(60).optional(),
    })
    .strict(),
  z.object({ type: z.literal('pause-downloads') }).strict(),
  z
    .object({
      type: z.literal('resume-downloads'),
      confirmed: z.boolean().default(false),
      delaySeconds: z.number().int().min(1).max(60).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('download-chapter'),
      url: z.string().url().max(2048),
      confirmed: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      type: z.literal('test-chapter'),
      url: z.string().url().max(2048),
      confirmed: z.literal(true),
      transport: z.enum(['browser', 'http']).default('browser'),
      forceRegenerate: z.boolean().default(false),
    })
    .strict(),
  z.object({ type: z.literal('save-contents') }).strict(),
  z
    .object({
      type: z.literal('link-novelupdates'),
      url: z.string().url().max(2048),
      bookId: z
        .string()
        .regex(/^[a-f0-9]{32}$/)
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal('keep-metadata-reference') }).strict(),
  z.object({ type: z.literal('remove-metadata-reference') }).strict(),
  z.object({ type: z.literal('use-metadata-reference'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('library') }).strict(),
  libraryMatchRequestSchema.extend({ type: z.literal('match-library') }),
  pairLibraryRequestSchema.extend({ type: z.literal('pair-book') }),
  z
    .object({
      type: z.literal('navigate'),
      goal: navigationGoalSchema,
      model: analysisModelSchema.optional(),
      confirmed: z.literal(true),
    })
    .strict(),
  z.object({ type: z.literal('stop-navigation') }).strict(),
  z.object({ type: z.literal('show-tab') }).strict(),
  z.object({ type: z.literal('pair-version'), source: translatedVersionSchema }).strict(),
  z.object({ type: z.literal('remove-version'), index: z.number().int().min(0).max(4) }).strict(),
  z
    .object({
      type: z.literal('add-book'),
      title: z.string().trim().min(1).max(500),
      author: z.string().trim().min(1).max(300),
      overwrite: z.boolean(),
      confirmed: z.literal(true),
    })
    .strict(),
  z.object({ type: z.literal('disconnect') }).strict(),
  z.object({ type: z.literal('poll') }).strict(),
  z.object({ type: z.literal('connect'), origin: z.string().max(200) }).strict(),
  z
    .object({ type: z.literal('save-model-default'), model: analysisModelSchema.nullable() })
    .strict(),
  z
    .object({
      type: z.literal('inspect'),
      outputLanguage: outputLanguageSchema.default('en'),
      model: analysisModelSchema.optional(),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      type: z.literal('estimate'),
      outputLanguage: outputLanguageSchema.default('en'),
      model: analysisModelSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('test'),
      useBrowserSamples: z.boolean().default(false),
      sampleUrls: z.array(z.string().max(2048)).max(2),
      confirmed: z.literal(true),
    })
    .strict(),
])
export type PanelMessage = z.infer<typeof panelMessageSchema>
export type PanelResponse = { ok: true; state: PanelState } | { ok: false; error: string }
