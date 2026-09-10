// @vitest-environment jsdom
import { File as NodeFile } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { chapterTitle, importBook, parseText, readingProgress, sanitizeChapter } from './books'

vi.stubGlobal('File', NodeFile)
vi.stubGlobal('crypto', webcrypto)

describe('book importing', () => {
  it('splits text chapters without losing the introduction or final paragraph', () => {
    const chapters = parseText(
      'A preface.\n\nCHAPTER I. Arrival\n\nThe first paragraph.\n\nCHAPTER II. Home\n\nThe last paragraph.',
      'Example',
    )
    expect(chapters).toHaveLength(3)
    expect(chapters[0].html).toContain('A preface.')
    expect(chapters[2].html).toContain('The last paragraph.')
  })

  it('treats text as text, never executable HTML', () => {
    const [chapter] = parseText('<script>alert(1)</script>\n\nSome text.', 'Example')
    expect(chapter.html).toContain('&lt;script&gt;')
    expect(chapter.html).not.toContain('<script>')
  })

  it('removes scripts, styles, remote images and dangerous links from EPUB content', () => {
    const safe = sanitizeChapter(
      '<p style="position:fixed" onclick="alert(1)">Hello <em>world</em></p><script>alert(1)</script><iframe src="https://example.com"></iframe><img src="https://example.com/tracker"><a href="javascript:alert(1)">bad</a><a href="#note">note</a>',
    )
    expect(safe).toContain('<em>world</em>')
    expect(safe).toContain('href="#note"')
    expect(safe).not.toMatch(/script|iframe|onclick|style=|https:\/\//)
  })

  it('deduplicates identical files by content rather than filename', async () => {
    const first = await importBook(new File(['A small text book.'], 'first.txt'))
    const second = await importBook(new File(['A small text book.'], 'renamed.txt'))
    expect(first.book.id).toBe(second.book.id)
    expect(readingProgress(first.book)).toBe(0)
    expect(readingProgress({ ...first.book, status: 'finished' })).toBe(100)
  })

  it('rejects empty and unsupported files', async () => {
    await expect(importBook(new File([], 'empty.txt'))).rejects.toThrow('empty')
    await expect(importBook(new File(['text'], 'book.pdf'))).rejects.toThrow('EPUB')
  })

  it.each([
    ['alice', 'Alice', 12, 'Alice'],
    ['time-machine', 'Time Machine', 10, 'Time'],
    ['secret-garden', 'Secret Garden', 27, 'Mary'],
  ])(
    'opens the real %s EPUB with readable chapters',
    async (filename, title, minimumChapters, expectedText) => {
      const data = await readFile(`public/books/${filename}.epub`)
      const result = await importBook(new File([new Uint8Array(data)], `${filename}.epub`), {
        storyOnly: true,
      })
      expect(result.book.title).toContain(title)
      expect(result.chapters.length).toBeGreaterThanOrEqual(minimumChapters)
      expect(result.chapters[0].html).toContain(expectedText)
      expect(result.book.wordCount).toBeGreaterThan(10_000)
      expect(result.chapters.every((chapter) => !chapter.html.includes('<script'))).toBe(true)
    },
    20_000,
  )

  it('formats chapter labels without changing mixed-case names', () => {
    expect(chapterTitle('CHAPTER IV. The Little Door')).toBe('The Little Door')
    expect(chapterTitle('CHAPTER I. THE FIRST DAY')).toBe('The First Day')
  })
})
