import { describe, expect, it } from 'vitest'
import { findGlossaryMatches, glossaryTermOccurs, resolveGlossary, translatedTermPattern } from './glossary'
import { averageTranslationTimings, chapterTermInventory, replaceTranslatedTerm, validateChapterDraft } from './context'
import type { GlossaryEntry } from './repository'
import {
  suggestReferencePairs,
  selectReferencePositions,
  precedingReferenceChapters,
} from './references'

const entry = (overrides: Partial<GlossaryEntry>): GlossaryEntry => ({
  id: crypto.randomUUID(),
  owner_id: 'owner',
  scope: 'global',
  novel_id: null,
  book_id: null,
  chapter_position: null,
  source_term: '林遥',
  target_term: 'Lin Yao',
  source_language: 'zh',
  target_language: 'en',
  category: 'person',
  sense: '',
  aliases: [],
  notes: '',
  evidence: '',
  status: 'approved',
  run_id: null,
  revision: 1,
  created_at: '',
  updated_at: '',
  ...overrides,
})
const context = {
  novelId: 'novel',
  bookId: 'book',
  chapter: 1,
  sourceLanguage: 'zh',
  targetLanguage: 'en',
}

describe('translated paragraph spacing', () => {
  it('averages measured translations by model and language without counting missing timings or edits', () => {
    const record = { kind: 'chapter', model: 'test-model', target_language: 'en', input_tokens: 100, output_tokens: 50, context: { timings: { preparationMs: 100, guideMs: 0, modelMs: 2000 } } }
    const averages = averageTranslationTimings([record, { ...record, context: { timings: { preparationMs: 300, guideMs: 400, modelMs: 4000 } } }, { ...record, context: {} }, { ...record, model: 'manual edit' }, { ...record, context: { ...record.context, manualEdit: {} } }, { ...record, target_language: 'es' }])
    expect(averages).toHaveLength(2)
    expect(averages[0]).toMatchObject({ samples: 2, preparationMs: 200, guideMs: 200, modelMs: 3000, totalMs: 3400 })
    expect(averages[1]).toMatchObject({ samples: 1, language: 'es' })
  })
  it('preserves noun inflection in edits and refuses ambiguous blanket replacements', () => {
    const translation = { title: 'Chapter', paragraphs: ['The Desolate Stone Gu Worms gathered. A Desolate Stone Gu Worm waited.'], terminology: [{ source: '荒石蠱蟲', target: 'Desolate Stone Gu Worm', category: 'concept' as const }] }
    expect(chapterTermInventory(translation, '荒石蠱蟲', {})[0]).toMatchObject({ present: true, forms: expect.arrayContaining(['Desolate Stone Gu Worms']) })
    expect(replaceTranslatedTerm(translation, '荒石蠱蟲', 'Desolate Stone Gu Worm', 'Barren Stone Gu Worm').paragraphs).toEqual(['The Barren Stone Gu Worms gathered. A Barren Stone Gu Worm waited.'])
    expect(() => replaceTranslatedTerm({ ...translation, terminology: [...translation.terminology, { source: '另一名', target: 'Desolate Stone Gu Worm', category: 'concept' }] }, '荒石蠱蟲', 'Desolate Stone Gu Worm', 'Other')).toThrow('multiple source terms')
    expect(chapterTermInventory({ ...translation, terminology: [{ source: '林', target: 'Lin', category: 'person' }] }, '林', {})[0].forms).toEqual(['Lin'])
  })
  it('keeps complete prose and valid terms when a terminology candidate has invalid evidence', () => {
    const term = { source: '林遥', target: 'Lin Yao', category: 'person', sense: '', evidenceQuote: '林遥提着照月灯。' }
    const warnings: string[] = []
    const result = validateChapterDraft({ title: 'Chapter', paragraphs: ['Lin Yao carried the Moonlit Lantern.', 'He waited.'], terminology: [term, { ...term }, { source: '照月灯', target: 'Moonlit Lantern', category: 'item', sense: '', evidenceQuote: 'An invented quote.' }] }, '林遥提着照月灯。\n\n他等着。', warnings)
    expect(result.paragraphs).toHaveLength(2)
    expect(result.terminology).toEqual([term])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('already present')
    expect(warnings[1]).toContain('source evidence')
  })
  it('matches unspaced Chinese terms without breaking English word boundaries', () => {
    const text = '林遥拿起照月灯。Lin spoke to Lincoln.'
    expect([...text.matchAll(translatedTermPattern(['林遥', '照月灯', 'Lin']))].map(match => match[0])).toEqual(['林遥', '照月灯', 'Lin'])
    const translation = { title: 'Chapter', paragraphs: ['林遥拿起照月灯。'], terminology: [{ source: 'Name', target: '林遥' }] }
    expect(replaceTranslatedTerm(translation, 'Name', '林遥', '林瑶').paragraphs).toEqual(['林瑶拿起照月灯。'])
    expect(translation.paragraphs).toEqual(['林遥拿起照月灯。'])
  })
  it('edits complete annotated terms without replacing substrings or changing old versions', () => {
    const original = {
      title: 'Chapter',
      paragraphs: ['Lin spoke to Lincoln. Lin replied.'],
      terminology: [{ source: 'Name', target: 'Lin' }],
    }
    const updated = replaceTranslatedTerm(original, 'Name', 'Lin', 'Ling')
    expect(updated.paragraphs).toEqual(['Ling spoke to Lincoln. Ling replied.'])
    expect(updated.terminology[0].target).toBe('Ling')
    expect(original.paragraphs[0]).toBe('Lin spoke to Lincoln. Lin replied.')
    expect(() => replaceTranslatedTerm(original, 'Missing', 'Lin', 'Ling')).toThrow('no longer')
  })
  it('keeps separate paragraphs and explicit line breaks without joining words', () => {
    const result = validateChapterDraft(
      {
        title: 'Chapter',
        paragraphs: [
          '  First paragraph.\r\n\r\nSecond paragraph.\nA deliberate line break.  ',
          'Third paragraph.',
        ],
        terminology: [],
      },
      'Original one.\n\nOriginal two.\n\nOriginal three.',
    )
    expect(result.paragraphs).toEqual([
      'First paragraph.',
      'Second paragraph.\nA deliberate line break.',
      'Third paragraph.',
    ])
  })
  it('rejects collapsed or empty output before saving a version', () => {
    expect(() =>
      validateChapterDraft(
        { title: 'Chapter', paragraphs: ['One dense block.'], terminology: [] },
        'First source paragraph.\n\nSecond source paragraph.',
      ),
    ).toThrow('collapsed paragraph breaks')
    expect(() =>
      validateChapterDraft({ title: 'Chapter', paragraphs: ['   '], terminology: [] }, 'Original.'),
    ).toThrow()
  })
})

describe('reference chapter suggestions', () => {
  it('uses earlier English chapters for continuation without inventing a chapter pair', () => {
    const source = { title: '\u3010123\u3011 Next', key: 'chapter-123', position: 122 }
    const references = Array.from({ length: 125 }, (_, position) => ({
      title: `Chapter ${position + 1}`,
      key: `english-${position + 1}`,
      position,
    }))
    const earlier = precedingReferenceChapters(source, references)
    expect(earlier).toHaveLength(122)
    expect(earlier.slice(-3).map((chapter) => chapter.title)).toEqual([
      'Chapter 120',
      'Chapter 121',
      'Chapter 122',
    ])
    expect(precedingReferenceChapters({ ...source, title: 'Unnumbered' }, references)).toEqual([])
  })
  it('pairs Chinese chapter numbers to split English parts without shifting the next chapter', () => {
    const source = ['第42章 归来', '第43章 山门', '第151章 新程'].map((title, position) => ({
      title,
      position,
      key: `local:${position}`,
    }))
    const reference = ['Chapter 42.1 Return', 'Chapter 42.2 Return', 'Chapter 43 Mountain'].map(
      (title, position) => ({ title, position, key: `local:${position}` }),
    )
    const suggestions = suggestReferencePairs(source, reference)
    expect(suggestions.map((entry) => entry.positions)).toEqual([[0, 1], [2], []])
    expect(
      selectReferencePositions(source[0], reference, [2], suggestions[0].positions, false),
    ).toEqual({ positions: [2], basis: 'confirmed' })
    expect(selectReferencePositions(source[2], reference, [], [], false)).toEqual({
      positions: [0, 1, 2],
      basis: 'preceding',
    })
    expect(selectReferencePositions(source[0], reference, [2], [], true).basis).toBe('style')
  })
})

describe('translation glossary precedence', () => {
  it('includes established mappings missing from model terms and explains annotation gaps', () => {
    const translation = { title: 'Chapter', paragraphs: ['Lin Yao waited. The Moon Lantern glowed.'], terminology: [{ source: '照月灯', target: 'Moon Lantern', category: 'item' as const }] }
    const terms = chapterTermInventory(translation, '林遥看着照月灯。', { glossary: [{ source: '林遥', target: 'Lin Yao' }, { source: '照月灯', target: 'Moonlit Lantern' }] })
    expect(terms.find(term => term.source === '林遥')).toMatchObject({ state: 'established', present: true })
    expect(terms.find(term => term.target === 'Moon Lantern')).toMatchObject({ state: 'different', knownTarget: 'Moonlit Lantern', present: true })
    expect(terms.find(term => term.target === 'Moonlit Lantern')).toMatchObject({ state: 'established', present: false })
  })
  it('uses only selected book and language-pair glossaries below this book preferences', () => {
    const external = entry({ scope: 'novel', novel_id: 'reference', target_term: 'Reference name' })
    const spanish = entry({ ...external, target_language: 'es', target_term: 'Nombre' })
    const unrelated = entry({ ...external, novel_id: 'unselected', target_term: 'Wrong name' })
    const own = entry({ scope: 'novel', novel_id: 'novel', target_term: 'Preferred name' })
    const selection = { ...context, sourceLanguage: 'zh-Hant', externalGlossaries: [{ novelId: 'reference', sourceLanguage: 'zh', targetLanguage: 'en' }] }
    expect(resolveGlossary([unrelated, spanish, external, entry({})], selection)).toEqual([external])
    expect(resolveGlossary([own, external], selection)).toEqual([own])
    expect(resolveGlossary([external, own], selection)).toEqual([own])
    expect(resolveGlossary([external], context)).toEqual([])
  })
  it('reuses approved Chinese terms across regional tags and recognizes aliases', () => {
    const serpent = entry({
      source_term: '\u9a30\u738b\u8703\u86c7',
      target_term: 'Soaring Mirage Serpent',
      source_language: 'zh',
      aliases: ['\u817e\u738b\u8703\u86c7'],
    })
    expect(resolveGlossary([serpent], { ...context, sourceLanguage: 'zh-Hant' })).toEqual([serpent])
    expect(resolveGlossary([serpent], { ...context, sourceLanguage: 'zh-TW' })).toEqual([serpent])
    expect(resolveGlossary([serpent], { ...context, sourceLanguage: 'ja' })).toEqual([])
    expect(glossaryTermOccurs(serpent, '\u7a2e\u65cf\uff1a\u9a30\u738b\u8703\u86c7')).toBe(true)
    expect(glossaryTermOccurs(serpent, '\u79cd\u65cf\uff1a\u817e\u738b\u8703\u86c7')).toBe(true)
  })
  it('labels related glossary memory as hints and retains conflicting senses for review', () => {
    const confirmed = entry({
      source_term: 'Mirage Serpent',
      target_term: 'Soaring Mirage Serpent',
      source_language: 'en',
      novel_id: 'another',
      scope: 'novel',
    })
    const alternative = {
      ...confirmed,
      id: crypto.randomUUID(),
      target_term: 'Mirage Snake',
      sense: 'Different creature',
      status: 'proposed' as const,
    }
    expect(
      findGlossaryMatches([confirmed, alternative], 'Mirage Serpent', 'en', 'en').map(
        (match) => match.entry.target_term,
      ),
    ).toEqual(['Soaring Mirage Serpent', 'Mirage Snake'])
    expect(findGlossaryMatches([confirmed], 'Mirage Serpents', 'en', 'en')[0].match).toBe('exact')
    expect(findGlossaryMatches([confirmed], 'Mirage Serpant', 'en', 'en')[0].match).toBe('similar')
    expect(
      findGlossaryMatches([{ ...confirmed, status: 'rejected' }], 'Mirage Serpent', 'en', 'en'),
    ).toEqual([])
    expect(resolveGlossary([confirmed], { ...context, sourceLanguage: 'en' })).toEqual([])
  })
  it('prefers chapter overrides over novel terms and global defaults', () => {
    const global = entry({ target_term: 'Global name' })
    const novel = entry({ scope: 'novel', novel_id: 'novel', target_term: 'Novel name' })
    const local = entry({
      scope: 'chapter',
      novel_id: 'novel',
      book_id: 'book',
      chapter_position: 1,
      target_term: 'Chapter name',
    })
    expect(resolveGlossary([local, global, novel], context)).toEqual([local])
    expect(resolveGlossary([local, global, novel], { ...context, chapter: 0 })).toEqual([novel])
    expect(resolveGlossary([local, global, novel], { ...context, novelId: 'other' })).toEqual([
      global,
    ])
  })

  it('keeps distinct meanings separate and ignores unapproved or wrong-language terms', () => {
    const primary = entry({})
    const anotherSense = entry({ sense: 'A different person', target_term: 'Another name' })
    const proposed = entry({ source_term: '顾宁', status: 'proposed' })
    const wrongLanguage = entry({ source_term: 'Gu Ning', source_language: 'en' })
    expect(resolveGlossary([primary, anotherSense, proposed, wrongLanguage], context)).toEqual([
      primary,
      anotherSense,
    ])
  })
})
