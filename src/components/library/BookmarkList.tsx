import { Link } from 'react-router-dom'
import { Bookmark, Trash2 } from 'lucide-react'
import { useLibrary } from '../../app/library-context'
import type { LibraryBook } from '../../lib/books'
import { BookCover, IconButton } from '../ui'

export function BookmarkList({ books }: { books: LibraryBook[] }) {
  const { patchBook } = useLibrary()
  const bookmarks = books
    .flatMap((book) => book.bookmarks.map((bookmark) => ({ book, bookmark })))
    .sort((first, second) => second.bookmark.createdAt - first.bookmark.createdAt)
  return bookmarks.length ? (
    <div className="bookmark-list">
      {bookmarks.map(({ book, bookmark }) => (
        <div key={bookmark.id} className="bookmark-row">
          <Link to={`/read/${book.id}/${bookmark.chapter}?at=${bookmark.offset}`}>
            <BookCover book={book} />
            <div>
              <small>{book.title}</small>
              <h3>{bookmark.title}</h3>
              <span>
                Chapter {bookmark.chapter + 1} <span className="footer-dot">/</span>{' '}
                {Math.round(bookmark.offset * 100)}% through chapter
              </span>
            </div>
          </Link>
          <IconButton
            label={`Remove bookmark for ${bookmark.title}`}
            onClick={() => {
              void patchBook(book.id, (current) => ({
                ...current,
                bookmarks: current.bookmarks.filter((saved) => saved.id !== bookmark.id),
              }))
            }}
          >
            <Trash2 size={17} />
          </IconButton>
        </div>
      ))}
    </div>
  ) : (
    <div className="empty-state">
      <Bookmark size={30} strokeWidth={1.2} />
      <h2>No bookmarks yet</h2>
      <p>Your saved places will appear here.</p>
    </div>
  )
}
