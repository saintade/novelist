import type { LibraryBook } from '../books'
import { getOriginalFile } from './repository'

export function readLink(book: LibraryBook) {
  if (book.format === 'WEB' && book.sourceProgress) {
    const parameters = new URLSearchParams()
    if (book.sourceProgress.language) parameters.set('translated', book.sourceProgress.language)
    if (book.sourceProgress.versionId && book.status !== 'finished') parameters.set('version', book.sourceProgress.versionId)
    return `/read-source/${book.id}/${book.sourceProgress.sourceId}/${book.status === 'finished' ? 0 : book.progress.chapter}${parameters.size ? `?${parameters}` : ''}`
  }
  if (book.format === 'WEB' && !book.chapters.length) return `/books/${book.id}`
  return `/read/${book.id}/${book.status === 'finished' ? 0 : book.progress.chapter}`
}

export function statusLabel(book: LibraryBook) {
  return book.status === 'reading' ? 'Reading' : book.status === 'finished' ? 'Finished' : 'To read'
}

export function bookSourceLabel(book: Pick<LibraryBook, 'sourceUrl' | 'source' | 'format'>) {
  try {
    if (book.sourceUrl) return new URL(book.sourceUrl).hostname.replace(/^www\./, '')
  } catch {
    return book.source || `${book.format} import`
  }
  return book.source || `${book.format} import`
}

export async function downloadBook(book: LibraryBook, notify: (message: string) => void) {
  try {
    const file = await getOriginalFile(book.id)
    if (!file) throw new Error('Missing file')
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = `${book.title.replace(/[/\\]/g, '-')}.${book.format.toLowerCase()}`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 15_000)
  } catch {
    notify('The original file could not be downloaded.')
  }
}
