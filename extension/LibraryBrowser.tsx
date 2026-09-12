import { useState } from 'react'
import { Check, ExternalLink, Link2, LoaderCircle, RotateCw, Search } from 'lucide-react'
import type { LibraryEntry } from '../src/lib/extension/library-catalog'
import type { PanelMessage, PanelState } from './protocol'
import { isNovelUpdatesSeries } from '../src/lib/extension/metadata'

export function LibraryBrowser({
  state,
  pending,
  action,
}: {
  state: PanelState
  pending: boolean
  action: (message: PanelMessage) => Promise<boolean>
}) {
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(20)
  const library = state.connected ? (state.library ?? []) : []
  const sourceUrl = state.capture?.page.url ?? ''
  const filtered = library.filter((book) =>
    `${book.title} ${book.originalTitle} ${book.author} ${book.aliases.join(' ')} ${book.sources.map((source) => `${source.label} ${source.url}`).join(' ')}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  )
  const locked =
    pending ||
    state.job?.state === 'running' ||
    state.navigation?.state === 'running' ||
    state.scanningContents
  const catalogPage = isNovelUpdatesSeries(sourceUrl)
  const controls = (book: LibraryEntry) => (
    <div className="catalog-book-actions">
      <a
        className="icon-button"
        href={`${state.backendOrigin}/books/${book.id}`}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${book.title} in Novelist`}
        title="Open in Novelist"
      >
        <ExternalLink size={16} />
      </a>
      {book.sources.some((source) => source.url === sourceUrl) ? (
        <span className="catalog-linked">
          <Check size={14} />
          Linked
        </span>
      ) : catalogPage ? (
        <button
          className="button"
          disabled={locked || !state.connected}
          title={`Attach this Novel Updates catalog to ${book.title}`}
          onClick={() =>
            void action({ type: 'link-novelupdates', url: sourceUrl, bookId: book.id })
          }
        >
          <Link2 size={14} />
          Attach Novel Updates
        </button>
      ) : null}
    </div>
  )

  return (
    <section className="library-browser" aria-label="Your library">
      <div className="section-title">
        <h2>Your library</h2>
        <button
          className="icon-button"
          title="Refresh library"
          aria-label="Refresh library"
          disabled={!state.connected || locked}
          onClick={() => void action({ type: 'library' })}
        >
          <RotateCw size={17} />
        </button>
      </div>
      {!state.connected ? (
        <p className="usage-note">No library connected.</p>
      ) : (
        <>
          {state.libraryError && (
            <p className="sample-error" role="alert">
              {state.libraryError}
            </p>
          )}
          {state.library === undefined && !state.libraryError && (
            <p className="working" role="status">
              <LoaderCircle className="spin" size={17} />
              Loading library
            </p>
          )}
          <label className="catalog-search">
            <Search size={16} />
            <input
              aria-label="Search your library"
              placeholder="Search titles, authors or sources"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setLimit(20)
              }}
            />
          </label>
          <small>{filtered.length} saved books</small>
          <div className="catalog-books">
            {filtered.slice(0, limit).map((book) => (
              <article className="catalog-book" key={book.id}>
                <h3>{book.title}</h3>
                <p>
                  {book.author} / {book.language}
                </p>
                {book.sources
                  .filter((source) => source.role !== 'metadata' && source.role !== 'contents')
                  .map((source) => (
                    <a
                      className="catalog-source-url"
                      key={source.id}
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      title={source.url}
                    >
                      {source.url}
                    </a>
                  ))}
                {book.originalTitle && book.originalTitle !== book.title && (
                  <p lang={book.language}>{book.originalTitle}</p>
                )}
                {controls(book)}
                {book.sources.length > 0 && (
                  <details>
                    <summary>{book.sources.length} source URLs</summary>
                    <ul>
                      {book.sources.map((source) => (
                        <li key={source.id}>
                          <a href={source.url} target="_blank" rel="noreferrer">
                            {source.label || new URL(source.url).hostname}
                            <ExternalLink size={12} />
                          </a>
                          <small>
                            {source.language} / {new URL(source.url).hostname}
                          </small>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </article>
            ))}
          </div>
          {!filtered.length && state.library && (
            <p className="usage-note">{query ? 'No matching books.' : 'No saved books.'}</p>
          )}
          {filtered.length > limit && (
            <button className="button full-width" onClick={() => setLimit(limit + 20)}>
              Show more books
            </button>
          )}
        </>
      )}
    </section>
  )
}
