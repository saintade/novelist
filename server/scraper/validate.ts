import { isDeepStrictEqual } from 'node:util'
import { load } from 'cheerio'
import {
  publicPageUrl,
  scrapedPageSchema,
  type CapturedPage,
  type PageCheck,
  type ScrapedPage,
} from '../../src/lib/scraper/contracts.ts'

export function prepareCapturedPage(page: CapturedPage): CapturedPage {
  const document = load(page.html)
  document(
    'script,style,template,noscript,form,input,textarea,select,button,iframe,object,embed,[contenteditable],[hidden],[aria-hidden="true"]',
  ).remove()
  document('*').each((_, element) => {
    const node = document(element)
    if (node.is('img')) {
      const candidates = ['src', 'data-src', 'data-original', 'data-lazy-src'].map((name) =>
        node.attr(name),
      )
      node.removeAttr('src')
      for (const candidate of candidates) {
        if (!candidate) continue
        try {
          node.attr('src', publicPageUrl(new URL(candidate, page.url).href))
          break
        } catch {
          continue
        }
      }
    }
    for (const [name, value] of Object.entries(document(element).attr() ?? {})) {
      if (
        /^on|token|secret|session|authorization|password|nonce|csrf/i.test(name) ||
        ['value', 'srcset', 'style'].includes(name) ||
        (name === 'src' && !node.is('img'))
      )
        document(element).removeAttr(name)
      if (['href', 'action'].includes(name)) {
        try {
          publicPageUrl(new URL(value, page.url).href)
        } catch {
          document(element).removeAttr(name)
        }
      }
    }
  })
  document
    .root()
    .find('*')
    .addBack()
    .contents()
    .filter((_, node) => node.type === 'comment')
    .remove()
  return { url: publicPageUrl(page.url), html: document.html() }
}

export function checkScrapedPage(
  value: unknown,
  page: CapturedPage,
  expected?: ScrapedPage,
): PageCheck {
  const parsed = scrapedPageSchema.safeParse(value)
  if (!parsed.success)
    return {
      url: page.url,
      passed: false,
      issues: parsed.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    }
  const output = parsed.data
  const issues: string[] = []
  const document = load(page.html)
  document('script,style,template,noscript').remove()
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
  const sourceText = normalize(document.root().text())
  const hasText = (text: string) => Boolean(normalize(text)) && sourceText.includes(normalize(text))
  const links = new Set<string>()
  document('a[href]').each((_, anchor) => {
    try {
      links.add(publicPageUrl(new URL(document(anchor).attr('href')!, page.url).href))
    } catch {
      return
    }
  })
  const checkLink = (value: string, field: string) => {
    try {
      const url = publicPageUrl(value)
      if (
        new URL(url).origin !== new URL(page.url).origin ||
        !links.has(url) ||
        url === publicPageUrl(page.url)
      )
        issues.push(`${field}: URL must be a distinct same-origin link present in this page.`)
    } catch {
      issues.push(`${field}: URL is not an allowed HTTP(S) destination.`)
    }
  }
  if (output.kind !== 'blocked' && !hasText(output.title))
    issues.push('title: no exact source text.')
  if (output.kind === 'index') {
    if (output.author && !hasText(output.author)) issues.push('author: no exact source text.')
    if (output.synopsis && !hasText(output.synopsis)) issues.push('synopsis: no exact source text.')
    const identities = new Set<string>()
    for (const [index, chapter] of output.chapters.entries()) {
      if (!hasText(chapter.title)) issues.push(`chapters.${index}.title: no exact source text.`)
      checkLink(chapter.url, `chapters.${index}.url`)
      if (identities.has(chapter.url)) issues.push(`chapters.${index}: duplicate chapter URL.`)
      identities.add(chapter.url)
    }
  }
  if (output.kind === 'chapter') {
    let body = ''
    try {
      const selected = document(output.contentSelector)
      if (selected.length !== 1)
        issues.push('contentSelector: must identify one chapter container.')
      body = normalize(selected.text())
    } catch {
      issues.push('contentSelector: invalid selector.')
    }
    for (const [index, paragraph] of output.paragraphs.entries())
      if (!normalize(paragraph) || !body.includes(normalize(paragraph)))
        issues.push(`paragraphs.${index}: no exact text in the selected chapter container.`)
    if (output.nextPageUrl) checkLink(output.nextPageUrl, 'nextPageUrl')
    if (output.nextChapterUrl) checkLink(output.nextChapterUrl, 'nextChapterUrl')
    if (output.nextPageUrl && output.nextPageUrl === output.nextChapterUrl)
      issues.push('Pagination: next page and next chapter cannot be the same destination.')
  }
  if (expected) {
    for (const field of Object.keys(expected))
      if (
        !isDeepStrictEqual(
          output[field as keyof typeof output],
          expected[field as keyof typeof expected],
        )
      )
        issues.push(`${field}: differs from the independently reviewed fixture.`)
  }
  return { url: page.url, passed: issues.length === 0, issues: issues.slice(0, 12), output }
}
