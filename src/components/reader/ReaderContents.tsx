import { useLayoutEffect, useRef, useState } from 'react'
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
  const [chapterPage, setChapterPage] = useState(() => Math.floor(index / 50))
  const listRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)
  const chapters = book.chapters
    .map((entry, chapterIndex) => ({ ...entry, index: chapterIndex }))
    .filter((entry) =>
      `${entry.index + 1} ${entry.title}`.toLowerCase().includes(chapterSearch.toLowerCase()),
    )
  const pages = Math.max(1, Math.ceil(chapters.length / 50))
  const page = Math.min(chapterPage, pages - 1)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || contentsTab !== 'chapters') return
    const active = activeRef.current
    if (!active) { list.scrollTop = 0; return }
    const bounds = active.getBoundingClientRect()
    list.scrollTop += bounds.top - list.getBoundingClientRect().top - (list.clientHeight - bounds.height) / 2
  }, [index, page, contentsTab, chapterSearch])
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
                setChapterPage(event.target.value.trim() ? 0 : Math.floor(index / 50))
              }}
            />
          </label>
          <div className="drawer-chapters" ref={listRef}>
            {chapters.slice(page * 50, (page + 1) * 50).map((entry) => (
              <button
                key={entry.id}
                ref={entry.index === index ? activeRef : undefined}
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
                disabled={!page}
                onClick={() => setChapterPage(page - 1)}
              >
                <ChevronLeft size={18} />
              </IconButton>
              <span>
                {page + 1} / {pages}
              </span>
              <IconButton
                label="Next contents page"
                disabled={page >= pages - 1}
                onClick={() => setChapterPage(page + 1)}
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
