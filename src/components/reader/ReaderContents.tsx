import { useState } from 'react'
import { Bookmark as BookmarkIcon, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { chapterTitle, type LibraryBook } from '../../lib/books'
import { Dialog, IconButton } from '../ui'

interface Props {
  book: LibraryBook
  index: number
  onNavigate: (index: number, offset?: number) => void
  onClose: () => void
}

export function ReaderContents({ book, index, onNavigate, onClose }: Props) {
  const [contentsTab, setContentsTab] = useState<'chapters' | 'bookmarks'>('chapters')
  const [chapterSearch, setChapterSearch] = useState('')
  const [chapterPage, setChapterPage] = useState(0)
  const chapters = book.chapters
    .map((entry, chapterIndex) => ({ ...entry, index: chapterIndex }))
    .filter((entry) =>
      `${entry.index + 1} ${entry.title}`.toLowerCase().includes(chapterSearch.toLowerCase()),
    )
  const pages = Math.max(1, Math.ceil(chapters.length / 50))
  return (
    <Dialog title="Contents" className="drawer drawer-left" onClose={() => onClose()}>
      <p className="drawer-book-title">{book.title}</p>
      <div className="filter-tabs" role="tablist" aria-label="Book navigation">
        <button
          role="tab"
          aria-selected={contentsTab === 'chapters'}
          onClick={() => setContentsTab('chapters')}
        >
          Chapters <span>{book.chapters.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={contentsTab === 'bookmarks'}
          onClick={() => setContentsTab('bookmarks')}
        >
          Bookmarks <span>{book.bookmarks.length}</span>
        </button>
      </div>
      {contentsTab === 'chapters' ? (
        <>
          <label className="search-field">
            <Search size={17} />
            <input
              aria-label="Search chapters"
              placeholder="Search chapters"
              value={chapterSearch}
              onChange={(event) => {
                setChapterSearch(event.target.value)
                setChapterPage(0)
              }}
            />
          </label>
          <div className="drawer-chapters">
            {chapters.slice(chapterPage * 50, (chapterPage + 1) * 50).map((entry) => (
              <button
                key={entry.id}
                className={`toc-entry ${entry.index === index ? 'active' : ''}`}
                aria-current={entry.index === index ? 'location' : undefined}
                onClick={() => onNavigate(entry.index)}
              >
                <span className="toc-number">{String(entry.index + 1).padStart(2, '0')}</span>
                <span>{chapterTitle(entry.title)}</span>
                {entry.index === index && <span className="current-dot" />}
              </button>
            ))}
            {!chapters.length && <p className="empty-inline">No matching chapters.</p>}
          </div>
          {pages > 1 && (
            <div className="pagination">
              <IconButton
                label="Previous contents page"
                disabled={!chapterPage}
                onClick={() => setChapterPage(chapterPage - 1)}
              >
                <ChevronLeft size={18} />
              </IconButton>
              <span>
                {chapterPage + 1} / {pages}
              </span>
              <IconButton
                label="Next contents page"
                disabled={chapterPage >= pages - 1}
                onClick={() => setChapterPage(chapterPage + 1)}
              >
                <ChevronRight size={18} />
              </IconButton>
            </div>
          )}
        </>
      ) : (
        <div className="drawer-chapters">
          {book.bookmarks.length ? (
            book.bookmarks.map((saved) => (
              <button
                key={saved.id}
                className="toc-entry bookmark-entry"
                onClick={() => onNavigate(saved.chapter, saved.offset)}
              >
                <BookmarkIcon size={17} />
                <span>
                  {saved.title}
                  <small>
                    Chapter {saved.chapter + 1} / {Math.round(saved.offset * 100)}%
                  </small>
                </span>
              </button>
            ))
          ) : (
            <div className="empty-inline">
              <BookmarkIcon size={25} />
              <p>No bookmarks yet.</p>
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}
