import { startTransition, useDeferredValue, useEffect, useState } from 'react'
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
  FolderPlus,
  Pencil,
  Trash2,
} from 'lucide-react'
import { useLibrary } from '../app/library-context'
import { readSetting, writeSetting } from '../lib/preferences'
import { readingProgress } from '../lib/books'
import { readLink } from '../lib/library/presentation'
import { BookCover, Dialog, IconButton, ProgressBar } from '../components/ui'
import {
  getLibraryFolders,
  removeLibraryFolder,
  saveLibraryFolder,
  type LibraryFolder,
} from '../lib/library/repository'
import { bookSourceLabel } from '../lib/library/presentation'
import { readingTime } from '../lib/format'
import { BookTile } from '../components/library/BookTile'
import { BookTable } from '../components/library/BookTable'

export function LibraryView() {
  const { books, openImport, notify } = useLibrary()
  const [params, setParams] = useSearchParams()
  const filter = params.get('shelf') || 'all'
  const folderId = params.get('folder') || ''
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [folderAction, setFolderAction] = useState<'create' | 'rename' | 'delete' | null>(null)
  const [folderName, setFolderName] = useState('')
  const [folderError, setFolderError] = useState('')
  const [folderBusy, setFolderBusy] = useState(false)
  const currentFolder = folders.find((folder) => folder.id === folderId)
  const selectFolder = (id: string) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous)
      if (id) next.set('folder', id)
      else next.delete('folder')
      return next
    })
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      void getLibraryFolders()
        .then((saved) => {
          if (!cancelled) setFolders(saved)
        })
        .catch((failure) => {
          if (!cancelled)
            setFolderError(
              failure instanceof Error ? failure.message : 'Folders could not be loaded.',
            )
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
    }
  }, [])
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [sort, setSort] = useState('recent')
  const [view, setView] = useState<'grid' | 'list'>(() =>
    readSetting<string>('novelist-view', 'grid') === 'list' ? 'list' : 'grid',
  )
  const paginationKey = `${folderId}|${filter}|${deferredQuery}|${sort}`
  const [pagination, setPagination] = useState({ key: paginationKey, page: 0 })
  const page = pagination.key === paginationKey ? pagination.page : 0
  const setPage = (nextPage: number) => setPagination({ key: paginationKey, page: nextPage })
  const current = [...books]
    .filter((book) => book.status === 'reading')
    .sort((first, second) => second.lastReadAt - first.lastReadAt)[0]
  const featured = current ?? books.find((book) => book.title.includes('Alice')) ?? books[0]
  const folderBooks = books.filter(
    (book) => !folderId || (folderId === 'unfiled' ? !book.folderId : book.folderId === folderId),
  )
  const filtered = folderBooks
    .filter(
      (book) =>
        (filter === 'all' || book.status === filter) &&
        `${book.title} ${book.author} ${book.genre} ${book.sourceUrl ?? ''} ${book.source}`
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
    { key: 'all', label: 'All books', count: folderBooks.length },
    {
      key: 'reading',
      label: 'Reading',
      count: folderBooks.filter((book) => book.status === 'reading').length,
    },
    {
      key: 'unread',
      label: 'To read',
      count: folderBooks.filter((book) => book.status === 'unread').length,
    },
    {
      key: 'finished',
      label: 'Finished',
      count: folderBooks.filter((book) => book.status === 'finished').length,
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
      {featured && !query && (
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
              <Link to={`/books/${featured.id}`}>
                <h3>{featured.title}</h3>
              </Link>
              <p>{featured.author}</p>
              <p className="featured-source" title={featured.sourceUrl || featured.source}>
                {bookSourceLabel(featured)}
              </p>
              <div className="shelf-position">
                {featured.format === 'WEB'
                  ? current ? `Chapter ${featured.progress.chapter + 1}${featured.sourceProgress?.language ? ` / ${featured.sourceProgress.language}` : ''}` : 'Web book'
                  : current
                  ? `Chapter ${featured.progress.chapter + 1} of ${featured.chapters.length}`
                  : `${featured.chapters.length} chapters`}
                {featured.format !== 'WEB' && <><span className="meta-dot" />{readingTime(featured.wordCount)} read</>}
              </div>
              {featured.format !== 'WEB' && <div className="shelf-progress">
                <ProgressBar value={readingProgress(featured)} />
                <span>{readingProgress(featured)}%</span>
              </div>}
              <Link className="button primary" to={readLink(featured)}>
                {featured.format === 'WEB' && !featured.sourceProgress
                  ? 'View book'
                  : current
                    ? 'Continue reading'
                    : 'Start reading'}
                <ArrowRight size={17} />
              </Link>
            </div>
          </div>
        </section>
      )}
      <section className="book-collection" aria-label="Book collection">
        <div className="library-folders" aria-label="Library folders">
          <label>
            <FolderOpen size={17} />
            <select
              aria-label="Folder"
              value={folderId}
              onChange={(event) => selectFolder(event.target.value)}
            >
              <option value="">All folders ({books.length})</option>
              <option value="unfiled">
                Unfiled ({books.filter((book) => !book.folderId).length})
              </option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name} ({books.filter((book) => book.folderId === folder.id).length})
                </option>
              ))}
            </select>
          </label>
          <IconButton
            label="New folder"
            onClick={() => {
              setFolderError('')
              setFolderName('')
              setFolderAction('create')
            }}
          >
            <FolderPlus size={17} />
          </IconButton>
          {currentFolder && (
            <>
              <IconButton
                label="Rename folder"
                onClick={() => {
                  setFolderError('')
                  setFolderName(currentFolder.name)
                  setFolderAction('rename')
                }}
              >
                <Pencil size={16} />
              </IconButton>
              <IconButton
                label="Delete folder"
                onClick={() => {
                  setFolderError('')
                  setFolderAction('delete')
                }}
              >
                <Trash2 size={16} />
              </IconButton>
            </>
          )}
        </div>
        {folderError && !folderAction && (
          <p className="form-error" role="alert">
            {folderError}
          </p>
        )}
        <div className="collection-top">
          <div className="filter-tabs" role="tablist" aria-label="Library filter">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={filter === tab.key}
                onClick={() =>
                  startTransition(() =>
                    setParams((previous) => {
                      const next = new URLSearchParams(previous)
                      if (tab.key === 'all') next.delete('shelf')
                      else next.set('shelf', tab.key)
                      return next
                    }),
                  )
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
            {(query || filter !== 'all' || folderId) && (
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
      {folderAction && (
        <Dialog
          title={
            folderAction === 'create'
              ? 'New folder'
              : folderAction === 'rename'
                ? 'Rename folder'
                : 'Delete folder?'
          }
          onClose={() => {
            if (!folderBusy) setFolderAction(null)
          }}
        >
          <form
            className="edit-form"
            onSubmit={async (event) => {
              event.preventDefault()
              setFolderBusy(true)
              setFolderError('')
              try {
                if (folderAction === 'delete' && currentFolder) {
                  await removeLibraryFolder(currentFolder.id)
                  setFolders((previous) =>
                    previous.filter((folder) => folder.id !== currentFolder.id),
                  )
                  selectFolder('')
                  window.dispatchEvent(new Event('focus'))
                  notify('Folder deleted. Books moved to Unfiled.')
                } else {
                  const saved = await saveLibraryFolder(
                    folderName,
                    folderAction === 'rename' ? currentFolder?.id : undefined,
                  )
                  setFolders((previous) =>
                    [...previous.filter((folder) => folder.id !== saved.id), saved].sort(
                      (first, second) => first.name.localeCompare(second.name),
                    ),
                  )
                  selectFolder(saved.id)
                }
                setFolderAction(null)
              } catch (failure) {
                setFolderError(
                  failure instanceof Error ? failure.message : 'Folder could not be saved.',
                )
              } finally {
                setFolderBusy(false)
              }
            }}
          >
            {folderAction === 'delete' ? (
              <p>
                Delete &quot;{currentFolder?.name}&quot;? Its books will move to Unfiled. No books,
                downloads, or translations will be deleted.
              </p>
            ) : (
              <label>
                Folder name
                <input
                  autoFocus
                  required
                  maxLength={80}
                  value={folderName}
                  onChange={(event) => setFolderName(event.target.value)}
                  disabled={folderBusy}
                />
              </label>
            )}
            {folderError && (
              <p className="form-error" role="alert">
                {folderError}
              </p>
            )}
            <div className="dialog-actions">
              <button
                className="button"
                type="button"
                disabled={folderBusy}
                onClick={() => setFolderAction(null)}
              >
                Cancel
              </button>
              <button
                className={`button ${folderAction === 'delete' ? 'danger-button' : 'primary'}`}
                disabled={folderBusy || (folderAction !== 'delete' && !folderName.trim())}
              >
                {folderAction === 'delete'
                  ? 'Delete folder'
                  : folderAction === 'rename'
                    ? 'Rename folder'
                    : 'Create folder'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </main>
  )
}
