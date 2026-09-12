import { publicPageUrl } from '../scraper/contracts.ts'
import { isNovelUpdatesSeries } from './metadata.ts'
import {
  contentsCaptureSchema,
  type ContentsCapture,
  type ContentsDiscovery,
  type NovelInspection,
} from './contracts.ts'

const chapterNumber = (title: string): number | null => {
  const match = title
    .normalize('NFKC')
    .match(
      /^(?:chapter\s*|\u7b2c\s*|[\u3010[(]\s*)?(\d+(?:\.\d+)?)\s*(?:[\u7ae0\u56de\u8bdd\u8a71.\]\u3011):\s]|$)/i,
    )
  return match && Number(match[1]) <= 1_000_000 ? Number(match[1]) : null
}
const chapterKind = (title: string) => {
  if (/prologue|preface|\u5e8f\u7ae0|\u5e8f\u8a00|\u524d\u8a00/i.test(title)) return 0
  if (/final chapter|\u7d42\u7ae0|\u7ec8\u7ae0/i.test(title)) return 2
  if (/afterword|epilogue|\u5f8c\u8a18|\u540e\u8bb0|\u5c3e\u8072|\u5c3e\u58f0/i.test(title))
    return 3
  return 1
}
const nextPageLabel = /^(?:next(?:\s+page)?|\u4e0b(?:\u4e00)?[\u9875\u9801]|[>\u203a\u00bb])$/i
export function preferChapterTitle(candidate: string, existing: string): boolean {
  const quality = (title: string) =>
    chapterNumber(title) !== null
      ? 3
      : /^\s*\u7b2c[\u96f6\u3007\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\u4e24]+[\u7ae0\u56de\u8bdd\u8a71]/.test(
            title,
          )
        ? 2
        : chapterKind(title) !== 1
          ? 1
          : 0
  return !existing.trim() || quality(candidate) > quality(existing)
}
export function uniqueChapterLinks<
  ChapterLink extends { url: string; title: string; sourceTitle?: string },
>(baseUrl: string, entries: readonly ChapterLink[]): ChapterLink[] {
  const origin = new URL(publicPageUrl(baseUrl)).origin
  const unique = new Map<string, ChapterLink>()
  for (const entry of entries) {
    try {
      const url = publicPageUrl(new URL(entry.url, baseUrl).href)
      if (new URL(url).origin !== origin) continue
      const previous = unique.get(url)
      if (
        !previous ||
        preferChapterTitle(entry.sourceTitle || entry.title, previous.sourceTitle || previous.title)
      )
        unique.set(url, { ...entry, url })
    } catch {
      continue
    }
  }
  return [...unique.values()]
}

export function canonicalChapterUrl(url: string, aliases: unknown): string {
  const normalized = publicPageUrl(url)
  if (!aliases || typeof aliases !== 'object' || !Object.hasOwn(aliases, normalized))
    return normalized
  const target = (aliases as Record<string, unknown>)[normalized]
  return typeof target === 'string'
    ? resolveChapterDestination(normalized, target, [
        { url: normalized, title: '' },
        { url: target, title: '' },
      ])
    : normalized
}

export function resolveChapterDestination(
  requestedUrl: string,
  openedUrl: string,
  chapters: readonly { url: string; title: string }[],
): string {
  const requested = new URL(publicPageUrl(requestedUrl))
  const opened = new URL(publicPageUrl(openedUrl))
  if (opened.href === requested.href) return opened.href
  const known = new Set(uniqueChapterLinks(requested.href, chapters).map((chapter) => chapter.url))
  const samePath =
    requested.pathname.replace(/\.html?$/i, '') === opened.pathname.replace(/\.html?$/i, '')
  if (
    requested.origin === opened.origin &&
    requested.search === opened.search &&
    requested.hash === opened.hash &&
    samePath &&
    known.has(requested.href) &&
    known.has(opened.href)
  )
    return opened.href
  throw new Error(
    `The chapter opened a different URL. Expected: ${requested.href}. Opened: ${opened.href}. No chapter was saved.`,
  )
}

export function selectChapterDownloads(
  baseUrl: string,
  entries: { url: string; title: string }[],
  from = 1,
  to?: number,
) {
  const chapters = uniqueChapterLinks(baseUrl, entries)
  const last = to ?? chapters.length
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(last) ||
    from < 1 ||
    last < from ||
    last > chapters.length
  )
    throw new Error('Choose a range within the available chapter list.')
  return chapters.slice(from - 1, last)
}

const routePath = (value: string) => {
  const url = new URL(value)
  return url.hash
    ? new URL(url.hash.replace(/^#!/, '').replace(/^#/, ''), url.origin).pathname
    : url.pathname
}
const directory = (url: string) => {
  const path = routePath(url)
  return path.slice(0, path.lastIndexOf('/') + 1)
}
const rootFamily = (url: string) => routePath(url).replace(/\d+(?=\D*$)/, '#')

export function discoverContents(
  captured: ContentsCapture,
  inspection: Pick<NovelInspection, 'chapterLinks' | 'chapterCount' | 'indexUrl'>,
): ContentsDiscovery {
  const capture = contentsCaptureSchema.parse(captured)
  if (isNovelUpdatesSeries(capture.url))
    return {
      url: capture.url,
      foundCount: 0,
      numberedCount: 0,
      reportedCount: inspection.chapterCount,
      pageOrder: 'unknown',
      chapters: [],
      nextContentsUrls: [],
      truncated: capture.truncated,
    }
  const origin = new URL(publicPageUrl(capture.url)).origin
  const links = new Map<string, { title: string; number: number | null; position: number }>()
  const nextContentsUrls: string[] = []
  for (const [position, link] of uniqueChapterLinks(capture.url, capture.links).entries()) {
    try {
      const url = publicPageUrl(new URL(link.url, capture.url).href)
      if (new URL(url).origin !== origin || url === capture.url) continue
      const existing = links.get(url)
      if (existing && !preferChapterTitle(link.title, existing.title)) continue
      if (nextPageLabel.test(link.title.trim())) {
        nextContentsUrls.push(url)
        continue
      }
      if (
        !link.title ||
        /\.(?:epub|pdf|zip)$/i.test(new URL(url).pathname) ||
        url === inspection.indexUrl
      )
        continue
      if (
        /^\d+$/.test(link.title.trim()) &&
        [...new URL(url).searchParams.keys()].some((key) => /^(?:page|p)$/i.test(key))
      )
        continue
      links.set(url, { title: link.title, number: chapterNumber(link.title), position })
    } catch {
      continue
    }
  }
  const knownDirectories = new Set(inspection.chapterLinks.map((link) => directory(link.url)))
  const rootFamilies = new Set(
    inspection.chapterLinks
      .filter((link) => directory(link.url) === '/')
      .map((link) => rootFamily(link.url)),
  )
  if (!knownDirectories.size) {
    const groups = new Map<string, number>()
    for (const [url, link] of links)
      if (link.number !== null) groups.set(directory(url), (groups.get(directory(url)) ?? 0) + 1)
    const dominant = [...groups].sort((first, second) => second[1] - first[1])[0]
    if (dominant) knownDirectories.add(dominant[0])
  }
  const chapterDirectories = new Set(
    [...links]
      .filter(([, link]) => link.number !== null)
      .map(([url]) => new URL(directory(url), url).href),
  )
  const candidates = [...links].filter(
    ([url, link]) =>
      knownDirectories.has(directory(url)) &&
      !(link.number === null && chapterKind(link.title) === 1 && chapterDirectories.has(url)) &&
      (directory(url) !== '/' ||
        (rootFamilies.size ? rootFamilies.has(rootFamily(url)) : link.number !== null)) &&
      (link.number !== null ||
        !/^(?:contents|index|home|login|sign in|\u76ee\u9304|\u76ee\u5f55|\u9996\u9801|\u9996\u9875)$/i.test(
          link.title.trim(),
        )),
  )
  const numbers = candidates.map(([, link]) => link.number).filter((number) => number !== null)
  let increasing = 0
  let decreasing = 0
  for (let index = 1; index < numbers.length; index++) {
    if (numbers[index] > numbers[index - 1]) increasing++
    if (numbers[index] < numbers[index - 1]) decreasing++
  }
  const pageOrder =
    increasing && decreasing
      ? 'mixed'
      : decreasing
        ? 'newest-first'
        : increasing
          ? 'oldest-first'
          : 'unknown'
  const chapters = candidates
    .sort((first, second) => {
      const firstKind = chapterKind(first[1].title)
      const secondKind = chapterKind(second[1].title)
      if (firstKind !== secondKind) return firstKind - secondKind
      if (first[1].number !== null && second[1].number !== null)
        return first[1].number - second[1].number
      if (first[1].number !== null) return -1
      if (second[1].number !== null) return 1
      return first[1].position - second[1].position
    })
    .map(([url, link]) => ({
      url,
      sourceTitle: link.title,
      number: link.number,
      title:
        link.number !== null
          ? `Chapter ${link.number}`
          : chapterKind(link.title) === 0
            ? 'Prologue'
            : chapterKind(link.title) === 2
              ? 'Final chapter'
              : chapterKind(link.title) === 3
                ? 'Afterword'
                : 'Unnumbered chapter',
    }))
  return {
    url: capture.url,
    foundCount: chapters.length,
    numberedCount: new Set(numbers).size,
    reportedCount: inspection.chapterCount,
    pageOrder,
    chapters,
    nextContentsUrls: [...new Set(nextContentsUrls)],
    truncated: capture.truncated,
  }
}
