import { lazy } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { useLibrary } from '../app/library-context'
import { chapterTitle } from '../lib/books'
import { NotFound } from './NotFoundPage'
const Reader = lazy(() =>
  import('../components/Reader').then((module) => ({ default: module.Reader })),
)

export function ReaderRoute() {
  const { bookId } = useParams()
  const location = useLocation()
  const { books, theme, setTheme, patchBook, notify } = useLibrary()
  const book = books.find((entry) => entry.id === bookId)
  if (!book) return <NotFound />
  return (
    <Reader
      key={`${location.pathname}${location.search}`}
      book={book}
      theme={theme}
      onTheme={setTheme}
      onProgress={async (id, chapter, offset, observedAt) => {
        await patchBook(id, (current) => observedAt < current.lastReadAt ? current : ({
          ...current,
          status: 'reading',
          progress: { chapter, offset },
          lastReadAt: observedAt,
        }))
      }}
      onBookmark={async (id, chapter, offset, existingId) => {
        const saved = await patchBook(id, (current) => ({
          ...current,
          bookmarks: existingId
            ? current.bookmarks.filter((saved) => saved.id !== existingId)
            : [
                ...current.bookmarks,
                {
                  id: crypto.randomUUID(),
                  chapter,
                  offset,
                  title: chapterTitle(current.chapters[chapter].title),
                  createdAt: Date.now(),
                },
              ],
        }))
        if (saved) notify(existingId ? 'Bookmark removed.' : 'Reading position bookmarked.')
      }}
      onFinish={async (finished) => {
        const saved = await patchBook(finished.id, (current) => ({
          ...current,
          status: 'finished',
        }))
        if (saved) notify('Book marked as finished.')
        return saved
      }}
    />
  )
}
