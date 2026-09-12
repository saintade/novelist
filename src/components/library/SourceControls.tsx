import { useEffect, useRef, useState } from 'react'
import {
  Download,
  ExternalLink,
  Square,
  LoaderCircle,
  Play,
  FlaskConical,
  RotateCw,
  SkipForward,
} from 'lucide-react'
import type {
  ReadingSource,
  SourceDownloadResult,
  SourceExtractionResult,
  SourceChapterRow,
} from '../../lib/sources/contracts'
import {
  downloadChapter,
  getSavedChapter,
  sourceInventory,
  testDirectExtraction,
} from '../../lib/sources/repository'
import { Dialog } from '../ui'
import '../../styles/sources.css'

export function DownloadRange({
  sources,
  onSaved,
  downloaded = [],
}: {
  sources: ReadingSource[]
  onSaved: () => void
  downloaded?: Pick<SourceChapterRow, 'source_id' | 'url'>[]
}) {
  const [range, setRange] = useState<{ from: number; to: number } | null>(null)
  const [concurrency, setConcurrency] = useState(3)
  const savedUrls = new Set(downloaded.map((chapter) => `${chapter.source_id}:${chapter.url}`))
  const inventory = sources.flatMap((source) =>
    sourceInventory(source).map((chapter, position) => ({
      ...chapter,
      sourceId: source.id,
      position,
    })),
  )
  const missing = inventory.filter(
    (chapter) => !savedUrls.has(`${chapter.sourceId}:${chapter.url}`),
  )
  const maximum = Math.max(1, ...sources.map((source) => sourceInventory(source).length))
  const from = range?.from ?? (missing[0] ? missing[0].position + 1 : maximum)
  const to = range?.to ?? Math.min(maximum, from + 4)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [remaining, setRemaining] = useState(0)
  const [message, setMessage] = useState('')
  const [browserUrl, setBrowserUrl] = useState('')
  const [testSourceId, setTestSourceId] = useState('')
  const [testPosition, setTestPosition] = useState(1)
  const [testResult, setTestResult] = useState<{
    sourceId: string
    url: string
    result: SourceExtractionResult
  } | null>(null)
  const [testError, setTestError] = useState('')
  const [rebuild, setRebuild] = useState<{
    sourceId: string
    url: string
    forceRegenerate: boolean
  } | null>(null)
  const [permission, setPermission] = useState(false)
  const [pending, setPending] = useState<Exclude<SourceDownloadResult, { state: 'ready' }> | null>(
    null,
  )
  const queue = useRef<{ sourceId: string; url: string; title: string }[]>([])
  const stop = useRef(false)
  const working = useRef(false)
  const skipped = useRef(0)
  const testSource = sources.find((source) => source.id === testSourceId) ?? sources[0]
  const testChapter = testSource ? sourceInventory(testSource)[testPosition - 1] : undefined
  const shownTest =
    testResult && testResult.sourceId === testSource?.id && testResult.url === testChapter?.url
      ? testResult.result
      : null
  const probe = async (
    input = { sourceId: testSource?.id ?? '', url: testChapter?.url ?? '', forceRegenerate: false },
    confirmed = false,
  ) => {
    if (working.current || !input.sourceId || !input.url) return
    working.current = true
    setBusy(true)
    setTesting(true)
    setTestError('')
    try {
      const result = await testDirectExtraction({ ...input, confirmed })
      setTestResult({ sourceId: input.sourceId, url: input.url, result })
    } catch (failure) {
      setTestError(failure instanceof Error ? failure.message : 'Extraction test failed.')
    } finally {
      working.current = false
      setBusy(false)
      setTesting(false)
    }
  }
  useEffect(
    () => () => {
      stop.current = true
    },
    [],
  )
  const process = async (confirmed = false, checkSavedFirst = false) => {
    if (working.current) return
    const browserRequest = pending
    working.current = true
    stop.current = false
    setBusy(true)
    setPending(null)
    try {
      const entries = [...queue.current]
      const failures: {
        chapter: (typeof entries)[number]
        result: typeof pending
        message: string
      }[] = []
      const download = async (
        current: (typeof entries)[number],
        allowGeneration = false,
        savedOnly = false,
      ) => {
        setMessage(`Downloading ${current.title} (${queue.current.length} remaining)`)
        try {
          const result = savedOnly
            ? await getSavedChapter(current.sourceId, current.url)
            : await downloadChapter({
                sourceId: current.sourceId,
                url: current.url,
                confirmed: allowGeneration,
              })
          if (!result || result.state !== 'ready') {
            failures.push({
              chapter: current,
              result: result ?? browserRequest,
              message: result ? current.title : 'Chapter not saved yet.',
            })
            stop.current = true
            return
          }
          queue.current = queue.current.filter((chapter) => chapter !== current)
          onSaved()
        } catch (failure) {
          failures.push({
            chapter: current,
            result: null,
            message:
              failure instanceof Error
                ? failure.message
                : 'Download failed. Completed chapters are kept.',
          })
          stop.current = true
        }
      }
      let next = 0
      if (entries.length && (confirmed || checkSavedFirst)) {
        await download(entries[next++], confirmed, checkSavedFirst)
      }
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (next < entries.length && !stop.current) await download(entries[next++])
        }),
      )
      const failure = failures.sort(
        (first, second) => entries.indexOf(first.chapter) - entries.indexOf(second.chapter),
      )[0]
      if (failure) {
        queue.current = [
          failure.chapter,
          ...queue.current.filter((chapter) => chapter !== failure.chapter),
        ]
        setPending(failure.result)
        setBrowserUrl(
          sources.find((source) => source.id === failure.chapter.sourceId)?.url ||
            failure.chapter.url,
        )
        setMessage(failure.message)
      } else if (!queue.current.length)
        setMessage(
          skipped.current
            ? `Selection finished. ${skipped.current} skipped chapters remain unsaved.`
            : 'Selected chapters downloaded.',
        )
      else if (stop.current) setMessage('Paused. Completed chapters are kept.')
    } catch (failure) {
      setMessage(
        failure instanceof Error
          ? failure.message
          : 'Download failed. Completed chapters are kept.',
      )
    } finally {
      working.current = false
      setRemaining(queue.current.length)
      setBusy(false)
    }
  }
  const start = (all: boolean) => {
    if (working.current || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3)
      return
    skipped.current = 0
    queue.current = sources.flatMap((source) => {
      const unique = [
        ...new Map(sourceInventory(source).map((chapter) => [chapter.url, chapter])).values(),
      ]
      return (all ? unique : unique.slice(from - 1, to))
        .filter((chapter) => !savedUrls.has(`${source.id}:${chapter.url}`))
        .map((chapter) => ({
          sourceId: source.id,
          url: chapter.url,
          title: `${source.label}: ${chapter.title}`,
        }))
    })
    void process()
  }
  return (
    <section className="source-downloads" aria-label="Chapter downloads">
      <div className="download-summary">
        <div>
          <h2>
            {inventory.length - missing.length} <span>/ {inventory.length} chapters saved</span>
          </h2>
          <p>
            {missing[0]
              ? `Next missing: ${missing[0].title}`
              : inventory.length
                ? 'All indexed chapters are downloaded.'
                : 'No chapters indexed.'}
          </p>
        </div>
        <span className="download-remaining">{missing.length} remaining</span>
        <progress
          aria-label="Saved source chapters"
          max={Math.max(1, inventory.length)}
          value={inventory.length - missing.length}
        />
      </div>
      <div className="source-download-controls">
        <label>
          From chapter
          <input
            type="number"
            min={1}
            max={maximum}
            value={from}
            disabled={busy || !missing.length}
            onChange={(event) => setRange({ from: Number(event.target.value), to })}
          />
        </label>
        <label>
          To chapter
          <input
            type="number"
            min={from}
            max={maximum}
            value={to}
            disabled={busy || !missing.length}
            onChange={(event) => setRange({ from, to: Number(event.target.value) })}
          />
        </label>
        <label>
          Concurrent downloads
          <input
            type="number"
            min={1}
            max={3}
            step={1}
            value={concurrency}
            disabled={busy}
            onChange={(event) => setConcurrency(Number(event.target.value))}
          />
        </label>
        <button
          className="button"
          disabled={
            busy ||
            !Number.isInteger(concurrency) ||
            concurrency < 1 ||
            concurrency > 3 ||
            !missing.length ||
            !sources.length ||
            !Number.isInteger(from) ||
            !Number.isInteger(to) ||
            from < 1 ||
            to < from ||
            to > maximum
          }
          onClick={() => start(false)}
        >
          <Download size={16} />
          Download range{sources.length > 1 ? ' from both sources' : ''}
        </button>
        <button
          className="button"
          disabled={
            busy ||
            !Number.isInteger(concurrency) ||
            concurrency < 1 ||
            concurrency > 3 ||
            !sources.some((source) => sourceInventory(source).length)
          }
          onClick={() => start(true)}
          title="Fetch chapter URLs directly with bounded concurrency. Skip saved text and stop new requests if browser access or model approval is needed."
        >
          <Download size={16} />
          Download all{sources.length > 1 ? ' from both sources' : ''}
        </button>
        {busy && !testing && (
          <button
            className="button"
            onClick={() => {
              stop.current = true
            }}
          >
            <Square size={15} />
            Stop after current downloads
          </button>
        )}
      </div>
      {message && (
        <p role="status">
          {busy && <LoaderCircle size={15} className="spin" />}
          {message}
        </p>
      )}
      {!busy && remaining > 0 && !pending && (
        <button className="button" onClick={() => void process()}>
          <Play size={15} />
          Resume downloads
        </button>
      )}
      {pending && (
        <div className="download-notice" role="alert">
          <p>{pending.message}</p>
          {pending.state === 'needs_scraper' ? (
            <button
              className="button"
              title="Authorize up to three model requests to generate or repair this source's downloader."
              disabled={busy}
              onClick={() => void process(true)}
            >
              <Play size={15} />
              Generate scraper & continue
            </button>
          ) : (
            <div className="source-reader-links">
              <a
                className="button primary"
                href={browserUrl}
                target="_blank"
                rel="noreferrer"
                title="Open Novelist on this source page in Chrome/Edge, select the paused chapter, then click Download chapter. Return here after saving."
              >
                <ExternalLink size={16} />
                Open source in browser
              </a>
              <button
                className="button"
                disabled={busy}
                title="Check for the browser-saved chapter before continuing the range. If it is not saved yet, no source request is made."
                onClick={() => void process(false, true)}
              >
                <Play size={16} />
                Resume downloads
              </button>
              <button className="button" disabled={busy} onClick={() => void process()}>
                <RotateCw size={16} />
                Retry direct download
              </button>
            </div>
          )}
        </div>
      )}
      {!busy && remaining > 0 && (
        <button
          className="button"
          onClick={() => {
            queue.current.shift()
            skipped.current += 1
            setPending(null)
            void process()
          }}
        >
          <SkipForward size={16} />
          Skip chapter & continue
        </button>
      )}
      <section className="extraction-controls" aria-label="Extraction tools">
        <h2>Extraction tools</h2>
        <div className="source-download-controls">
          {sources.length > 1 && (
            <label>
              Test source
              <select
                value={testSource?.id ?? ''}
                disabled={busy}
                onChange={(event) => {
                  setTestSourceId(event.target.value)
                  setTestPosition(1)
                }}
              >
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Test chapter
            <input
              type="number"
              min={1}
              max={testSource ? sourceInventory(testSource).length : 1}
              value={testPosition}
              disabled={busy}
              onChange={(event) => setTestPosition(Number(event.target.value))}
            />
          </label>
          <button
            className="button"
            disabled={busy || !testChapter}
            title="Fetch this chapter URL without browser cookies, then test the saved scraper. No model call or chapter overwrite."
            onClick={() => void probe()}
          >
            {testing ? <LoaderCircle className="spin" size={16} /> : <FlaskConical size={16} />}Test
            direct fetch
          </button>
          <button
            className="button"
            disabled={busy || !testChapter}
            title="Generate a fresh chapter extractor from directly fetched HTML. Requires model-use confirmation; existing text is kept."
            onClick={() => {
              setPermission(false)
              setRebuild({ sourceId: testSource!.id, url: testChapter!.url, forceRegenerate: true })
            }}
          >
            <RotateCw size={16} />
            Rebuild scraper
          </button>
        </div>
        {testChapter && <p>{testChapter.title}</p>}
        {testError && <p role="alert">{testError}</p>}
        {shownTest &&
          (shownTest.state === 'ready' ? (
            <div className="extraction-result" role="region" aria-label="Direct extraction result">
              <p role="status">
                Direct fetch and extraction passed: {shownTest.characters.toLocaleString()} text
                characters from {shownTest.htmlCharacters.toLocaleString()} HTML characters. Scraper{' '}
                {shownTest.strategy}.
              </p>
              {shownTest.nextPageUrl && (
                <p>
                  This is the first page of a split chapter; downloads validate the remaining pages.
                </p>
              )}
              {shownTest.warning && <p role="alert">{shownTest.warning}</p>}
              <section className="extracted-preview" aria-label="Extracted text preview">
                <h3>{shownTest.title}</h3>
                {shownTest.paragraphs.map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
              </section>
            </div>
          ) : (
            <div className="download-notice" role="alert">
              <p>{shownTest.message}</p>
              {shownTest.state === 'needs_scraper' && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setPermission(false)
                    setRebuild({
                      sourceId: testSource!.id,
                      url: testChapter!.url,
                      forceRegenerate: false,
                    })
                  }}
                >
                  <Play size={15} />
                  Generate scraper
                </button>
              )}
              {shownTest.state === 'needs_browser' && (
                <a
                  className="button"
                  href={testSource?.url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={15} />
                  Open source in browser
                </a>
              )}
            </div>
          ))}
      </section>
      {rebuild && (
        <Dialog
          title={rebuild.forceRegenerate ? 'Rebuild chapter scraper' : 'Generate chapter scraper'}
          onClose={() => setRebuild(null)}
        >
          <div className="edit-form">
            <p>
              Fetch the selected chapter URL directly and{' '}
              {rebuild.forceRegenerate
                ? 'generate a fresh extractor, bypassing the cached scraper'
                : 'generate or repair its extractor'}
              . Up to three billable model requests. The previous scraper is replaced only after
              validation passes. Downloaded text is unchanged.
            </p>
            <label className="extraction-permission">
              <input
                type="checkbox"
                checked={permission}
                onChange={(event) => setPermission(event.target.checked)}
              />
              I have permission to send this page to the model and authorize the generation cost.
            </label>
            <button
              className="button primary"
              disabled={!permission || busy}
              onClick={() => {
                const input = rebuild
                setRebuild(null)
                void probe(input, true)
              }}
            >
              <RotateCw size={16} />
              {rebuild.forceRegenerate ? 'Rebuild scraper' : 'Generate scraper'}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  )
}
