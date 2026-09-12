import type { GlossaryEntry } from './types.ts'
import { fuzzy } from 'fast-fuzzy'
import pluralize from 'pluralize'

export function translatedTermForms(term: { target: string; category?: string }, language = 'en'): string[] {
  if (!sameGlossaryLanguage(language, 'en') || !['concept', 'item', 'rank', 'technique', 'organization'].includes(term.category ?? '') || !/[A-Za-z]$/.test(term.target)) return [term.target]
  return [...new Set([term.target, pluralize.singular(term.target), pluralize.plural(term.target)])]
}

export function replaceTermForm(previous: string, preferred: string, occurrence: string): string {
  if (occurrence === previous) return preferred
  return pluralize.isPlural(occurrence) ? pluralize.plural(preferred) : pluralize.singular(preferred)
}

export function translatedTermPattern(terms: string[]): RegExp {
  const unspaced = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
  const alternatives = [...new Set(terms.filter(term => term.trim()))]
    .sort((first, second) => second.length - first.length)
    .map(term => {
      const characters = [...term]
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const before = unspaced.test(characters[0]) ? '' : '(?<![\\p{L}\\p{N}_])'
      const after = unspaced.test(characters.at(-1)!) ? '' : '(?![\\p{L}\\p{N}_])'
      return `${before}${escaped}${after}`
    })
  return new RegExp(alternatives.length ? `(?:${alternatives.join('|')})` : '(?!)', 'gu')
}

export function sameGlossaryLanguage(first: string, second: string): boolean {
  return first.toLowerCase().split(/[-_]/)[0] === second.toLowerCase().split(/[-_]/)[0]
}

export function glossaryTermOccurs(
  entry: Pick<GlossaryEntry, 'source_term' | 'aliases'>,
  text: string,
): boolean {
  const normalized = text.normalize('NFKC')
  return [entry.source_term, ...entry.aliases].some(
    (term) => term.trim() && normalized.includes(term.normalize('NFKC')),
  )
}

export function findGlossaryMatches(
  entries: GlossaryEntry[],
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
  limit = 20,
) {
  const normalized = text.normalize('NFKC')
  const matches = entries
    .filter(
      (entry) =>
        entry.status !== 'rejected' &&
        sameGlossaryLanguage(entry.source_language, sourceLanguage) &&
        sameGlossaryLanguage(entry.target_language, targetLanguage),
    )
    .flatMap<{ entry: GlossaryEntry; match: 'exact' | 'alias' | 'similar'; score: number }>(
      (entry) => {
        const term = entry.source_term.normalize('NFKC')
        if (normalized.includes(term)) return [{ entry, match: 'exact' as const, score: 1 }]
        if (glossaryTermOccurs(entry, normalized))
          return [{ entry, match: 'alias' as const, score: 1 }]
        if ([...term].length < 4 || !normalized.includes([...term].slice(0, 2).join(''))) return []
        const score = fuzzy(term, normalized, {
          ignoreSymbols: false,
          useSellers: true,
          useDamerau: false,
        })
        return score >= 0.8 ? [{ entry, match: 'similar' as const, score }] : []
      },
    )
  return matches
    .sort(
      (first, second) =>
        second.score - first.score ||
        Number(second.entry.status === 'approved') - Number(first.entry.status === 'approved'),
    )
    .slice(0, limit)
}

export function resolveGlossary(
  entries: GlossaryEntry[],
  context: {
    novelId: string
    bookId: string
    chapter: number
    sourceLanguage: string
    targetLanguage: string
    externalGlossaries?: { novelId: string; sourceLanguage: string; targetLanguage: string }[]
  },
): GlossaryEntry[] {
  const external = (entry: GlossaryEntry) => entry.scope === 'novel' && entry.novel_id !== context.novelId && context.externalGlossaries?.some(source => source.novelId === entry.novel_id && source.sourceLanguage === entry.source_language && source.targetLanguage === entry.target_language)
  const priority = (entry: GlossaryEntry) => entry.scope === 'chapter' ? 3 : entry.scope === 'novel' ? external(entry) ? 1 : 2 : 0
  const resolved = new Map<string, GlossaryEntry>()
  for (const entry of entries) {
    if (
      entry.status !== 'approved' ||
      !sameGlossaryLanguage(entry.source_language, context.sourceLanguage) ||
      !sameGlossaryLanguage(entry.target_language, context.targetLanguage)
    )
      continue
    if (entry.scope !== 'global' && entry.novel_id !== context.novelId && !external(entry)) continue
    if (
      entry.scope === 'chapter' &&
      (entry.book_id !== context.bookId || entry.chapter_position !== context.chapter)
    )
      continue
    const key = JSON.stringify([entry.source_term, entry.sense])
    const existing = resolved.get(key)
    if (
      !existing ||
      priority(entry) > priority(existing) ||
      (priority(entry) === priority(existing) &&
        entry.source_language === context.sourceLanguage &&
        existing.source_language !== context.sourceLanguage)
    )
      resolved.set(key, entry)
  }
  return [...resolved.values()].sort((first, second) =>
    first.source_term.localeCompare(second.source_term),
  )
}
