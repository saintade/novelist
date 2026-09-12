import { describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { captureCurrentPage } from '../../src/lib/scraper/capture'
import {
  libraryMatchRequestSchema,
  libraryEntrySchema,
  pairedLibrarySourceSchema,
  LIBRARY_COMPARISON_LIMIT,
  rankLibraryMatches,
  matchSavedSource,
  type LibraryEntry,
} from '../../src/lib/extension/library-catalog'
import { addedNovelSchema, type NovelInspection } from '../../src/lib/extension/contracts'
import { chooseLibraryMatches } from './library-match'
import { identificationInput, validateNovelInspection } from './inspect'
import {
  identificationFilename,
  inspectionAliases,
  metadataReferenceSchema,
} from '../../src/lib/extension/metadata'
import { discoverContents } from '../../src/lib/extension/contents'

const mocks = vi.hoisted(() => ({ parse: vi.fn() }))
vi.mock('openai', async (original) => ({
  ...(await original<typeof import('openai')>()),
  default: class {
    responses = { parse: mocks.parse }
  },
}))

const entry = (id: string, title: string, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id,
  title,
  originalTitle: '',
  author: 'Unknown author',
  novelId: crypto.randomUUID(),
  language: 'en',
  description: '',
  aliases: [],
  sources: [],
  ...extra,
})

describe('library match suggestions', () => {
  it('associates exact source and contents URLs only when the canonical novel is unambiguous', () => {
    const source = {
      id: 'source',
      url: 'https://books.example.test/book/1',
      contentsUrl: 'https://books.example.test/book/1/contents',
      label: 'Original',
      role: 'original',
      language: 'zh',
    }
    const first = entry('one', 'Book one', { sources: [source] })
    expect(matchSavedSource([source.url], [first])?.id).toBe('one')
    expect(matchSavedSource([source.contentsUrl], [first])?.id).toBe('one')
    expect(matchSavedSource(['https://books.example.test/book/10'], [first])).toBeUndefined()
    expect(
      matchSavedSource(
        [source.url],
        [first, entry('two', 'Ambiguous duplicate', { sources: [source] })],
      ),
    ).toBeUndefined()
    expect(
      matchSavedSource([source.url], [first, { ...first, id: 'another-reading-copy' }])?.novelId,
    ).toBe(first.novelId)
  })
  it('names identification exports using the title, source site and record without URL secrets', () => {
    const result = {
      inspection: { title: 'The River Ledger', originalTitle: null, indexUrl: null },
      sourceUrl: 'https://reader:password@books.example.test/river-ledger?token=PRIVATE',
      recordId: '195683d2-3a97-46e9-b0df-25f9991957cf',
    }
    expect(identificationFilename(result)).toBe(
      'novelist-identification-the-river-ledger-books-example-test-195683d2.json',
    )
    expect(
      identificationFilename({ ...result, recordId: 'f95683d2-3a97-46e9-b0df-25f9991957cf' }),
    ).not.toBe(identificationFilename(result))
    expect(
      identificationFilename({
        ...result,
        inspection: {
          ...result.inspection,
          title: null,
          originalTitle: '\u9752\u5c9a\u6e21\u53e3',
        },
      }),
    ).toBe('novelist-identification-\u9752\u5c9a\u6e21\u53e3-books-example-test-195683d2.json')
    const longName = identificationFilename({
      ...result,
      inspection: { ...result.inspection, title: '../<>:"\\|?*' + '\u9752'.repeat(500) },
    })
    expect(longName).not.toMatch(/[<>:"/\\|?*]/)
    expect(new TextEncoder().encode(longName).length).toBeLessThan(255)
  })
  it('falls back to the contents URL, browser route or a generic label when titles are unavailable', () => {
    const inspection = {
      title: null,
      originalTitle: null,
      indexUrl: 'https://101kks.com/book/11508/index.html',
    }
    expect(
      identificationFilename({ inspection, sourceUrl: 'https://101kks.com/book/11508.html' }),
    ).toBe('novelist-identification-book-11508-html-101kks-com.json')
    expect(identificationFilename({ inspection, sourceUrl: 'not a URL' })).toBe(
      'novelist-identification-book-11508-index-html-101kks-com.json',
    )
    expect(
      identificationFilename({
        inspection,
        sourceUrl: 'https://books.example.test/#/book/117659/?token=PRIVATE',
      }),
    ).toBe('novelist-identification-book-117659-books-example-test.json')
    expect(identificationFilename({ inspection: { ...inspection, indexUrl: null } })).toBe(
      'novelist-identification-page.json',
    )
  })

  it('accepts PostgreSQL novel IDs without UUID version bits and still rejects malformed identifiers', () => {
    const legacyIds = [
      'a1b2c3d4-e5f6-0a1b-2345-6789abcdef01',
      '01234567-89ab-cdef-0123-456789abcdef',
    ]
    const books = [...legacyIds, crypto.randomUUID()].map((novelId, index) =>
      entry(`book-${index}`, `Saved book ${index}`, { novelId }),
    )
    expect(libraryEntrySchema.array().parse(books)).toEqual(books)
    for (const novelId of legacyIds) {
      expect(
        pairedLibrarySourceSchema.parse({
          bookId: 'a'.repeat(32),
          novelId,
          sourceId: crypto.randomUUID(),
          url: 'https://books.example.test/novel',
          alreadyPaired: true,
        }).novelId,
      ).toBe(novelId)
      expect(
        addedNovelSchema.parse({
          bookId: 'a'.repeat(32),
          novelId,
          alreadySaved: true,
          updated: false,
        }).novelId,
      ).toBe(novelId)
      expect(
        libraryMatchRequestSchema.safeParse({ recordId: novelId, confirmed: true }).success,
      ).toBe(false)
    }
    for (const novelId of [
      'not-an-id',
      '01234567-89ab-cdef-0123-456789abcde',
      'z1234567-89ab-cdef-0123-456789abcdef',
    ])
      expect(
        libraryEntrySchema.safeParse(entry('invalid', 'Invalid ID', { novelId })).success,
      ).toBe(false)
  })

  it('uses captured Novel Updates metadata as reference data, retains aliases and rejects release links as chapters', () => {
    const url = 'https://www.novelupdates.com/series/example-novel/'
    const reference = {
      title: 'Example novel',
      page: {
        url,
        html: '<h1>Example novel</h1><h4>Associated Names</h4><p>Original title</p><h4>Original Publisher</h4><p><a href="/opublisher/example/">Example Press</a></p><a href="/?p=123">Release 12</a><a href="/group/example/">Example Translations</a><a href="https://publisher.example.test/series">Publisher page</a>',
      },
    }
    const request = identificationInput(
      { url: 'https://books.example.test/book', html: '<h1>Original title</h1>' },
      'en',
      [],
      reference,
    )
    expect(JSON.parse(request[1].content).metadataReference.page.html).toContain('Example Press')
    expect(request[0].content).toContain('PRIMARY WEBSITE text language')
    expect(JSON.parse(request[1].content).referenceContext).toContain(
      'Do not replace an observed primary count',
    )
    expect(
      metadataReferenceSchema.safeParse({
        ...reference,
        page: { ...reference.page, html: '<h1>Performing security verification</h1>' },
      }).success,
    ).toBe(false)
    const inspection = validateNovelInspection(
      {
        classification: 'index',
        title: 'Example novel',
        originalTitle: null,
        author: null,
        originalAuthor: null,
        language: 'en',
        synopses: [],
        coverImage: null,
        genres: [],
        tags: [],
        publicationStatus: null,
        chapterCount: null,
        wordCount: null,
        updatedAt: null,
        additionalMetadata: [
          {
            field: 'Aliases',
            value: ['Original title', 'Another English title'],
            originalField: 'Associated Names',
            originalValue: null,
          },
        ],
        reason: 'A catalog entry',
        chapterLinks: [{ title: 'Chapter 12', url: 'https://www.novelupdates.com/?p=123' }],
        indexUrl: 'https://www.novelupdates.com/?p=123',
      },
      reference.page,
    )
    expect(inspection.classification).toBe('catalog')
    expect(inspection.chapterLinks).toEqual([])
    expect(inspection.indexUrl).toBeNull()
    expect(inspection.additionalMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'Original publisher: Example Press',
          value: 'https://www.novelupdates.com/opublisher/example/',
        }),
      ]),
    )
    expect(inspectionAliases(inspection)).toEqual(['Original title', 'Another English title'])
    expect(inspection.additionalMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'Translation group: Example Translations',
          value: 'https://www.novelupdates.com/group/example/',
        }),
        expect.objectContaining({ field: 'Release redirect: Release 12' }),
        expect.objectContaining({ field: 'Related site: Publisher page' }),
      ]),
    )
    expect(
      discoverContents(
        {
          url,
          title: 'Release list',
          truncated: false,
          links: [
            { title: 'Chapter 12', url: 'https://www.novelupdates.com/?p=123' },
            { title: 'Chapter 11', url: 'https://www.novelupdates.com/?p=122' },
          ],
        },
        inspection,
      ).foundCount,
    ).toBe(0)
    expect(
      rankLibraryMatches(inspection, url, [
        entry('alias-match', 'An unrelated rendering', { aliases: ['Another English title'] }),
      ])[0].bookId,
    ).toBe('alias-match')
  })
  it('captures the Novel Updates series block without oversized reviews or hidden editing hints', () => {
    const dom = new JSDOM(
      `<html><body><div class="w-blog-content"><div class="seriestitlenu">Example novel</div><h5>Associated Names</h5><span class="editmsg">EDITOR_HINT</span><div id="editassociated">A different title<br>\u9752\u5c9a\u6e21\u53e3</div><h5>Original Publisher</h5><div id="showopublisher">Example Press</div><h4>Description</h4><p>An original fixture synopsis.</p><a href="/group/fixture/">Fixture Translations</a></div><section id="comments">${'Unrelated review content '.repeat(5000)}</section></body></html>`,
      { url: 'https://www.novelupdates.com/series/fixture/' },
    )
    try {
      const captured = captureCurrentPage(dom.window.document)
      expect(captured.html.length).toBeLessThan(1000)
      expect(captured.html).toContain('A different title')
      expect(captured.html).toContain('Example Press')
      expect(captured.html).toContain('/group/fixture/')
      expect(captured.html).not.toMatch(/EDITOR_HINT|Unrelated review/)
    } finally {
      dom.window.close()
    }
  })

  it('recognizes translated/original titles and already-linked sources without merging books', () => {
    const books = [
      entry('one', 'Ten Days, One Talent', { originalTitle: '\u5341\u5929\u4e00\u5929\u8d4b' }),
      entry('two', 'Another book', {
        sources: [
          {
            id: 'source',
            url: 'https://english.example/novel',
            label: 'English',
            language: 'en',
            role: 'reference',
          },
        ],
      }),
    ]
    const matches = rankLibraryMatches(
      {
        title: 'A new English rendering',
        originalTitle: '\u5341\u5929\u4e00\u5929\u8d4b',
        author: null,
        indexUrl: null,
      },
      'https://english.example/novel',
      books,
    )
    expect(matches.map((match) => match.bookId)).toEqual(['two', 'one'])
    expect(matches[0].reason).toContain('already linked')
    expect(books[0].sources).toEqual([])
  })
  it('suggests fuzzy titles but does not pair unrelated books merely because both authors are anonymous', () => {
    const books = [
      entry('related', 'Every Ten Days I Gain a Talent'),
      entry('unrelated', 'The Secret Garden'),
    ]
    const matches = rankLibraryMatches(
      {
        title: 'I Gain New Talent Every Ten Days',
        originalTitle: null,
        author: 'Unknown author',
        indexUrl: null,
      },
      'https://site.example/book',
      books,
    )
    expect(matches[0].bookId).toBe('related')
    expect(matches.some((match) => match.bookId === 'unrelated')).toBe(false)
  })
  it('bounds cross-language comparison, filters invented IDs and requires consent', async () => {
    const inspection: NovelInspection = {
      classification: 'index',
      title: 'Lord of the Myriad Divinities',
      originalTitle: null,
      author: 'An author',
      originalAuthor: null,
      language: 'en',
      synopses: [
        {
          label: 'Synopsis',
          text: 'A distinctive adventure with the same protagonist.',
          originalText: null,
        },
      ],
      coverImage: null,
      genres: ['Fantasy'],
      tags: [],
      publicationStatus: null,
      chapterCount: null,
      wordCount: null,
      updatedAt: null,
      additionalMetadata: [],
      reason: 'An index.',
      chapterLinks: [],
      indexUrl: null,
    }
    const books = Array.from({ length: LIBRARY_COMPARISON_LIMIT + 5 }, (_, index) =>
      entry(`book-${index}`, index === 0 ? '\u4e07\u795e\u4e3b\u5bb0' : `Other book ${index}`, {
        description: 'A'.repeat(1500),
      }),
    )
    mocks.parse.mockResolvedValueOnce({
      status: 'completed',
      output_parsed: {
        matches: [
          {
            bookId: 'book-0',
            reason: 'The supplied title meaning and distinctive synopsis may match.',
          },
          { bookId: 'invented', reason: 'Invalid candidate' },
          { bookId: 'book-0', reason: 'Duplicate' },
        ],
      },
      usage: { input_tokens: 800, output_tokens: 100 },
    })
    const result = await chooseLibraryMatches(inspection, 'https://english.example/book', books, {
      model: 'gpt-5-nano',
      apiKey: 'test-only',
    })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ bookId: 'book-0', method: 'model' })
    expect(result.candidatesCompared).toBe(LIBRARY_COMPARISON_LIMIT)
    expect(result.librarySize).toBe(books.length)
    const request = mocks.parse.mock.calls[0][0]
    expect(request).toMatchObject({
      model: 'gpt-5-nano',
      store: false,
      max_output_tokens: 1200,
      reasoning: { effort: 'minimal' },
    })
    expect(JSON.parse(request.input[1].content).candidates[0].synopsis).toHaveLength(600)
    expect(result.cost?.estimatedUsd).toBeGreaterThan(0)
    expect(
      libraryMatchRequestSchema.safeParse({ recordId: crypto.randomUUID(), confirmed: false })
        .success,
    ).toBe(false)
    expect(books[0].sources).toEqual([])
  })
})
