import { z } from 'zod'
import { analysisModelSchema, novelIdSchema, type NovelInspection } from './contracts.ts'
import type { IdentificationCost } from '../ai/pricing.ts'
import { publicPageUrl } from '../scraper/contracts.ts'
import { inspectionAliases } from './metadata.ts'

export const LIBRARY_COMPARISON_LIMIT = 60
export const libraryMatchRequestSchema = z
  .object({
    recordId: z.string().uuid(),
    model: analysisModelSchema.optional(),
    confirmed: z.literal(true),
  })
  .strict()

export const pairLibraryRequestSchema = z
  .object({
    bookId: z.string().regex(/^[a-f0-9]{32}$/),
    recordId: z.string().uuid(),
    label: z.string().trim().min(1).max(200),
    language: z.string().trim().min(2).max(35),
    role: z.enum(['original', 'reference', 'metadata']),
    confirmed: z.literal(true),
  })
  .strict()
export const pairedLibrarySourceSchema = z.object({
  bookId: z.string().regex(/^[a-f0-9]{32}$/),
  novelId: novelIdSchema,
  sourceId: z.string().uuid(),
  url: z.string().url(),
  alreadyPaired: z.boolean(),
})
export type PairedLibrarySource = z.infer<typeof pairedLibrarySourceSchema>

export const libraryEntrySchema = z.object({
  id: z.string(),
  novelId: novelIdSchema,
  title: z.string(),
  originalTitle: z.string(),
  author: z.string(),
  language: z.string(),
  description: z.string(),
  aliases: z.array(z.string()),
  sources: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      label: z.string(),
      language: z.string(),
      role: z.string(),
      contentsUrl: z.string().optional(),
    }),
  ),
})
export type LibraryEntry = z.infer<typeof libraryEntrySchema>
export function matchSavedSource(
  urls: string[],
  library: LibraryEntry[],
): LibraryEntry | undefined {
  const normalizeUrl = (value: string) => {
    try {
      return publicPageUrl(value)
    } catch {
      return ''
    }
  }
  const targets = new Set(urls.map(normalizeUrl).filter(Boolean))
  const matches = library.filter((book) =>
    book.sources.some((source) =>
      [source.url, source.contentsUrl].some((url) => url && targets.has(normalizeUrl(url))),
    ),
  )
  return new Set(matches.map((book) => book.novelId)).size === 1 ? matches[0] : undefined
}
export interface LibraryMatch {
  bookId: string
  score: number
  reason: string
  method: 'local' | 'model'
}
export interface LibraryMatches {
  recordId: string
  matches: LibraryMatch[]
  candidatesCompared: number
  librarySize: number
  model?: string
  inputTokens?: number
  outputTokens?: number
  cost?: IdentificationCost
}

const normalize = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
const ignored = new Set(['the', 'a', 'an', 'of', 'in', 'to', 'and', 'my', 'novel', 'chapter'])
const grams = (value: string) => {
  const text = normalize(value).replace(/\s+/g, '')
  return new Set(
    Array.from({ length: Math.max(0, text.length - 1) }, (_, index) =>
      text.slice(index, index + 2),
    ),
  )
}
const overlap = (first: Set<string>, second: Set<string>) =>
  first.size && second.size
    ? (2 * [...first].filter((entry) => second.has(entry)).length) / (first.size + second.size)
    : 0
const similarity = (first: string, second: string) => {
  if (!first || !second) return 0
  const words = (text: string) =>
    new Set(
      normalize(text)
        .split(' ')
        .filter((word) => word.length > 1 && !ignored.has(word)),
    )
  return Math.max(overlap(words(first), words(second)), overlap(grams(first), grams(second)) * 0.85)
}

export function rankLibraryMatches(
  inspection: Pick<NovelInspection, 'title' | 'originalTitle' | 'author' | 'indexUrl'> &
    Partial<Pick<NovelInspection, 'additionalMetadata'>>,
  sourceUrl: string,
  library: LibraryEntry[],
): LibraryMatch[] {
  const urls = new Set(
    [sourceUrl, inspection.indexUrl].filter(Boolean).flatMap((url) => {
      try {
        return [publicPageUrl(url!)]
      } catch {
        return []
      }
    }),
  )
  const names = [
    inspection.title,
    inspection.originalTitle,
    ...inspectionAliases(inspection),
  ].filter((title): title is string => Boolean(title))
  const author = normalize(inspection.author || '')
  return library
    .map((book): LibraryMatch => {
      const sameSource = book.sources.some((source) => {
        try {
          return urls.has(publicPageUrl(source.url))
        } catch {
          return false
        }
      })
      if (sameSource)
        return {
          bookId: book.id,
          score: 1,
          reason: 'This source URL is already linked to the book.',
          method: 'local',
        }
      const bookNames = [book.title, book.originalTitle, ...book.aliases].filter(Boolean)
      const exact = names.some((name) =>
        bookNames.some((saved) => normalize(name) === normalize(saved)),
      )
      const titleScore = Math.max(
        0,
        ...names.flatMap((name) => bookNames.map((saved) => similarity(name, saved))),
      )
      const sameAuthor = Boolean(
        author &&
        !['anonymous', 'unknown author', 'unknown', '\u4f5a\u540d'].includes(author) &&
        author === normalize(book.author),
      )
      const score = exact ? 0.95 : Math.min(0.89, titleScore * 0.8 + (sameAuthor ? 0.15 : 0))
      return {
        bookId: book.id,
        score,
        reason: exact
          ? 'Matching saved title or original title.'
          : sameAuthor
            ? 'Similar title and matching author.'
            : 'Similar title; review before pairing.',
        method: 'local',
      }
    })
    .filter((match) => match.score >= 0.25)
    .sort((first, second) => second.score - first.score)
    .slice(0, 5)
}
