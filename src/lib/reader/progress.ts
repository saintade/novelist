import type { LibraryBook } from '../books'
import { readSetting, writeSetting } from '../preferences'

interface Checkpoint {
  chapter: number
  offset: number
  savedAt: number
}

function checkpointKey(book: LibraryBook): string {
  return `novelist-position:${book.ownerId ?? 'local'}:${book.id}`
}

export function rememberPosition(book: LibraryBook, chapter: number, offset: number): void {
  writeSetting(checkpointKey(book), { chapter, offset, savedAt: Date.now() })
}

export function restorePosition(
  book: LibraryBook,
  chapter: number,
  explicit: string | null,
): number {
  if (explicit !== null && Number.isFinite(Number(explicit)))
    return Math.max(0, Math.min(1, Number(explicit)))
  if (book.status === 'finished') return 0
  const checkpoint = readSetting<Checkpoint | null>(checkpointKey(book), null)
  if (
    checkpoint?.chapter === chapter &&
    Number.isFinite(checkpoint.offset) &&
    checkpoint.savedAt > book.lastReadAt
  )
    return Math.max(0, Math.min(1, checkpoint.offset))
  return book.progress.chapter === chapter ? book.progress.offset : 0
}
