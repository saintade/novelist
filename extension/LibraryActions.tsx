import { useState } from 'react'
import { ExternalLink, Link2, Plus, Pencil } from 'lucide-react'
import type { PanelMessage, PanelState } from './protocol'
import { Confirmation } from './Confirmation'
import { matchSavedSource } from '../src/lib/extension/library-catalog'
import { isNovelUpdatesSeries } from '../src/lib/extension/metadata'

export function LibraryActions({
  state,
  pending,
  action,
  onBrowseLibrary,
  showMetadata = true,
}: {
  state: PanelState
  pending: boolean
  action: (message: PanelMessage) => Promise<boolean>
  onBrowseLibrary: () => void
  showMetadata?: boolean
}) {
  const [reviewing, setReviewing] = useState(false)
  const [error, setError] = useState('')
  const [catalogInput, setCatalogInput] = useState<string | null>(null)
  const inspection = state.inspection
  const isMetadataPage = Boolean(state.capture && isNovelUpdatesSeries(state.capture.page.url))
  const existing = state.capture
    ? matchSavedSource(
        [state.capture.page.url, inspection?.inspection.indexUrl ?? ''],
        state.library ?? [],
      )
    : undefined
  const existingId = existing?.id
  const linkedId = state.connected
    ? state.pairedSource?.bookId || existingId || state.addedNovel?.bookId
    : undefined
  const locked =
    pending ||
    state.job?.state === 'running' ||
    state.scanningContents ||
    state.navigation?.state === 'running'
  return (
    <section className="library-actions" aria-label="Novelist library actions">
      {linkedId && (
        <section className="saved-source-summary" aria-label="Existing library novel">
          <small>In your library</small>
          <a
            className="button"
            href={`${state.backendOrigin}/books/${linkedId}`}
            target="_blank"
            rel="noreferrer"
          >
            Open in Novelist
            <ExternalLink size={14} />
          </a>
          {state.addedNovel && showMetadata && (
            <button
              className="icon-button"
              title="Edit saved metadata"
              aria-label="Edit saved metadata"
              disabled={locked}
              onClick={() => setReviewing(true)}
            >
              <Pencil size={16} />
            </button>
          )}
          {state.sourceLookupError && <p className="sample-error">{state.sourceLookupError}</p>}
        </section>
      )}
      {!linkedId && isMetadataPage && (
        <button className="button" onClick={onBrowseLibrary}>
          <Link2 size={15} />
          Attach Novel Updates to a book
        </button>
      )}
      {!isMetadataPage && showMetadata && (
        <section className="source-options">
          <h2>Novel Updates</h2>
          <form
            className="extension-review-form"
            onSubmit={async (event) => {
              event.preventDefault()
              const success = await action({
                type: 'link-novelupdates',
                url: catalogInput ?? state.novelUpdatesUrl ?? '',
                bookId: linkedId,
              })
              if (success) setCatalogInput(null)
            }}
          >
            <label>
              Novel Updates URL
              <input
                type="url"
                required
                value={catalogInput ?? state.novelUpdatesUrl ?? ''}
                onChange={(event) => setCatalogInput(event.target.value)}
                placeholder="https://www.novelupdates.com/series/..."
              />
            </label>
            <button className="button" disabled={locked || !state.connected}>
              <Link2 size={15} />
              Link Novel Updates
            </button>
            {state.novelUpdatesUrl && (
              <a href={state.novelUpdatesUrl} target="_blank" rel="noreferrer">
                Novel Updates linked <ExternalLink size={12} />
              </a>
            )}
          </form>
        </section>
      )}
      {inspection && !linkedId && !isMetadataPage && (
        <div className="add-library-actions">
          <button
            className="button full-width"
            disabled={locked || !state.connected || !inspection.recordId}
            onClick={() => {
              setError('')
              setReviewing(true)
            }}
          >
            <Plus size={16} />
            Add book to library
          </button>
        </div>
      )}
      {reviewing && (
        <Confirmation
          label="Save novel to library"
          onClose={() => {
            if (!pending) setReviewing(false)
          }}
        >
          <h2>{state.addedNovel ? 'Update saved book' : 'Add to Novelist'}</h2>
          <form
            className="extension-review-form"
            onSubmit={async (event) => {
              event.preventDefault()
              setError('')
              const values = new FormData(event.currentTarget)
              const success = await action({
                type: 'add-book',
                title: String(values.get('title')),
                author: String(values.get('author')),
                overwrite: Boolean(state.addedNovel),
                confirmed: true,
              })
              if (success) setReviewing(false)
              else setError('The novel could not be saved. Try again.')
            }}
          >
            <label>
              Title
              <input
                name="title"
                defaultValue={state.addedNovel?.title ?? inspection?.inspection.title ?? ''}
                required
                maxLength={500}
              />
            </label>
            <label>
              Author
              <input
                name="author"
                defaultValue={
                  state.addedNovel?.author ?? inspection?.inspection.author ?? 'Unknown author'
                }
                required
                maxLength={300}
              />
            </label>
            <p className="usage-note">{state.capture?.page.url}</p>
            {inspection?.metadataReference && (
              <p className="usage-note">
                The Novel Updates reference will be saved as a metadata source, separate from
                translated editions.
              </p>
            )}
            {state.addedNovel && (
              <p className="usage-note">
                This explicitly replaces the saved title, author and identified metadata. Reading
                progress and earlier identification records are kept.
              </p>
            )}
            {(error || state.error) && (
              <p className="sample-error" role="alert">
                {state.error || error}
              </p>
            )}
            <div className="confirmation-actions">
              <button
                type="button"
                className="button"
                disabled={pending}
                onClick={() => setReviewing(false)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={pending}>
                {pending ? 'Saving...' : 'Save to library'}
              </button>
            </div>
          </form>
        </Confirmation>
      )}
    </section>
  )
}
