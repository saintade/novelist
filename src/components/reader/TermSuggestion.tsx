import { useEffect, useState } from 'react'
import { Check, LoaderCircle, Pencil, Search, Sparkles } from 'lucide-react'
import type { LibraryBook } from '../../lib/books'
import type { ChapterTranslation } from '../../lib/translation/context'
import { chapterTermContextSchema, chapterTermInventory } from '../../lib/translation/context'
import { findGlossaryMatches, sameGlossaryLanguage } from '../../lib/translation/glossary'
import {
  getLibraryGlossary,
  saveGlossaryEntry,
  termCategories,
  type GlossaryEntry,
} from '../../lib/translation/repository'
import { Dialog } from '../ui'
import { editTranslationTerm, suggestTranslationTerm } from '../../lib/ai/client'

export function ChapterTerms({ translation, sourceText, snapshot, targetLanguage, initialQuery = '', onChoose, onClose }: { translation: ChapterTranslation; sourceText: string; snapshot: unknown; targetLanguage: string; initialQuery?: string; onChoose: (source: string, target: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState(initialQuery)
  const terms = chapterTermInventory(translation, sourceText, snapshot, targetLanguage)
  const context = chapterTermContextSchema.safeParse(snapshot)
  const filtered = terms.filter(term => `${term.source} ${term.target} ${term.category} ${term.sense}`.toLowerCase().includes(query.toLowerCase()))
  return <Dialog title="Chapter terms" onClose={onClose} className="chapter-terms-dialog">
    <div className="chapter-terms-toolbar"><label className="search-field"><Search size={16} /><input aria-label="Find chapter terms" placeholder="Name, translation or category" value={query} onChange={event => setQuery(event.target.value)} /></label><span>{terms.length} terms</span></div>
    <div className="chapter-terms-list">
      {filtered.map(term => <article key={`${term.source}:${term.target}`} className="chapter-term-row">
        <div><strong>{term.source}</strong><span>{term.target}</span><small>{term.category || 'Uncategorized'} / {term.state === 'established' ? 'Established glossary term' : term.state === 'different' ? 'Different from glossary' : 'New candidate'}</small>
          {term.state === 'different' && <p>Glossary: {term.knownTarget}</p>}{term.sense && <p>{term.sense}</p>}
          {!term.present && <p className="form-error">Target spelling is not present in this translation.</p>}{term.ambiguous && <p className="form-error">This translated label has multiple source mappings.</p>}
        </div>
        <button className="icon-button" title={`Review ${term.source}`} aria-label={`Review ${term.source}`} onClick={() => onChoose(term.source, term.target)}><Pencil size={17} /></button>
      </article>)}
      {!filtered.length && <p className="empty-inline">No matching chapter terms.</p>}
    </div>
    {context.success && context.data.warnings.filter(warning => warning.startsWith('Terminology')).map(warning => <p className="form-error" key={warning}>{warning}</p>)}
  </Dialog>
}

export function TermSuggestion({
  book,
  sourceText,
  sourceUrl,
  selectedText,
  translation,
  targetLanguage,
  inline,
  initialTerm,
  previewId,
  onClose,
  onSaved,
}: {
  book: LibraryBook
  sourceText: string
  sourceUrl: string
  selectedText: string
  translation?: ChapterTranslation
  targetLanguage: string
  inline?: { previewId: string; source: string; target: string }
  initialTerm?: { source: string; target: string }
  previewId?: string
  onClose: () => void
  onSaved: (edited?: { previewId: string; translation: ChapterTranslation }) => void
}) {
  const candidate = translation?.terminology.find(
    (term) => term.target === selectedText || term.source === selectedText,
  )
  const [sourceTerm, setSourceTerm] = useState(
    inline?.source ?? initialTerm?.source ?? candidate?.source ?? (translation ? '' : selectedText),
  )
  const [targetTerm, setTargetTerm] = useState(
    inline?.target ?? initialTerm?.target ?? candidate?.target ?? (translation ? selectedText : ''),
  )
  const [sense, setSense] = useState(candidate?.sense ?? '')
  const [category, setCategory] = useState<(typeof termCategories)[number]>(
    candidate?.category ?? 'concept',
  )
  const [scope, setScope] = useState<'novel' | 'global'>('novel')
  const [aliases, setAliases] = useState('')
  const [entries, setEntries] = useState<GlossaryEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [readerContext, setReaderContext] = useState('')
  const [suggestion, setSuggestion] = useState<Awaited<ReturnType<typeof suggestTranslationTerm>> | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    getLibraryGlossary(targetLanguage)
      .then((entries) => {
        if (!cancelled) {
          setEntries(entries)
          setLoaded(true)
        }
      })
      .catch((failure) => {
        if (!cancelled)
          setError(failure instanceof Error ? failure.message : 'Glossary could not be loaded.')
      })
    return () => {
      cancelled = true
    }
  }, [targetLanguage])
  const matches = sourceTerm.trim()
    ? findGlossaryMatches(entries, sourceTerm, book.language, targetLanguage, 6)
    : []
  return (
    <Dialog
      title={inline ? 'Edit translation term' : 'Suggest translation term'}
      className="term-editor-dialog"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        className="edit-form reader-term-form"
        onSubmit={async (event) => {
          event.preventDefault()
          if (!sourceText.normalize('NFKC').includes(sourceTerm.trim().normalize('NFKC'))) {
            setError('The original term must occur in this chapter.')
            return
          }
          setBusy(true)
          setError('')
          try {
            const existing = entries.find(
              (entry) =>
                entry.scope === scope &&
                (scope === 'global' || entry.novel_id === book.novelId) &&
                entry.source_term === sourceTerm.trim() &&
                entry.sense === sense.trim() &&
                sameGlossaryLanguage(entry.source_language, book.language),
            )
            const sourceAliases = aliases.trim()
              ? aliases
                  .split(',')
                  .map((alias) => alias.trim())
                  .filter(Boolean)
              : (existing?.aliases ?? [])
            if (inline)
              onSaved(
                await editTranslationTerm({
                  previewId: inline.previewId,
                  source: inline.source,
                  previous: inline.target,
                  preferred: targetTerm,
                  category,
                  scope,
                  sense,
                  aliases: sourceAliases,
                }),
              )
            else {
              await saveGlossaryEntry(
                book,
                {
                  sourceTerm,
                  targetTerm,
                  targetLanguage,
                  category,
                  sense,
                  scope,
                  chapter: 0,
                  aliases: sourceAliases,
                  notes: `Reader preference from ${sourceUrl}`,
                },
                existing ? { ...existing, status: 'approved' } : undefined,
              )
              onSaved()
            }
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'The term could not be saved.')
          } finally {
            setBusy(false)
          }
        }}
      >
        <label>
          Original term
          <input
            value={sourceTerm}
            onChange={(event) => { setSourceTerm(event.target.value); setSuggestion(null) }}
            maxLength={160}
            required
            disabled={busy || Boolean(inline)}
          />
        </label>
        <label>
          Preferred translation
          <input
            value={targetTerm}
            onChange={(event) => setTargetTerm(event.target.value)}
            maxLength={200}
            required
            disabled={busy}
          />
        </label>
        <div className="reader-term-fields">
          <label>
            Use in
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as typeof scope)}
              disabled={busy}
            >
              <option value="novel">This book</option>
              <option value="global">Library default</option>
            </select>
          </label>
          <label>
            Category
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as typeof category)}
              disabled={busy}
            >
              {termCategories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="reader-term-fields">
          <label>
            Meaning
            <input
              value={sense}
              maxLength={300}
              onChange={(event) => setSense(event.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            Aliases
            <input
              value={aliases}
              placeholder="Alternate source spellings, separated by commas"
              onChange={(event) => setAliases(event.target.value)}
              disabled={busy}
            />
          </label>
        </div>
        {matches.length > 0 && (
          <section className="reader-term-matches" aria-label="Earlier glossary choices">
            <h3>Earlier choices</h3>
            {matches.map(({ entry, match }) => (
              <button
                type="button"
                className="term-memory-choice"
                key={entry.id}
                onClick={() => {
                  setTargetTerm(entry.target_term)
                  setSense(entry.sense)
                  setCategory(
                    termCategories.find((category) => category === entry.category) ?? 'concept',
                  )
                  setAliases(entry.aliases.join(', '))
                }}
                disabled={busy}
              >
                <span>
                  {entry.source_term} = {entry.target_term}
                </span>
                <small>
                  {match} / {entry.status} /{' '}
                  {entry.scope === 'global'
                    ? 'Library default'
                    : entry.novel_id === book.novelId
                      ? 'This book'
                      : 'Another book'}
                </small>
              </button>
            ))}
          </section>
        )}
        <section className="term-ai-section" aria-label="AI term suggestion">
          <label>Context for this term<textarea rows={3} maxLength={2000} value={readerContext} onChange={event => { setReaderContext(event.target.value); setSuggestion(null) }} disabled={busy} placeholder="Optional nuance, naming preference, or surrounding meaning" /></label>
          <div className="term-ai-actions"><button type="button" className="button" disabled={busy || !sourceTerm.trim() || !sourceText.includes(sourceTerm.trim())} title="One billable request using this book's translation model. No text is changed until you save." onClick={async () => {
            setBusy(true)
            setSuggesting(true)
            setError('')
            setSuggestion(null)
            try { setSuggestion(await suggestTranslationTerm({ bookId: book.id, sourceKey: sourceUrl, previewId: inline?.previewId ?? previewId, source: sourceTerm.trim(), currentTarget: targetTerm, targetLanguage, readerContext, confirmed: true })) }
            catch (failure) { setError(failure instanceof Error ? failure.message : 'The term suggestion failed.') }
            finally { setBusy(false); setSuggesting(false) }
          }}>{suggesting ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}Suggest with AI</button><small>One billable request</small></div>
          {suggestion && <div className="term-ai-result" aria-label="Suggested translation">
            {suggestion.context && <p className="term-ai-context">Full current chapter / {suggestion.context.originalCharacters.toLocaleString()} original characters{suggestion.context.translatedCharacters ? ` / ${suggestion.context.translatedCharacters.toLocaleString()} translated characters` : ''} / {suggestion.context.relatedTerms} glossary matches</p>}
            <h3>{suggestion.suggestion.target}</h3><p>{suggestion.suggestion.explanation}</p><blockquote>{suggestion.suggestion.evidenceQuote}</blockquote>
            {suggestion.existingChoices.length > 0 && <p className="term-ai-existing">Established: {suggestion.existingChoices.map(choice => choice.target).join(' / ')}</p>}
            <button type="button" className="button" disabled={busy} onClick={() => { setTargetTerm(suggestion.suggestion.target); setCategory(suggestion.suggestion.category); setSense(suggestion.suggestion.sense); setAliases(suggestion.suggestion.aliases.join(', ')) }}><Check size={15} />Use suggestion</button>
            {suggestion.suggestion.alternatives.map(alternative => <button type="button" className="term-memory-choice" key={alternative.target} disabled={busy} onClick={() => setTargetTerm(alternative.target)}><span>{alternative.target}</span><small>{alternative.explanation}</small></button>)}
            {suggestion.suggestion.warnings.map(warning => <p className="form-error" key={warning}>{warning}</p>)}
            {Boolean(suggestion.relatedGlossary?.length) && <section className="term-ai-glossary" aria-label="Glossary context used"><h4>Glossary context</h4><ul>{suggestion.relatedGlossary!.map((term, position) => <li key={`${term.source}:${position}`}><span>{term.source} = {term.target}</span><small>{term.category} / {term.status} / {term.match} / {term.scope}</small>{term.sense && <small>{term.sense}</small>}</li>)}</ul></section>}
            <small>{suggestion.model} / {suggestion.usage.inputTokens + suggestion.usage.outputTokens} reported tokens</small>
          </div>}
        </section>
        <p>
          {inline
            ? 'Save updates complete occurrences and your glossary preference as a new version. Earlier versions are kept. Saving does not make a model call.'
            : 'Save this as an approved preference. Existing translation versions are kept; retranslate to apply it to this chapter.'}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || !loaded || !sourceTerm.trim() || !targetTerm.trim()}
          >
            {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
            {inline ? 'Save term and update chapter' : 'Save preferred term'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
