import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import {
  discoverContents,
  uniqueChapterLinks,
  selectChapterDownloads,
  resolveChapterDestination,
} from '../../src/lib/extension/contents'
import { captureContentsNavigation } from '../../src/lib/scraper/capture'

describe('contents chapter inventory', () => {
  const origin = 'https://books.example.test'
  const inspection = {
    chapterCount: 5,
    indexUrl: `${origin}/book/1/index.html`,
    chapterLinks: [{ title: 'Newest chapter', url: `${origin}/txt/1/3.html` }],
  }
  it('accepts an observed html redirect only to the same chapter already in the source inventory', () => {
    const requested = `${origin}/txt/1/123`
    const canonical = `${requested}.html`
    const chapters = [
      { url: requested, title: 'Chapter 1' },
      { url: canonical, title: 'Chapter 1' },
      { url: `${origin}/txt/1/124.html`, title: 'Chapter 2' },
    ]
    expect(resolveChapterDestination(requested, canonical, chapters)).toBe(canonical)
    expect(resolveChapterDestination(canonical, canonical, chapters)).toBe(canonical)
    expect(() => resolveChapterDestination(requested, chapters[2].url, chapters)).toThrow(
      'different URL',
    )
    expect(() => resolveChapterDestination(requested, canonical, chapters.slice(0, 1))).toThrow(
      'different URL',
    )
    expect(() =>
      resolveChapterDestination(requested, `${canonical}?page=2`, [
        ...chapters,
        { url: `${canonical}?page=2`, title: 'Chapter 1' },
      ]),
    ).toThrow('different URL')
    expect(() =>
      resolveChapterDestination(requested, 'https://other.example.test/txt/1/123.html', chapters),
    ).toThrow('different URL')
  })
  it('counts distinct chapter links and orders newest-first indexes from the beginning', () => {
    const document = new JSDOM(
      `<html><body><a href="/">Home</a><a href="/txt/1/after.html">\u3010\u5f8c\u8a18\u3011</a><a href="/txt/1/final.html">\u3010\u7d42\u7ae0\u3011</a><a href="/txt/1/3.html">\u30103\u3011 Third</a><a href="/txt/1/2.html">\u30102\u3011 Second</a><a href="/txt/1/1.html">\u30101\u3011 First</a><a href="/txt/1/1.html">Duplicate</a><a href="/book/1/index.html?page=2">Next page</a></body></html>`,
      { url: inspection.indexUrl },
    ).window.document
    const result = discoverContents(captureContentsNavigation(document), inspection)
    expect(result.foundCount).toBe(5)
    expect(result.reportedCount).toBe(5)
    expect(result.pageOrder).toBe('newest-first')
    expect(result.chapters.map((chapter) => chapter.title)).toEqual([
      'Chapter 1',
      'Chapter 2',
      'Chapter 3',
      'Final chapter',
      'Afterword',
    ])
    expect(result.nextContentsUrls).toEqual([`${inspection.indexUrl}?page=2`])
  })
  it.each(['Chapter 1: Beginning', '\u7b2c1\u7ae0 \u5f00\u59cb'])(
    'retains chapter one when Read first precedes its table label %s',
    (title) => {
      const dom = new JSDOM(
        `<a href="/txt/1/1.html">Read first</a><a href="/txt/1/2.html">Chapter 2</a><a href="/txt/1/1.html">${title}</a>`,
        { url: inspection.indexUrl },
      )
      const captured = captureContentsNavigation(dom.window.document)
      expect(captured.links).toHaveLength(2)
      expect(captured.links.find((link) => link.url.endsWith('/1.html'))?.title).toBe(title)
      const result = discoverContents(captured, inspection)
      expect(result.chapters[0]).toMatchObject({
        number: 1,
        title: 'Chapter 1',
        url: `${origin}/txt/1/1.html`,
      })
      const raw = discoverContents(
        {
          ...captured,
          links: [{ title: 'Read first', url: `${origin}/txt/1/1.html` }, ...captured.links],
        },
        inspection,
      )
      expect(raw.chapters[0].number).toBe(1)
      dom.window.close()
    },
  )
  it('deduplicates normalized URLs before selecting all chapters or a range', () => {
    const links = [
      { url: '/read/1#top', title: 'Read first' },
      { url: `${origin}/read/1`, title: 'Chapter 1' },
      { url: '/read/2', title: 'Chapter 2' },
      { url: '/read/2#bottom', title: 'Chapter 2 duplicate' },
      { url: '/read/2?page=2', title: 'Chapter 2 part 2' },
      { url: 'https://other.example.test/read/1', title: 'Other source' },
      { url: 'javascript:void(0)', title: 'Unsafe' },
    ]
    expect(uniqueChapterLinks(origin, links)).toEqual([
      { url: `${origin}/read/1`, title: 'Chapter 1' },
      { url: `${origin}/read/2`, title: 'Chapter 2' },
      { url: `${origin}/read/2?page=2`, title: 'Chapter 2 part 2' },
    ])
    expect(selectChapterDownloads(origin, links)).toHaveLength(3)
    expect(selectChapterDownloads(origin, links, 2, 3).map((chapter) => chapter.url)).toEqual([
      `${origin}/read/2`,
      `${origin}/read/2?page=2`,
    ])
    expect(() => selectChapterDownloads(origin, links, 0, 2)).toThrow('range')
    expect(() => selectChapterDownloads(origin, links, 1, 4)).toThrow('range')
    expect(
      uniqueChapterLinks(origin, [
        { url: '/#/chapter/1', title: 'Chapter 1' },
        { url: '/#/chapter/2', title: 'Chapter 2' },
        { url: '/#/chapter/1', title: 'Duplicate' },
      ]),
    ).toHaveLength(2)
    expect(
      discoverContents(
        { url: origin, title: 'Contents', links, truncated: false },
        { chapterCount: null, chapterLinks: [], indexUrl: null },
      ).foundCount,
    ).toBe(3)
  })
  it('distinguishes a reported count from the links found on a partial page', () => {
    const result = discoverContents(
      {
        url: inspection.indexUrl,
        title: 'Contents',
        links: [{ title: 'Chapter 754', url: `${origin}/txt/1/754.html` }],
        truncated: false,
      },
      { ...inspection, chapterCount: 754 },
    )
    expect(result.foundCount).toBe(1)
    expect(result.reportedCount).toBe(754)
    expect(result.pageOrder).toBe('unknown')
  })
  it('can find a numbered contents group without model-provided sample links', () => {
    const result = discoverContents(
      {
        url: inspection.indexUrl,
        title: 'Contents',
        links: [
          { title: 'Chapter 2', url: `${origin}/txt/1/2.html` },
          { title: 'Chapter 1', url: `${origin}/txt/1/1.html` },
          { title: 'Log in', url: 'https://other.example/login' },
        ],
        truncated: true,
      },
      { ...inspection, chapterLinks: [] },
    )
    expect(result.chapters[0].number).toBe(1)
    expect(result.foundCount).toBe(2)
    expect(result.truncated).toBe(true)
  })
  it('does not count unrelated root-level links as chapters', () => {
    const result = discoverContents(
      {
        url: `${origin}/book.html`,
        title: 'Book',
        links: [
          { title: 'Chapter 2', url: `${origin}/chapter-2.html` },
          { title: 'Chapter 1', url: `${origin}/chapter-1.html` },
          { title: 'Contact', url: `${origin}/contact.html` },
          { title: 'Another book', url: `${origin}/book-17.html` },
        ],
        truncated: false,
      },
      {
        chapterCount: 2,
        indexUrl: null,
        chapterLinks: [{ title: 'Chapter 2', url: `${origin}/chapter-2.html` }],
      },
    )
    expect(result.foundCount).toBe(2)
    expect(result.chapters[0].url).toBe(`${origin}/chapter-1.html`)
  })
})
