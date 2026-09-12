import { useEffect, useState } from 'react'
import { ExternalLink, Languages } from 'lucide-react'
import type { LibraryBook } from '../../lib/books'
import { getNovelSources, type NovelSource } from '../../lib/translation/repository'

export function TranslatedVersions({ book }: { book: LibraryBook }) {
  const [sources, setSources] = useState<NovelSource[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    getNovelSources(book)
      .then((entries) => {
        if (!cancelled) {
          setSources(entries.filter((source) => source.role === 'reference' && source.url))
          setError('')
        }
      })
      .catch(() => {
        if (!cancelled) setError('Translated versions could not be loaded.')
      })
    return () => {
      cancelled = true
    }
  }, [book])
  if (!sources.length && !error) return null
  return (
    <section className="translated-versions" aria-label="Translated versions">
      <div className="section-heading">
        <h2>Translated versions</h2>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {sources.map((source) => {
        let language = source.language
        try {
          language =
            new Intl.DisplayNames(['en'], { type: 'language' }).of(source.language) ||
            source.language
        } catch {
          language = source.language
        }
        return (
          <a
            className="translated-version-link"
            key={source.id}
            href={source.url!}
            target="_blank"
            rel="noreferrer"
          >
            <Languages size={18} />
            <span>
              <strong>{source.label}</strong>
              <small>
                {language} / {new URL(source.url!).hostname}
              </small>
            </span>
            <ExternalLink size={15} />
          </a>
        )
      })}
    </section>
  )
}
