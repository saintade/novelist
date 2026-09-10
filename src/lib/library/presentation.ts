import type { LibraryBook } from '../books'
import { getOriginalFile } from './repository'

export function readLink(book: LibraryBook) {
  return `/read/${book.id}/${book.status === 'finished' ? 0 : book.progress.chapter}`
}

export function statusLabel(book: LibraryBook) {
  return book.status === 'reading' ? 'Reading' : book.status === 'finished' ? 'Finished' : 'To read'
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
