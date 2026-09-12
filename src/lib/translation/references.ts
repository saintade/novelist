import type { CatalogMetadata } from '../extension/contracts.ts'

export interface ReferenceChapter {
  key: string
  title: string
  position: number
}
export interface PairSuggestion {
  sourceKey: string
  positions: number[]
  reason: string
}
export interface BookChapterListing {
  id: string
  chapters: { title: string }[]
  catalog?: Pick<CatalogMetadata, 'contents'>
}
export function referenceChapters(
  book: Pick<BookChapterListing, 'chapters' | 'catalog'>,
): ReferenceChapter[] {
  if (book.chapters.length)
    return book.chapters.map((chapter, position) => ({
      key: `local:${position}`,
      title: chapter.title,
      position,
    }))
  return (book.catalog?.contents?.chapters ?? []).map((chapter, position) => ({
    key: chapter.url,
    title: chapter.sourceTitle || chapter.title,
    position,
  }))
}
const chapterNumber = (title: string) => {
  const value = title
    .normalize('NFKC')
    .match(
      /^(?:chapter\s*|\u7b2c\s*|[\u3010[(]\s*)?(\d+)(?:[.-]\d+)?(?:\s|[\u7ae0\u56de\u8a71\u8bdd.\]\u3011):]|$)/i,
    )
  return value ? Number(value[1]) : null
}
const normalizeTitle = (title: string) =>
  title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
export function precedingReferenceChapters(
  source: ReferenceChapter,
  references: ReferenceChapter[],
): ReferenceChapter[] {
  const number = chapterNumber(source.title)
  if (number === null) return []
  return references
    .filter((reference) => {
      const referenceNumber = chapterNumber(reference.title)
      return referenceNumber !== null && referenceNumber < number
    })
    .sort(
      (first, second) =>
        chapterNumber(first.title)! - chapterNumber(second.title)! ||
        first.position - second.position,
    )
}

export function suggestReferencePairs(
  source: ReferenceChapter[],
  reference: ReferenceChapter[],
): PairSuggestion[] {
  return source.map((chapter) => {
    const number = chapterNumber(chapter.title)
    const byNumber =
      number === null
        ? []
        : reference.filter((candidate) => chapterNumber(candidate.title) === number)
    const byTitle = reference.filter(
      (candidate) => normalizeTitle(candidate.title) === normalizeTitle(chapter.title),
    )
    if (byNumber.length)
      return {
        sourceKey: chapter.key,
        positions: byNumber.map((entry) => entry.position).slice(0, 20),
        reason: 'Matching chapter number; review split parts.',
      }
    if (byTitle.length === 1)
      return {
        sourceKey: chapter.key,
        positions: [byTitle[0].position],
        reason: 'Matching chapter title.',
      }
    if (source.length === reference.length && reference[chapter.position] && number === null)
      return {
        sourceKey: chapter.key,
        positions: [reference[chapter.position].position],
        reason: 'Same order and chapter count only; unverified.',
      }
    return { sourceKey: chapter.key, positions: [], reason: 'No reliable number or title match.' }
  })
}
export function selectReferencePositions(
  source: ReferenceChapter,
  references: ReferenceChapter[],
  confirmed: number[],
  suggested: number[],
  styleOnly: boolean,
): { positions: number[]; basis: 'confirmed' | 'suggested' | 'preceding' | 'style' } {
  if (styleOnly)
    return { positions: references.slice(0, 3).map((chapter) => chapter.position), basis: 'style' }
  if (confirmed.length) return { positions: confirmed, basis: 'confirmed' }
  if (suggested.length) return { positions: suggested, basis: 'suggested' }
  const number = chapterNumber(source.title)
  const preceding = references
    .filter((candidate) => {
      const candidateNumber = chapterNumber(candidate.title)
      return number !== null && candidateNumber !== null && candidateNumber < number
    })
    .slice(-3)
  return { positions: preceding.map((chapter) => chapter.position), basis: 'preceding' }
}
