import { chapterTitle, type Chapter } from '../books'

export function chapterMarkup(chapter: Chapter, query: string): { html: string; matches: number } {
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
