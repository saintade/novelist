import { Link } from 'react-router-dom'
import { BookOpen } from 'lucide-react'
import { readingProgress, type LibraryBook } from '../../lib/books'
import { statusLabel } from '../../lib/library/presentation'
import { BookCover, ProgressBar } from '../ui'
import { BookMenu } from './BookMenu'

export function BookTile({ book }: { book: LibraryBook }) {
  const progress = readingProgress(book)
  return (
    <article className="book-tile">
      <Link className="tile-artwork" to={`/books/${book.id}`}>
        <BookCover book={book} />
        <span className="cover-open">
          <BookOpen size={17} /> Open book
        </span>
        <span className="file-label">{book.format}</span>
      </Link>
      <div className="tile-meta">
        <span className="genre-label">{book.genre}</span>
        <BookMenu book={book} />
      </div>
      <Link className="tile-title" to={`/books/${book.id}`}>
        <h3>{book.title}</h3>
      </Link>
      <p className="tile-author">{book.author}</p>
      <div className="tile-progress">
        <span className={`status-label status-${book.status}`}>
          <span />
          {statusLabel(book)}
        </span>
        <span>
          {book.status === 'unread' ? `${book.chapters.length} chapters` : `${progress}%`}
        </span>
      </div>
      <ProgressBar value={progress} />
    </article>
  )
}
