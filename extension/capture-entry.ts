import { captureCurrentPage, captureContentsNavigation } from '../src/lib/scraper/capture'
import { z } from 'zod'
import { createNavigationDOM } from '../src/lib/extension/navigation-dom'

z.config({ jitless: true })

const scope = globalThis as typeof globalThis & {
  __novelistCapture?: () => unknown
  __novelistContents?: () => unknown
  __novelistNavigation?: ReturnType<typeof createNavigationDOM>
}
scope.__novelistNavigation ??= createNavigationDOM(document)
scope.__novelistContents = () => captureContentsNavigation(document)
scope.__novelistCapture = () => {
  const page = captureCurrentPage(document)
  const parsed = new DOMParser().parseFromString(page.html, 'text/html')
  return {
    page,
    pageTitle: document.title,
    preview: (parsed.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 5000),
  }
}
