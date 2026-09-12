import { capturedPageSchema, publicPageUrl, type CapturedPage } from './contracts'
import { isNovelUpdatesSeries } from '../extension/metadata'
import { preferChapterTitle } from '../extension/contents'
import {
  contentsCaptureSchema,
  CONTENTS_LINK_LIMIT,
  CONTENTS_CHARACTER_LIMIT,
  type ContentsCapture,
} from '../extension/contracts'

export function captureContentsNavigation(document: Document): ContentsCapture {
  const url = publicPageUrl(document.URL)
  const links: ContentsCapture['links'] = []
  let truncated = false
  let characters = 0
  const found = new Map<string, ContentsCapture['links'][number]>()
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (anchor.closest('[hidden],[aria-hidden="true"]')) continue
    try {
      const target = publicPageUrl(new URL(anchor.getAttribute('href')!, url).href)
      if (new URL(target).origin !== new URL(url).origin) continue
      const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)
      const existing = found.get(target)
      if (existing) {
        if (preferChapterTitle(title, existing.title)) {
          const updatedCharacters = characters + title.length - existing.title.length
          if (updatedCharacters <= CONTENTS_CHARACTER_LIMIT) {
            characters = updatedCharacters
            existing.title = title
          } else truncated = true
        }
        continue
      }
      if (
        links.length >= CONTENTS_LINK_LIMIT ||
        characters + title.length + target.length > CONTENTS_CHARACTER_LIMIT
      ) {
        truncated = true
        continue
      }
      const link = { title, url: target }
      links.push(link)
      found.set(target, link)
      characters += title.length + target.length
    } catch {
      continue
    }
  }
  return contentsCaptureSchema.parse({ url, title: document.title.slice(0, 500), links, truncated })
}

export function captureCurrentPage(sourceDocument: Document): CapturedPage {
  const url = publicPageUrl(sourceDocument.URL)
  const metadataRoot = isNovelUpdatesSeries(url)
    ? sourceDocument.querySelector('.w-blog-content')
    : null
  const root = (metadataRoot ?? sourceDocument.documentElement).cloneNode(true) as HTMLElement
  if (metadataRoot) root.querySelectorAll('.editmsg').forEach((element) => element.remove())
  root
    .querySelectorAll(
      'script,style,template,noscript,form,input,textarea,select,button,iframe,object,embed,[contenteditable],[hidden],[aria-hidden="true"]',
    )
    .forEach((element) => element.remove())
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (element.tagName === 'IMG') {
      const candidates = ['src', 'data-src', 'data-original', 'data-lazy-src'].map((name) =>
        element.getAttribute(name),
      )
      element.removeAttribute('src')
      for (const candidate of candidates) {
        if (!candidate) continue
        try {
          element.setAttribute('src', publicPageUrl(new URL(candidate, url).href))
          break
        } catch {
          continue
        }
      }
    }
    for (const attribute of [...element.attributes]) {
      if (
        /^on|token|secret|session|authorization|password|nonce|csrf/i.test(attribute.name) ||
        ['value', 'srcset', 'style'].includes(attribute.name) ||
        (attribute.name === 'src' && element.tagName !== 'IMG')
      )
        element.removeAttribute(attribute.name)
      if (['href', 'action'].includes(attribute.name)) {
        try {
          publicPageUrl(new URL(attribute.value, url).href)
        } catch {
          element.removeAttribute(attribute.name)
        }
      }
    }
  }
  const comments = sourceDocument.createTreeWalker(root, 128)
  const removed: Node[] = []
  while (comments.nextNode()) removed.push(comments.currentNode)
  removed.forEach((node) => node.parentNode?.removeChild(node))
  return capturedPageSchema.parse({ url, html: root.outerHTML })
}
