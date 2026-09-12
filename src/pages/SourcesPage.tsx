import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, LoaderCircle, RotateCw, Search } from 'lucide-react'
import { useLibrary } from '../app/library-context'
import { ensureSession, supabase } from '../lib/supabase/client'
import { readLibraryCatalog } from '../lib/library/catalog'
import type { LibraryEntry } from '../lib/extension/library-catalog'
import { IconButton } from '../components/ui'

export function SourcesPage() {
  const { books } = useLibrary()
  const [library, setLibrary] = useState<LibraryEntry[]>([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let cancelled = false
    void ensureSession()
      .then(() => readLibraryCatalog(supabase))
      .then((result) => {
        if (!cancelled) {
          setLibrary(result)
          setError('')
        }
      })
      .catch(() => {
        if (!cancelled) setError('The saved source list could not be loaded.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [books, revision])
  const entries = library
    .flatMap((book) => book.sources.map((source) => ({ book, source })))
    .filter(({ book, source }) =>
      `${book.title} ${book.originalTitle} ${source.label} ${source.language} ${source.url}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
  return (
    <main className="library-page source-directory-page">
      <div className="page-heading">
        <h1>Sources</h1>
        <IconButton
          label="Refresh source list"
          onClick={() => {
            setLoading(true)
            setRevision(revision + 1)
          }}
        >
          <RotateCw size={18} />
        </IconButton>
      </div>
      <div className="source-directory-toolbar">
        <label className="search-field">
          <Search size={17} />
          <input
            aria-label="Search saved sources"
            placeholder="Search books, languages or URLs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span>{entries.length} source URLs</span>
      </div>
      {loading && (
        <p className="empty-inline" role="status">
          <LoaderCircle className="spin" size={20} />
          Loading sources
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && !entries.length && (
        <p className="empty-inline">
          {query ? 'No matching sources.' : 'No source URLs saved yet.'}
        </p>
      )}
      <div className="source-directory-list">
        {entries.map(({ book, source }) => (
          <article className="source-directory-row" key={`${book.id}-${source.id}`}>
            <div>
              <Link className="source-book-title" to={`/books/${book.id}`}>
                {book.title}
              </Link>
              <p>
                {source.label} / {source.language} /{' '}
                {source.role === 'reference'
                  ? 'Translated version'
                  : source.role === 'metadata'
                    ? 'Metadata catalog'
                    : source.role === 'contents'
                      ? 'Contents'
                      : 'Original source'}
              </p>
            </div>
            <a href={source.url} target="_blank" rel="noreferrer">
              <span>{source.url}</span>
              <ExternalLink size={16} />
            </a>
          </article>
        ))}
      </div>
    </main>
  )
}
