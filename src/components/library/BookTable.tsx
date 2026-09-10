import { Link } from 'react-router-dom'
import { readingProgress, type LibraryBook } from '../../lib/books'
import { statusLabel } from '../../lib/library/presentation'
import { BookCover, ProgressBar } from '../ui'
import { BookMenu } from './BookMenu'

export function BookTable({ books }: { books: LibraryBook[] }) {
  return (
    <div className="table-scroll">
      <table className="book-table">
        <thead>
          <tr>
            <th>Book</th>
            <th>Chapters</th>
            <th>Status</th>
            <th>Progress</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {books.map((book) => (
            <tr key={book.id}>
              <td>
                <Link className="table-book" to={`/books/${book.id}`}>
                  <BookCover book={book} />
                  <span>
                    <strong>{book.title}</strong>
                    <small>{book.author}</small>
                  </span>
                </Link>
              </td>
              <td>
                {book.chapters.length}
                <span className="table-secondary">Available locally</span>
              </td>
              <td>
                <span className={`status-label status-${book.status}`}>
                  <span />
                  {statusLabel(book)}
                </span>
              </td>
              <td>
                <div className="table-progress">
                  <ProgressBar value={readingProgress(book)} />
                  <span>{readingProgress(book)}%</span>
                </div>
              </td>
              <td>
                <BookMenu book={book} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
