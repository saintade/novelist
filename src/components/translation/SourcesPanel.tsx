import { useState } from 'react'
import { ExternalLink, Plus, Trash2 } from 'lucide-react'
import type { LibraryBook } from '../../lib/books'
import {
  attachBookCatalog,
  removeNovelSource,
  type NovelSource,
} from '../../lib/translation/repository'
import { Dialog } from '../ui'

export function SourcesPanel({
  book,
  sources,
  refresh,
}: {
  book: LibraryBook
  sources: NovelSource[]
  refresh: () => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<NovelSource | null>(null)
  const [notice, setNotice] = useState('')
  const linkedSources = sources.filter((source) => source.url)
  return (
    <section aria-label="Novel sources">
      <div className="translation-toolbar">
        <span className="muted">
          {linkedSources.length} {linkedSources.length === 1 ? 'URL' : 'URLs'}
        </span>
        <button
          className="button"
          onClick={() => {
            setError('')
            setAdding(true)
          }}
        >
          <Plus size={16} /> Link Novel Updates
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && !adding && !removing && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="source-list">
        {linkedSources.map((source) => (
          <article className="source-row" key={source.id}>
            <a className="source-url" href={source.url!} target="_blank" rel="noreferrer">
              <span>{source.url}</span>
              <ExternalLink size={16} />
            </a>
            <button
              className="icon-button"
              aria-label={`Delete source ${source.url}`}
              title="Delete this source from the novel"
              disabled={busy}
              onClick={() => {
                setError('')
                setNotice('')
                setRemoving(source)
              }}
            >
              <Trash2 size={17} />
            </button>
          </article>
        ))}
      </div>
      {!linkedSources.length && <p className="empty-inline">No source URLs yet.</p>}
      {removing && (
        <Dialog
          title="Delete source?"
          onClose={() => {
            if (!busy) setRemoving(null)
          }}
        >
          <div className="edit-form">
            <p className="source-removal-url">{removing.url}</p>
            <p>
              This removes the source's chapter list, downloaded source text, reading position and
              chapter pairings. The novel, other sources, imported book files, glossary and saved
              translations are kept. This cannot be undone.
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button className="button" disabled={busy} onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button
                className="button danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  setError('')
                  try {
                    const result = await removeNovelSource(book, removing.id)
                    setRemoving(null)
                    setNotice(result.warning ?? 'Source deleted. Other sources are unchanged.')
                    await refresh()
                    window.dispatchEvent(new Event('focus'))
                  } catch (failure) {
                    setError(
                      failure instanceof Error ? failure.message : 'Source could not be deleted.',
                    )
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                <Trash2 size={16} />
                {busy ? 'Deleting...' : 'Delete source'}
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {adding && (
        <Dialog
          title="Link Novel Updates"
          onClose={() => {
            if (!busy) setAdding(false)
          }}
        >
          <form
            className="edit-form"
            onSubmit={async (event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              setBusy(true)
              setError('')
              try {
                const url = new URL(String(form.get('url')).trim())
                await attachBookCatalog(book, url.href)
                await refresh()
                setAdding(false)
              } catch (failure) {
                setError(failure instanceof Error ? failure.message : 'Source could not be saved.')
              } finally {
                setBusy(false)
              }
            }}
          >
            <label>
              Novel Updates URL
              <input name="url" type="url" required maxLength={2048} placeholder="https://" />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? 'Saving...' : 'Link Novel Updates'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  )
}
