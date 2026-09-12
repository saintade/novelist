import { z } from 'zod'
import { capturedPageSchema } from '../scraper/contracts.ts'
import type { InspectionResult, NovelInspection } from './contracts.ts'

export function identificationFilename(
  result: Pick<InspectionResult, 'sourceUrl' | 'recordId'> & {
    inspection: Pick<NovelInspection, 'title' | 'originalTitle' | 'indexUrl'>
  },
): string {
  const part = (value: string, limit: number) =>
    Array.from(
      value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-'),
    )
      .slice(0, limit)
      .join('')
      .replace(/^-+|-+$/g, '')
  let hostname = ''
  let pathLabel = ''
  for (const candidate of [result.sourceUrl, result.inspection.indexUrl]) {
    if (!candidate) continue
    try {
      const source = new URL(candidate)
      hostname = source.hostname.replace(/^www\./, '')
      const path = /^#!?\//.test(source.hash)
        ? new URL(source.hash.replace(/^#!/, '').replace(/^#/, ''), source.origin).pathname
        : source.pathname
      pathLabel = path
      try {
        pathLabel = decodeURIComponent(pathLabel)
      } catch {}
      break
    } catch {
      continue
    }
  }
  const title =
    part(result.inspection.title ?? '', 40) ||
    part(result.inspection.originalTitle ?? '', 40) ||
    part(pathLabel, 40) ||
    'page'
  const identifier = result.recordId
    ?.replace(/[^a-z0-9]/gi, '')
    .slice(0, 8)
    .toLowerCase()
  const label = [title, part(hostname, 40), identifier].filter(Boolean).join('-')
  return `novelist-identification-${label}.json`
}

export function isNovelUpdatesSeries(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      ['novelupdates.com', 'www.novelupdates.com'].includes(url.hostname) &&
      /^\/series\/[^/]+\/?$/.test(url.pathname)
    )
  } catch {
    return false
  }
}

export const metadataReferenceSchema = z
  .object({
    page: capturedPageSchema
      .refine(
        (page) => isNovelUpdatesSeries(page.url),
        'Use a Novel Updates series page as the metadata reference.',
      )
      .refine(
        (page) =>
          !/performing security verification|checking your browser|verify you are human|<title[^>]*>\s*just a moment/i.test(
            page.html,
          ),
        'Open the complete Novel Updates series page in your browser before keeping it as a reference.',
      ),
    title: z.string().trim().min(1).max(500),
  })
  .strict()
export type MetadataReference = z.infer<typeof metadataReferenceSchema>
export interface MetadataReferenceSummary {
  url: string
  title: string
  capturedHtmlHash: string
}

export function inspectionAliases(
  inspection: Partial<Pick<NovelInspection, 'additionalMetadata'>>,
): string[] {
  const aliasLabel =
    /^(aliases?|associated names?|alternative titles?|alternate titles?|other names?|\u522b\u540d|\u5225\u540d)$/i
  const aliases = (inspection.additionalMetadata ?? [])
    .filter(
      (entry) =>
        aliasLabel.test(entry.field.trim()) || aliasLabel.test(entry.originalField?.trim() ?? ''),
    )
    .flatMap((entry) =>
      Array.isArray(entry.value)
        ? entry.value
        : typeof entry.value === 'string'
          ? [entry.value]
          : [],
    )
  return [...new Set(aliases.map((alias) => alias.trim()).filter(Boolean))].slice(0, 40)
}
