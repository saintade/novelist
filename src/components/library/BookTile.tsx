import { Link } from 'react-router-dom'
import { BookOpen } from 'lucide-react'
import { readingProgress, type LibraryBook } from '../../lib/books'
import { bookSourceLabel, statusLabel } from '../../lib/library/presentation'
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
        <BookMenu book={book} />
      </div>
      <Link className="tile-title" to={`/books/${book.id}`} title={book.title}>
        <h3>{book.title}</h3>
      </Link>
      <p className="tile-author" title={book.author}>
        {book.author}
      </p>
      <p className="tile-source" title={book.sourceUrl || book.source}>
        {bookSourceLabel(book)} / {book.language}
      </p>
      <div className="tile-progress">
        <span className={`status-label status-${book.status}`}>
          <span />
          {statusLabel(book)}
        </span>
        <span>
          {book.status === 'unread'
            ? `${book.format === 'WEB' ? (book.catalog?.contents?.foundCount ?? 0) : book.chapters.length} chapters`
            : `${progress}%`}
        </span>
      </div>
      <ProgressBar value={progress} />
    </article>
  )
}
