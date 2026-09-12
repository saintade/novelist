import { chapterTitle, type Chapter } from '../books'
import { translatedTermPattern } from '../translation/glossary'

export function chapterMarkup(
  chapter: Chapter,
  query: string,
  terms: { source: string; target: string; display?: string }[] = [],
): { html: string; matches: number } {
  const template = document.createElement('template')
  template.innerHTML = chapter.html
  const heading = template.content.querySelector('h1,h2')
  if (
    heading &&
    (chapterTitle(heading.textContent?.trim().replace(/\s+/g, ' ') || '') ===
      chapterTitle(chapter.title) ||
      /^chapter\s/i.test(heading.textContent?.trim() || ''))
  )
    heading.remove()
  let matches = 0
  const targets = new Map<string, { source: string; target: string } | null>()
  for (const term of terms) {
    if (!term.target.trim() || !term.source.trim()) continue
    const label = term.display ?? term.target
    const existing = targets.get(label)
    targets.set(label, targets.has(label) && (existing?.source !== term.source || existing?.target !== term.target) ? null : term)
  }
  const names = [...targets.keys()]
    .sort((first, second) => second.length - first.length)
  if (names.length) {
    const pattern = translatedTermPattern(names)
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    while (walker.nextNode())
      if (!walker.currentNode.parentElement?.closest('a,button,script,style'))
        nodes.push(walker.currentNode as Text)
    for (const node of nodes) {
      const fragment = document.createDocumentFragment()
      let cursor = 0
      for (const match of node.data.matchAll(pattern)) {
        fragment.append(document.createTextNode(node.data.slice(cursor, match.index)))
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'reader-term'
        const term = targets.get(match[0])
        if (term) {
          button.dataset.sourceTerm = term.source
          button.dataset.targetTerm = term.target
          button.title = `Edit translation of ${term.source}`
        } else {
          button.dataset.ambiguousTerm = match[0]
          button.title = `Review source mappings for ${match[0]}`
        }
        button.textContent = match[0]
        fragment.append(button)
        cursor = match.index + match[0].length
      }
      if (cursor) {
        fragment.append(document.createTextNode(node.data.slice(cursor)))
        node.replaceWith(fragment)
      }
    }
  }
  if (query.trim()) {
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    for (const node of nodes) {
      const text = node.data
      const needle = query.toLowerCase()
      const lower = text.toLowerCase()
      let cursor = 0
      let found = lower.indexOf(needle)
      if (found < 0) continue
      const fragment = document.createDocumentFragment()
      while (found >= 0) {
        fragment.append(document.createTextNode(text.slice(cursor, found)))
        const mark = document.createElement('mark')
        mark.dataset.match = String(matches++)
        mark.textContent = text.slice(found, found + query.length)
        fragment.append(mark)
        cursor = found + query.length
        found = lower.indexOf(needle, cursor)
      }
      fragment.append(document.createTextNode(text.slice(cursor)))
      node.replaceWith(fragment)
    }
  }
  return { html: template.innerHTML, matches }
}
