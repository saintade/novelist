import DOMPurify from 'dompurify'
import type Section from 'epubjs/types/section'
import type { NavItem } from 'epubjs/types/navigation'

export interface ChapterInfo {
  id: string
  title: string
  wordCount: number
}

export interface Chapter extends ChapterInfo {
  html: string
}

export interface Bookmark {
  id: string
  chapter: number
  offset: number
  title: string
  createdAt: number
}

export interface LibraryBook {
  id: string
  ownerId?: string
  title: string
  author: string
  description: string
  language: string
  format: 'EPUB' | 'TXT'
  cover?: string
  genre: string
  chapters: ChapterInfo[]
  wordCount: number
  size: number
  addedAt: number
  lastReadAt: number
  progress: { chapter: number; offset: number }
  status: 'unread' | 'reading' | 'finished'
  bookmarks: Bookmark[]
  source: string
  sourceUrl?: string
}

export interface ImportedBook {
  book: LibraryBook
  chapters: Chapter[]
  file: Blob
}

export const MAX_FILE_SIZE = 50 * 1024 * 1024

export function plainText(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }).trim()
}

export function wordCount(text: string): number {
  return text.match(/\p{Script=Han}|[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu)?.length ?? 0
}

export function sanitizeChapter(html: string): string {
  const safe = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'em',
      'strong',
      'b',
      'i',
      'h1',
      'h2',
      'h3',
      'h4',
      'blockquote',
      'ul',
      'ol',
      'li',
      'div',
      'section',
      'span',
      'img',
      'a',
      'hr',
      'sup',
      'sub',
      'table',
      'thead',
      'tbody',
      'tr',
      'td',
      'th',
      'pre',
      'code',
    ],
    ALLOWED_ATTR: ['id', 'src', 'alt', 'href', 'colspan', 'rowspan'],
    ALLOW_DATA_ATTR: false,
  })
  const template = document.createElement('template')
  template.innerHTML = safe
  for (const image of template.content.querySelectorAll('img')) {
    if (!/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/i.test(image.getAttribute('src') ?? ''))
      image.remove()
  }
  for (const anchor of template.content.querySelectorAll('a')) {
    if (!anchor.getAttribute('href')?.startsWith('#')) anchor.removeAttribute('href')
  }
  return template.innerHTML
}

function paragraphHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .filter((paragraph) => paragraph.trim())
    .map((paragraph) => {
      const element = document.createElement('p')
      element.textContent = paragraph.trim().replace(/\n/g, ' ')
      return element.outerHTML
    })
    .join('\n')
}

export function parseText(text: string, title: string): Chapter[] {
  const normalized = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (!normalized || normalized.includes('\u0000'))
    throw new Error('This file does not contain readable text.')
  const headings = [
    ...normalized.matchAll(
      /^(?:chapter\s+(?:\d+|[ivxlcdm]+)\b[^\n]{0,160}|\u7b2c[^\n]{1,30}[\u7ae0\u56de][^\n]{0,130})$/gim,
    ),
  ]
  const sections: { title: string; text: string }[] = []
  if (!headings.length) sections.push({ title, text: normalized })
  else {
    const preface = normalized.slice(0, headings[0].index).trim()
    if (preface) sections.push({ title: 'Introduction', text: preface })
    headings.forEach((heading, index) => {
      sections.push({
        title: heading[0],
        text: normalized
          .slice(heading.index + heading[0].length, headings[index + 1]?.index)
          .trim(),
      })
    })
  }
  return sections
    .filter((section) => section.text)
    .map((section, index) => ({
      id: `chapter-${index}`,
      title: section.title,
      html: paragraphHtml(section.text),
      wordCount: wordCount(section.text),
    }))
}

function flattenNavigation(items: NavItem[]): NavItem[] {
  return items.flatMap((item) =>
    item.subitems?.length ? flattenNavigation(item.subitems) : [item],
  )
}

function filePart(href: string): string {
  return decodeURIComponent(href.split('#')[0]).replace(/^\.\//, '')
}

async function parseEpub(data: ArrayBuffer): Promise<{
  chapters: Chapter[]
  title: string
  author: string
  description: string
  language: string
  cover?: string
}> {
  const { Book } = await import('epubjs')
  const epub = new Book({ replacements: 'none' })
  epub.opened.catch(() => undefined)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      epub.open(data, 'binary'),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('This EPUB took too long to open.')), 30_000)
      }),
    ])
    const metadata = await epub.loaded.metadata
    const navigation = flattenNavigation((await epub.loaded.navigation).toc)
    const sections: Section[] = []
    epub.spine.each((section: Section) => {
      sections.push(section)
    })
    const chapters: Chapter[] = []
    let totalCharacters = 0
    for (const section of sections) {
      if (!section.linear) continue
      await section.load(epub.load.bind(epub))
      const body = section.document.querySelector('body')
      if (!body) continue
      for (const image of body.querySelectorAll('img')) {
        const source = image.getAttribute('src')
        if (!source || /^(?:https?:|\/\/)/i.test(source)) {
          image.remove()
          continue
        }
        try {
          const path = new URL(
            source,
            `https://epub.local${section.url.startsWith('/') ? '' : '/'}${section.url}`,
          ).pathname
          image.setAttribute('src', await epub.archive.getBase64(path))
        } catch {
          image.remove()
        }
      }
      const items = navigation.filter((item) => filePart(item.href) === filePart(section.href))
      const slices = items.length
        ? items
        : [
            {
              id: section.idref,
              href: section.href,
              label:
                body.querySelector('h1,h2,h3')?.textContent?.trim() ||
                `Section ${chapters.length + 1}`,
            },
          ]
      for (const [index, item] of slices.entries()) {
        const fragment = item.href.split('#')[1]
        const nextFragment = slices[index + 1]?.href.split('#')[1]
        const start = fragment
          ? section.document.getElementById(decodeURIComponent(fragment))
          : null
        const end = nextFragment
          ? section.document.getElementById(decodeURIComponent(nextFragment))
          : null
        let html = body.innerHTML
        if (start && body.contains(start)) {
          const range = section.document.createRange()
          range.setStartBefore(start)
          if (end && body.contains(end)) range.setEndBefore(end)
          else range.setEnd(body, body.childNodes.length)
          const container = document.createElement('div')
          container.append(range.cloneContents())
          html = container.innerHTML
        }
        html = sanitizeChapter(html)
        const text = plainText(html)
        const words = wordCount(text)
        if (words < 8 && !html.includes('<img')) continue
        totalCharacters += html.length
        if (totalCharacters > 40_000_000)
          throw new Error('This book is too large to import into this browser.')
        chapters.push({
          id: `chapter-${chapters.length}`,
          title: plainText(item.label).replace(/\s+/g, ' ') || `Section ${chapters.length + 1}`,
          html,
          wordCount: words,
        })
      }
      section.unload()
    }
    let cover: string | undefined
    const coverPath = await epub.loaded.cover
    if (coverPath) {
      try {
        cover = await epub.archive.getBase64(coverPath)
      } catch {
        cover = undefined
      }
    }
    return {
      chapters,
      title: metadata.title,
      author: metadata.creator,
      description: plainText(metadata.description || ''),
      language: metadata.language || 'en',
      cover,
    }
  } finally {
    clearTimeout(timeout)
    epub.destroy()
  }
}

export async function importBook(
  file: File,
  options: { storyOnly?: boolean } = {},
): Promise<ImportedBook> {
  if (file.size > MAX_FILE_SIZE) throw new Error('Choose a book smaller than 50 MB.')
  if (!file.size) throw new Error('This file is empty.')
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (extension !== 'epub' && extension !== 'txt')
    throw new Error('Choose an EPUB or plain text file.')
  const data = await file.arrayBuffer()
  const hash = await crypto.subtle.digest('SHA-256', data)
  const id = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
  const filenameTitle = file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ')
  const parsed =
    extension === 'epub'
      ? await parseEpub(data)
      : {
          title: filenameTitle,
          author: 'Unknown author',
          description: '',
          language: 'en',
          cover: undefined,
          chapters: parseText(new TextDecoder().decode(data), filenameTitle),
        }
  let chapters = parsed.chapters
  if (options.storyOnly) {
    const story = chapters.filter((chapter) =>
      /^(?:chapter\s+[\divxlcdm]+\b|[ivxlcdm]+[.\s])/i.test(chapter.title),
    )
    if (story.length) chapters = story
  }
  chapters = chapters.map((chapter, index) => ({ ...chapter, id: `chapter-${index}` }))
  if (!chapters.length) throw new Error('No readable chapters were found in this book.')
  return {
    book: {
      id,
      title: parsed.title || filenameTitle,
      author: parsed.author || 'Unknown author',
      description: parsed.description,
      language: parsed.language,
      cover: parsed.cover,
      format: extension === 'epub' ? 'EPUB' : 'TXT',
      genre: 'Uncategorized',
      chapters: chapters.map(({ id: chapterId, title, wordCount: words }) => ({
        id: chapterId,
        title,
        wordCount: words,
      })),
      wordCount: chapters.reduce((total, chapter) => total + chapter.wordCount, 0),
      size: file.size,
      addedAt: Date.now(),
      lastReadAt: 0,
      progress: { chapter: 0, offset: 0 },
      status: 'unread',
      bookmarks: [],
      source: 'Local import',
    },
    chapters,
    file,
  }
}

export function readingProgress(book: LibraryBook): number {
  if (book.status === 'finished') return 100
  if (book.status === 'unread' || !book.wordCount) return 0
  const previous = book.chapters
    .slice(0, book.progress.chapter)
    .reduce((total, chapter) => total + chapter.wordCount, 0)
  const current = book.chapters[book.progress.chapter]?.wordCount ?? 0
  return Math.min(
    99,
    Math.max(0, Math.round(((previous + current * book.progress.offset) / book.wordCount) * 100)),
  )
}

export function chapterTitle(title: string): string {
  const cleaned = title
    .replace(/^chapter\s+[\divxlcdm]+[.:]?\s*/i, '')
    .replace(/^[ivxlcdm]+\.\s+/i, '')
    .trim()
  if (!cleaned) return title
  return cleaned === cleaned.toUpperCase()
    ? cleaned.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase())
    : cleaned
}
