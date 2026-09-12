import { useEffect, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Pencil, Plus, Save, Search, Trash2, X } from 'lucide-react'
import type { LibraryBook } from '../../lib/books'
import {
  removeGlossaryEntry,
  saveGlossaryEntry,
  setGlossaryStatus,
  termCategories,
  type GlossaryEntry,
  type GlossaryScope,
  getLibraryGlossaries,
  saveGlossarySources,
  type TranslationWorkspace,
} from '../../lib/translation/repository'
import { Dialog, IconButton } from '../ui'
import { sameGlossaryLanguage } from '../../lib/translation/glossary'
import { glossarySourcesSchema, type GlossarySourceSelection } from '../../lib/translation/context'

const languageLabel = (language: string) => {
  try { return `${new Intl.DisplayNames(['en'], { type: 'language' }).of(language.replaceAll('_', '-'))} (${language})` }
  catch { return language }
}

export function GlossaryPanel({
  book,
  entries,
  targetLanguage,
  refresh,
}: {
  book: LibraryBook
  entries: GlossaryEntry[]
  targetLanguage: string
  refresh: () => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [scope, setScope] = useState('all')
  const [page, setPage] = useState(0)
  const [editing, setEditing] = useState<GlossaryEntry | 'new' | null>(null)
  const [removing, setRemoving] = useState<GlossaryEntry | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const filtered = entries.filter(
    (entry) =>
      sameGlossaryLanguage(entry.target_language, targetLanguage) &&
      (scope === 'all' || entry.scope === scope) &&
      (status === 'all' ? entry.status !== 'rejected' : entry.status === status) &&
      [entry.source_term, entry.target_term, ...entry.aliases, entry.sense, entry.notes, entry.evidence, entry.category, entry.scope, entry.status, entry.source_language, entry.target_language].join(' ')
        .normalize('NFKC')
        .toLowerCase()
        .includes(query.normalize('NFKC').trim().toLowerCase()),
  )
      const pageSize = 25
      const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
      const currentPage = Math.min(page, pageCount - 1)
  const action = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await work()
      await refresh()
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The glossary could not be updated.')
      return false
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Novel glossary">
      <div className="translation-toolbar">
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="Search glossary"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setPage(0) }}
            placeholder="Search terms"
          />
        </label>
        <button className="button" onClick={() => setEditing('new')}>
          <Plus size={16} /> Add term
        </button>
      </div>
      <div className="translation-filters">
        <select
          aria-label="Filter glossary scope"
          value={scope}
          onChange={(event) => { setScope(event.target.value); setPage(0) }}
        >
          <option value="all">All scopes</option>
          <option value="novel">This novel</option>
          <option value="chapter">Chapter overrides</option>
          <option value="global">Library defaults</option>
        </select>
        <select
          aria-label="Filter glossary status"
          value={status}
          onChange={(event) => { setStatus(event.target.value); setPage(0) }}
        >
          <option value="all">Active terms</option>
          <option value="approved">Approved</option>
          <option value="proposed">Proposed</option>
          <option value="rejected">Rejected</option>
        </select>
        <span>{filtered.length} terms</span>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="glossary-list">
        {filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((entry) => (
          <article className="glossary-row" key={entry.id}>
            <div className="term-pair">
              <strong lang={entry.source_language}>{entry.source_term}</strong>
              <span>{entry.target_term}</span>
            </div>
            <div className="term-metadata">
              <span>{entry.source_language} to {entry.target_language}</span>
              <span>{entry.category}</span>
              <span>
                {entry.scope === 'global'
                  ? 'Library default'
                  : entry.scope === 'chapter'
                    ? `Chapter ${entry.chapter_position! + 1}`
                    : 'Novel'}
              </span>
              <span className={`term-status ${entry.status}`}>{entry.status}</span>
            </div>
            {(entry.sense || entry.notes || entry.evidence || entry.aliases.length > 0) && (
              <details className="term-evidence">
                <summary>Details</summary>
                {entry.sense && <p>{entry.sense}</p>}
                {entry.aliases.length > 0 && <p>Aliases: {entry.aliases.join(', ')}</p>}
                {entry.notes && <p>{entry.notes}</p>}
                {entry.evidence && (
                  <blockquote lang={entry.source_language}>{entry.evidence}</blockquote>
                )}
              </details>
            )}
            <div className="term-actions">
              {entry.status === 'proposed' && (
                <>
                  <IconButton
                    label={`Approve ${entry.source_term}`}
                    disabled={busy}
                    onClick={() => {
                      void action(() => setGlossaryStatus(entry, 'approved'))
                    }}
                  >
                    <Check size={17} />
                  </IconButton>
                  <IconButton
                    label={`Reject ${entry.source_term}`}
                    disabled={busy}
                    onClick={() => {
                      void action(() => setGlossaryStatus(entry, 'rejected'))
                    }}
                  >
                    <X size={17} />
                  </IconButton>
                </>
              )}
              <IconButton
                label={`Edit ${entry.source_term}`}
                disabled={busy}
                onClick={() => setEditing(entry)}
              >
                <Pencil size={16} />
              </IconButton>
              <IconButton
                label={`Delete ${entry.source_term}`}
                disabled={busy}
                onClick={() => setRemoving(entry)}
              >
                <Trash2 size={16} />
              </IconButton>
            </div>
          </article>
        ))}
        {!filtered.length && <p className="empty-inline">{query || scope !== 'all' || status !== 'all' ? 'No matching terms.' : 'No terms yet.'}</p>}
      </div>
      {pageCount > 1 && <nav className="pagination" aria-label="Glossary pages">
        <IconButton label="Previous glossary page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={18} /></IconButton>
        <span>{currentPage + 1} / {pageCount}</span>
        <IconButton label="Next glossary page" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}><ChevronRight size={18} /></IconButton>
      </nav>}
      {editing && (
        <GlossaryEditor
          book={book}
          entry={editing === 'new' ? undefined : editing}
          targetLanguage={targetLanguage}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      {removing && (
        <Dialog
          title="Delete glossary term?"
          onClose={() => {
            if (!busy) setRemoving(null)
          }}
        >
          <p className="dialog-copy">
            Delete {removing.source_term} ({removing.target_term})
            {removing.scope === 'global' ? ' from library-wide defaults' : ''}?
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
              className="button danger-button"
              disabled={busy}
              onClick={async () => {
                if (await action(() => removeGlossaryEntry(removing))) setRemoving(null)
              }}
            >
              Delete term
            </button>
          </div>
        </Dialog>
      )}
    </section>
  )
}

export function GlossarySources({ book, settings, refresh }: { book: LibraryBook; settings: TranslationWorkspace['translationSettings']; refresh: () => Promise<void> }) {
  const [sources, setSources] = useState<Awaited<ReturnType<typeof getLibraryGlossaries>>>([])
  const [selected, setSelected] = useState<GlossarySourceSelection[]>(glossarySourcesSchema.parse(settings?.glossary_sources ?? []))
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    getLibraryGlossaries().then(sources => { if (!cancelled) setSources(sources) }).catch(failure => { if (!cancelled) setError(failure instanceof Error ? failure.message : 'Glossary sources could not be loaded.') })
    return () => { cancelled = true }
  }, [book.id])
  if (!settings) return null
  const available = sources.filter(source => source.book_id !== book.id && `${source.title} ${languageLabel(source.source_language)} ${languageLabel(source.target_language)} ${source.categories.join(' ')}`.toLowerCase().includes(query.toLowerCase()))
  const dirty = JSON.stringify(selected) !== JSON.stringify(settings.glossary_sources)
  return <section className="setup-section glossary-sources" aria-label="Glossary sources">
    <div className="translation-toolbar"><h2>Other book glossaries</h2><span className="guide-status">{selected.length} selected / {languageLabel(settings.target_language)}</span></div>
    <label className="search-field"><Search size={16} /><input aria-label="Find glossary sources" placeholder="Book, language or category" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <ul className="glossary-source-list">{available.map(source => {
      const selection = { bookId: source.book_id, sourceLanguage: source.source_language, targetLanguage: source.target_language }
      const matches = (entry: GlossarySourceSelection) => entry.bookId === source.book_id && entry.sourceLanguage === source.source_language && entry.targetLanguage === source.target_language
      const compatible = sameGlossaryLanguage(source.target_language, settings.target_language) && sameGlossaryLanguage(source.source_language, book.language)
      return <li key={`${source.book_id}:${source.source_language}:${source.target_language}`}><label title={compatible ? undefined : 'Choose a glossary with the same source and translation languages.'}>
        <input type="checkbox" checked={selected.some(matches)} disabled={busy || (!compatible && !selected.some(matches))} onChange={event => setSelected(event.target.checked ? [...selected, selection] : selected.filter(entry => !matches(entry)))} />
        <span><strong>{source.title}</strong><span>{languageLabel(source.source_language)} to {languageLabel(source.target_language)}</span><small>{source.term_count} approved terms / {source.categories.join(', ')}</small></span>
      </label></li>
    })}</ul>
    {!available.length && <p className="empty-inline">No approved book glossaries found.</p>}
    <button className="button" disabled={busy || !dirty} onClick={() => {
      setBusy(true)
      setError('')
      void saveGlossarySources(book.id, settings.revision, selected).then(refresh).catch(failure => setError(failure instanceof Error ? failure.message : 'Glossary sources could not be saved.')).finally(() => setBusy(false))
    }}><Save size={16} />Save glossary sources</button>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>
}

function GlossaryEditor({
  book,
  entry,
  targetLanguage,
  onClose,
  onSaved,
}: {
  book: LibraryBook
  entry?: GlossaryEntry
  targetLanguage: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [scope, setScope] = useState<GlossaryScope>((entry?.scope as GlossaryScope) ?? 'novel')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <Dialog
      title={entry ? 'Edit term' : 'Add glossary term'}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        className="edit-form"
        onSubmit={async (event) => {
          event.preventDefault()
          const values = new FormData(event.currentTarget)
          setBusy(true)
          setError('')
          try {
            await saveGlossaryEntry(
              book,
              {
                sourceTerm: String(values.get('source')),
                targetTerm: String(values.get('target')),
                targetLanguage,
                scope,
                chapter: Number(values.get('chapter') ?? 0),
                category: String(values.get('category')) as (typeof termCategories)[number],
                sense: String(values.get('sense')),
                notes: String(values.get('notes')),
                aliases: String(values.get('aliases')).split(','),
              },
              entry,
            )
            await onSaved()
            onClose()
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Term could not be saved.')
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="form-columns">
          <label>
            Source term
            <input name="source" required maxLength={160} defaultValue={entry?.source_term} />
          </label>
          <label>
            {new Intl.DisplayNames(['en'], { type: 'language' }).of(targetLanguage)} term
            <input name="target" required maxLength={200} defaultValue={entry?.target_term} />
          </label>
        </div>
        <div className="form-columns">
          <label>
            Category
            <select name="category" defaultValue={entry?.category ?? 'person'}>
              {termCategories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
          <label>
            Scope
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as GlossaryScope)}
            >
              <option value="novel">This novel</option>
              <option value="chapter">This chapter</option>
              <option value="global">Library-wide default</option>
            </select>
          </label>
        </div>
        {scope === 'chapter' && (
          <label>
            Chapter
            <select name="chapter" defaultValue={entry?.chapter_position ?? 0}>
              {book.chapters.map((chapter, index) => (
                <option key={chapter.id} value={index}>
                  {index + 1}. {chapter.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Meaning / context
          <input name="sense" maxLength={300} defaultValue={entry?.sense} />
        </label>
        <label>
          Source aliases
          <input
            name="aliases"
            defaultValue={entry?.aliases.join(', ')}
            placeholder="Comma-separated aliases"
          />
        </label>
        <label>
          Notes
          <textarea rows={3} name="notes" maxLength={3000} defaultValue={entry?.notes} />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? 'Saving...' : 'Save term'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
