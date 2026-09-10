import { startTransition, useDeferredValue, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Plus,
  ArrowRight,
  LayoutGrid,
  List,
  Search,
  X,
  ChevronDown,
  FolderOpen,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { useLibrary } from '../app/library-context'
import { readSetting, writeSetting } from '../lib/preferences'
import { readingProgress } from '../lib/books'
import { readLink } from '../lib/library/presentation'
import { BookCover, IconButton, ProgressBar } from '../components/ui'
import { readingTime } from '../lib/format'
import { BookTile } from '../components/library/BookTile'
import { BookTable } from '../components/library/BookTable'

export function LibraryView() {
  const { books, openImport } = useLibrary()
  const [params, setParams] = useSearchParams()
  const filter = params.get('shelf') || 'all'
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [sort, setSort] = useState('recent')
  const [view, setView] = useState<'grid' | 'list'>(() =>
    readSetting<string>('novelist-view', 'grid') === 'list' ? 'list' : 'grid',
  )
  const paginationKey = `${filter}|${deferredQuery}|${sort}`
  const [pagination, setPagination] = useState({ key: paginationKey, page: 0 })
  const page = pagination.key === paginationKey ? pagination.page : 0
  const setPage = (nextPage: number) => setPagination({ key: paginationKey, page: nextPage })
  const current = [...books]
    .filter((book) => book.status === 'reading')
    .sort((first, second) => second.lastReadAt - first.lastReadAt)[0]
  const featured = current ?? books.find((book) => book.title.includes('Alice')) ?? books[0]
  const filtered = books
    .filter(
      (book) =>
        (filter === 'all' || book.status === filter) &&
        `${book.title} ${book.author} ${book.genre}`
          .toLowerCase()
          .includes(deferredQuery.toLowerCase()),
    )
    .sort((first, second) =>
      sort === 'title'
        ? first.title.localeCompare(second.title)
        : sort === 'author'
          ? first.author.localeCompare(second.author)
          : sort === 'progress'
            ? readingProgress(second) - readingProgress(first)
            : (second.lastReadAt || second.addedAt) - (first.lastReadAt || first.addedAt),
    )
  const visible = filtered.slice(page * 24, (page + 1) * 24)
  const tabs = [
    { key: 'all', label: 'All books', count: books.length },
    {
      key: 'reading',
      label: 'Reading',
      count: books.filter((book) => book.status === 'reading').length,
    },
    {
      key: 'unread',
      label: 'To read',
      count: books.filter((book) => book.status === 'unread').length,
    },
    {
      key: 'finished',
      label: 'Finished',
      count: books.filter((book) => book.status === 'finished').length,
    },
  ]
  return (
    <main className="library-page">
      <div className="page-heading">
        <div>
          <h1>Library</h1>
        </div>
        <button className="button primary" onClick={openImport}>
          <Plus size={17} /> Import book
        </button>
      </div>
      {featured && filter === 'all' && !query && (
        <section className="reading-shelf" aria-labelledby="reading-shelf-title">
          <div className="section-heading">
            <h2 id="reading-shelf-title">
              {current ? 'Continue reading' : 'On your reading list'}
            </h2>
          </div>
          <div className="shelf-content">
            <Link to={`/books/${featured.id}`} className="featured-cover-link">
              <BookCover book={featured} />
            </Link>
            <div className="shelf-book">
              <span className="genre-label">{featured.genre}</span>
              <Link to={`/books/${featured.id}`}>
                <h3>{featured.title}</h3>
              </Link>
              <p>{featured.author}</p>
              <div className="shelf-position">
                {current
                  ? `Chapter ${featured.progress.chapter + 1} of ${featured.chapters.length}`
                  : `${featured.chapters.length} chapters`}
                <span className="meta-dot" />
                {readingTime(featured.wordCount)} read
              </div>
              <div className="shelf-progress">
                <ProgressBar value={readingProgress(featured)} />
                <span>{readingProgress(featured)}%</span>
              </div>
              <Link className="button primary" to={readLink(featured)}>
                {current ? 'Continue reading' : 'Start reading'}
                <ArrowRight size={17} />
              </Link>
            </div>
          </div>
        </section>
      )}
      <section className="book-collection" aria-label="Book collection">
        <div className="collection-top">
          <div className="filter-tabs" role="tablist" aria-label="Library filter">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={filter === tab.key}
                onClick={() =>
                  startTransition(() => setParams(tab.key === 'all' ? {} : { shelf: tab.key }))
                }
              >
                {tab.label}
                <span>{tab.count}</span>
              </button>
            ))}
          </div>
          <div className="view-switch segmented">
            <IconButton
              label="Grid view"
              aria-pressed={view === 'grid'}
              className={view === 'grid' ? 'selected' : ''}
              onClick={() => {
                setView('grid')
                writeSetting('novelist-view', 'grid')
              }}
            >
              <LayoutGrid size={17} />
            </IconButton>
            <IconButton
              label="Table view"
              aria-pressed={view === 'list'}
              className={view === 'list' ? 'selected' : ''}
              onClick={() => {
                setView('list')
                writeSetting('novelist-view', 'list')
              }}
            >
              <List size={18} />
            </IconButton>
          </div>
        </div>
        <div className="collection-toolbar">
          <label className="search-field">
            <Search size={17} />
            <input
              aria-label="Search library"
              placeholder="Search your library..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <IconButton label="Clear library search" onClick={() => setQuery('')}>
                <X size={15} />
              </IconButton>
            )}
          </label>
          <div className="sort-field">
            <span>Sort by</span>
            <select
              aria-label="Sort books"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="recent">Recently opened</option>
              <option value="title">Title</option>
              <option value="author">Author</option>
              <option value="progress">Reading progress</option>
            </select>
            <ChevronDown size={14} />
          </div>
        </div>
        {visible.length ? (
          view === 'grid' ? (
            <div className="book-grid">
              {visible.map((book) => (
                <BookTile key={book.id} book={book} />
              ))}
            </div>
          ) : (
            <BookTable books={visible} />
          )
        ) : (
          <div className="empty-state">
            <FolderOpen size={32} strokeWidth={1.3} />
            <h2>{query ? 'No books found' : 'Nothing on this shelf yet'}</h2>
            {query && <p>No matches for &quot;{query}&quot;.</p>}
            {(query || filter !== 'all') && (
              <button className="button" onClick={() => (query ? setQuery('') : setParams({}))}>
                {query ? 'Clear search' : 'View all books'}
              </button>
            )}
          </div>
        )}
        <div className="collection-footer">
          <span>
            {filtered.length} {filtered.length === 1 ? 'book' : 'books'}
          </span>
          {filtered.length > 24 && (
            <div className="pagination">
              <IconButton
                label="Previous books page"
                disabled={!page}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft size={18} />
              </IconButton>
              <span>
                {page + 1} / {Math.ceil(filtered.length / 24)}
              </span>
              <IconButton
                label="Next books page"
                disabled={(page + 1) * 24 >= filtered.length}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight size={18} />
              </IconButton>
            </div>
          )}
        </div>
      </section>
    </main>
  )
}
