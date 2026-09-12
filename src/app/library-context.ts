import { createContext, useContext } from 'react'
import type { LibraryBook } from '../lib/books'

export interface LibraryContextValue {
  books: LibraryBook[]
  theme: 'light' | 'dark'
  setTheme: (theme: 'light' | 'dark') => void
  openImport: () => void
  patchBook: (id: string, change: (book: LibraryBook) => LibraryBook) => Promise<boolean>
  deleteBook: (id: string) => Promise<void>
  rememberSourceReading: (id: string, position: { source: NonNullable<LibraryBook['sourceProgress']>; chapter: number; fraction: number; observedAt: number; finished?: boolean }) => void
  notify: (message: string) => void
}

export const LibraryContext = createContext<LibraryContextValue | null>(null)

export function useLibrary() {
  const context = useContext(LibraryContext)
  if (!context) throw new Error('Library context is unavailable.')
  return context
}
