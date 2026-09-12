import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  BookOpen,
  Check,
  CircleAlert,
  Download,
  DollarSign,
  ExternalLink,
  Link2,
  LoaderCircle,
  ListOrdered,
  RotateCw,
  ScanText,
  Save,
  Settings,
  Unplug,
  Square,
  Search,
} from 'lucide-react'
import type { ExtensionJob } from '../src/lib/extension/contracts'
import { outputLanguages, type OutputLanguage } from '../src/lib/extension/contracts'
import type { AnalysisModel } from '../src/lib/extension/contracts'
import { textModelPrices } from '../src/lib/ai/pricing'
import { DEFAULT_ORIGIN, type PanelMessage, type PanelResponse, type PanelState } from './protocol'
import './panel.css'
import { IdentificationCosts, IdentificationDetails } from './IdentificationDetails'
import { Confirmation } from './Confirmation'
import { LibraryActions } from './LibraryActions'
import { LibraryBrowser } from './LibraryBrowser'
import { isNovelUpdatesSeries } from '../src/lib/extension/metadata'
import { uniqueChapterLinks } from '../src/lib/extension/contents'
import { BatchDownloads } from './BatchDownloads'

async function send(message: PanelMessage): Promise<PanelState> {
  const result = (await chrome.runtime.sendMessage(message)) as PanelResponse
  if (!result?.ok)
    throw new Error(
      result && 'error' in result
        ? result.error
        : 'The extension background service is unavailable.',
    )
  return result.state
}

export function App() {
  const [state, setState] = useState<PanelState>({
    backendOrigin: DEFAULT_ORIGIN,
    connected: false,
    autoConnect: true,
  })
  const [origin, setOrigin] = useState(DEFAULT_ORIGIN)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [view, setView] = useState<'page' | 'library'>('page')
  const running =
    state.job?.state === 'running' ||
    state.navigation?.state === 'running' ||
    state.chapterBatch?.state === 'running'

  useEffect(() => {
    let active = true
    const load = () => {
      void send({ type: 'state' })
        .then((next) => {
          if (active) {
            setState(next)
            setOrigin(next.backendOrigin)
          }
        })
        .catch((failure: Error) => {
          if (active) setError(failure.message)
        })
    }
    load()
    void send({ type: 'sync', refreshLibrary: true }).catch(() => undefined)
    const heartbeat = setInterval(() => {
      void send({ type: 'sync' }).catch(() => undefined)
    }, 30_000)
    const changed = () => load()
    chrome.storage.onChanged.addListener(changed)
    return () => {
      active = false
      clearInterval(heartbeat)
      chrome.storage.onChanged.removeListener(changed)
    }
  }, [])

  useEffect(() => {
    if (state.job?.state !== 'running' || !state.connected) return
    const timer = setTimeout(() => {
      void send({ type: 'poll' })
        .then(setState)
        .catch((failure: Error) => setError(failure.message))
    }, 1000)
    return () => clearTimeout(timer)
  }, [running, state.job, state.connected])

  const action = async (message: PanelMessage) => {
    setPending(true)
    setError('')
    try {
      setState(await send(message))
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Action failed.')
      return false
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <header className="panel-header">
        <div className="panel-brand">
          <BookOpen size={21} strokeWidth={1.6} />
          <span>novelist.</span>
        </div>
        <button
          className="icon-button"
          title="Connection settings"
          aria-label="Connection settings"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          <Settings size={19} />
        </button>
      </header>
      <div className="connection-status">
        <span className={state.connected ? 'connected' : ''}>
          {state.connecting ? (
            <LoaderCircle size={13} className="spin" />
          ) : state.connected ? (
            <Check size={13} />
          ) : (
            <Link2 size={13} />
          )}
          {state.connecting
            ? 'Connecting to Novelist'
            : state.connected
              ? 'Connected to Novelist'
              : 'Not connected'}
        </span>
        {state.connected && <small>{state.liveEnabled ? 'AI ready' : 'Live AI off'}</small>}
      </div>
      <div className="panel-views" role="tablist" aria-label="Extension views">
        <button
          role="tab"
          aria-selected={view === 'page'}
          aria-controls="page-view"
          onClick={() => setView('page')}
        >
          Current page
        </button>
        <button
          role="tab"
          aria-selected={view === 'library'}
          aria-controls="library-view"
          onClick={() => setView('library')}
        >
          Your library
        </button>
      </div>
      {(!state.connected || settingsOpen) && (
        <section className="connection-section">
          <h1>Connection</h1>
          <label>
            Local Novelist address
            <input
              type="url"
              value={origin}
              disabled={state.connecting}
              onChange={(event) => setOrigin(event.target.value)}
            />
          </label>
          {state.connected ? (
            <button
              className="button"
              disabled={pending || running || state.connecting}
              onClick={() => void action({ type: 'disconnect' })}
            >
              <Unplug size={16} /> Disconnect
            </button>
          ) : (
            <button
              className="button primary"
              disabled={pending || state.connecting}
              onClick={() => void action({ type: 'connect', origin })}
            >
              <Link2 size={16} /> Connect to Novelist
            </button>
          )}
          {!state.connected && !state.autoConnect && (
            <small className="usage-note">Automatic connection paused.</small>
          )}
          {state.connectionError && (
            <p className="error-message" role="alert">
              {state.connectionError}
            </p>
          )}
        </section>
      )}
      <main>
        <div id="page-view" role="tabpanel" aria-label="Current page" hidden={view !== 'page'}>
          <div className="section-title">
            <h2>Current page</h2>
            <button
              className="icon-button"
              title="Use this tab"
              aria-label="Use this tab"
              disabled={pending || running || state.capturing}
              onClick={() => void action({ type: 'capture' })}
            >
              <RotateCw size={17} />
            </button>
          </div>
          {state.capturing ? (
            <p className="working">
              <LoaderCircle className="spin" size={18} /> Capturing page
            </p>
          ) : state.capture ? (
            <PageWorkflow
              key={state.capture.capturedAt}
              state={state}
              pending={pending}
              action={action}
              onBrowseLibrary={() => setView('library')}
            />
          ) : (
            <div className="empty-page">
              <ScanText size={28} strokeWidth={1.4} />
              <h2>No page selected</h2>
              <button
                className="button"
                disabled={pending || running}
                onClick={() => void action({ type: 'capture' })}
              >
                <ScanText size={16} /> Capture current page
              </button>
            </div>
          )}
        </div>
        {view === 'library' && (
          <div id="library-view" role="tabpanel" aria-label="Your library">
            <LibraryBrowser
              key={`${state.capture?.capturedAt}-${state.connected}`}
              state={state}
              pending={pending}
              action={action}
            />
          </div>
        )}
        {(error || state.error) && (error || state.error) !== state.job?.error && (
          <p className="error-message" role="alert">
            <CircleAlert size={17} />
            <span>{error || state.error}</span>
          </p>
        )}
      </main>
    </>
  )
}

function PageWorkflow({
  state,
  pending,
  action,
  onBrowseLibrary,
}: {
  state: PanelState
  pending: boolean
  action: (message: PanelMessage) => Promise<boolean>
  onBrowseLibrary: () => void
}) {
  const capture = state.capture!
  const inspection = state.inspection?.inspection
  const catalogOnly = isNovelUpdatesSeries(capture.page.url)
  const [view, setView] = useState<'chapters' | 'metadata' | 'settings'>(catalogOnly ? 'metadata' : 'chapters')
  const [outputLanguage, setOutputLanguage] = useState<OutputLanguage>(
    state.inspection?.outputLanguage ?? 'en',
  )
  const [analysisModel, setAnalysisModel] = useState<AnalysisModel | ''>(
    state.preferredAnalysisModel ?? '',
  )
  const [selected, setSelected] = useState('')
  const [chapterQuery, setChapterQuery] = useState('')
  const [confirm, setConfirm] = useState<'test' | 'download' | null>(null)
  const [permission, setPermission] = useState(false)
  const [testTransport, setTestTransport] = useState<'browser' | 'http'>('browser')
  const [forceRegenerate, setForceRegenerate] = useState(false)
  const running = state.job?.state === 'running' || state.navigation?.state === 'running'
  const result = state.job?.scrape
  const contents = state.inspection?.contents
  const chapterChoices = uniqueChapterLinks(
    capture.page.url,
    contents?.chapters ?? inspection?.chapterLinks ?? [],
  )
  const filteredChapters = chapterChoices.filter((chapter) =>
    `${chapter.title} ${'sourceTitle' in chapter ? chapter.sourceTitle : ''}`
      .toLowerCase()
      .includes(chapterQuery.toLowerCase()),
  )
  const selectedChapter =
    filteredChapters.find((chapter) => chapter.url === selected) ?? filteredChapters[0]
  const partial =
    contents &&
    (contents.truncated ||
      contents.nextContentsUrls.length > 0 ||
      (contents.reportedCount !== null && chapterChoices.length < contents.reportedCount))
  const locked =
    pending || running || state.scanningContents || state.chapterBatch?.state === 'running'
  const analyze = (
    <button
      className={`button ${inspection ? '' : 'primary'} full-width`}
      title="Identify this novel and its metadata. Uses one model request; does not download chapters."
      disabled={!state.connected || !state.liveEnabled || locked}
      onClick={async () => {
        const started = await action({
          type: 'inspect',
          outputLanguage,
          model: analysisModel || undefined,
          confirmed: true,
        })
        if (started) setView('metadata')
      }}
    >
      <ScanText size={17} />
      {inspection ? 'Analyze again' : 'Analyze page'}
    </button>
  )
  const labels = {
    index: 'Chapter index',
    chapter: 'Novel chapter',
    catalog: 'Novel catalog',
    uncertain: 'Uncertain page',
    blocked: 'Content unavailable',
    other: 'Not identified as a novel',
  }
  return (
    <>
      <section className="capture-summary">
        <a href={capture.page.url} target="_blank" rel="noreferrer" className="source-link">
          {new URL(capture.page.url).hostname}
          <ExternalLink size={13} />
        </a>
        <h1>{inspection?.title || capture.pageTitle || new URL(capture.page.url).pathname}</h1>
      </section>
      <div className="workflow-tabs" role="tablist" aria-label="Page views">
        {(['chapters', 'metadata', 'settings'] as const).filter(name => !catalogOnly || name !== 'chapters').map(name => <button key={name} role="tab" aria-selected={view === name} onClick={() => setView(name)}>{name === 'chapters' ? 'Chapters' : name === 'metadata' ? 'Metadata' : 'Settings'}</button>)}
      </div>
      <LibraryActions
        state={state}
        pending={pending}
        action={action}
        onBrowseLibrary={onBrowseLibrary}
        showMetadata={view === 'metadata'}
      />
      {!running && (
        <section className="analysis-action">
          <div className="analysis-options" hidden={view !== 'settings'}>
            <h2>Analysis settings</h2>
            <label className="analysis-language">
              Output language
              <select
                value={outputLanguage}
                disabled={pending}
                onChange={(event) => setOutputLanguage(event.target.value as OutputLanguage)}
              >
                {outputLanguages.map((language) => (
                  <option value={language.value} key={language.value}>
                    {language.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="analysis-language analysis-model-select">
              Analysis model
              <select
                value={analysisModel}
                disabled={pending}
                onChange={(event) => setAnalysisModel(event.target.value as AnalysisModel | '')}
              >
                <option value="">
                  Server default ({state.identificationModel || 'gpt-5-nano'})
                </option>
                {textModelPrices.map((price) => (
                  <option key={price.model} value={price.model}>
                    {price.model}
                  </option>
                ))}
              </select>
            </label>
            <div className="analysis-model">
              <button
                className="button"
                disabled={pending || analysisModel === (state.preferredAnalysisModel ?? '')}
                onClick={() =>
                  void action({ type: 'save-model-default', model: analysisModel || null })
                }
              >
                <Save size={14} /> Use as default
              </button>
              <button
                className="button"
                disabled={pending || !state.connected}
                onClick={() =>
                  void action({
                    type: 'estimate',
                    outputLanguage,
                    model: analysisModel || undefined,
                  })
                }
              >
                <DollarSign size={14} /> Estimate costs
              </button>
            </div>
            {state.estimate?.capturedAt === capture.capturedAt &&
              state.estimate.outputLanguage === outputLanguage &&
              state.estimate.cost.model ===
                (analysisModel || state.identificationModel || 'gpt-5-nano') && (
                <IdentificationCosts cost={state.estimate.cost} />
              )}
            {inspection && analyze}
          </div>
          {!inspection && analyze}
        </section>
      )}
      {state.job?.state === 'running' && (
        <div className="working" role="status">
          <LoaderCircle className="spin" size={18} />
          <span>{state.job!.stage}</span>
        </div>
      )}
      {state.job?.state === 'failed' && (
        <p className="error-message" role="alert">
          <CircleAlert size={17} />
          <span>{state.job.error}</span>
        </p>
      )}
      <div hidden={view !== 'chapters'}>
      {inspection && !catalogOnly && (
        <section className="chapter-workflow" aria-label="Chapters">
          <div className="section-title">
            <h2>Chapters</h2>
            {inspection.indexUrl && (
              <a
                className="icon-button"
                href={inspection.indexUrl}
                target="_blank"
                rel="noreferrer"
                title="Open contents page"
                aria-label="Open contents page"
              >
                <ExternalLink size={16} />
              </a>
            )}
          </div>
          <button
            className="button primary full-width"
            title="Collect every reachable chapter link and update this source's inventory. No model call or chapter text download."
            disabled={locked || !state.connected || !state.inspection?.recordId}
            onClick={() => void action({ type: 'contents' })}
          >
            <ListOrdered size={16} />
            Scan &amp; save chapters
          </button>
          {state.scanningContents && (
            <div className="working" role="status">
              <LoaderCircle className="spin" size={17} />
              <span>{state.contentsScan?.reason || 'Scanning chapter links'}</span>
              <button
                className="icon-button"
                title="Stop scan"
                aria-label="Stop scan"
                onClick={() => void action({ type: 'stop-contents' })}
              >
                <Square size={14} />
              </button>
            </div>
          )}
          {contents && (
            <div className="contents-inventory" role="region" aria-label="Discovered chapters">
              <h3>{chapterChoices.length.toLocaleString()} chapter links found</h3>
              <p>
                {contents.reportedCount !== null
                  ? `${contents.reportedCount.toLocaleString()} reported by the site`
                  : 'No total reported by the site'}
                {contents.numberedCount ? ' / oldest first' : ''}
              </p>
              {partial && (
                <p className="sample-error">
                  Partial list: more chapters may remain.
                  {state.contentsScan ? ` ${state.contentsScan.reason}` : ''}
                </p>
              )}
              {state.contentsSaved && (
                <p role="status">
                  {state.contentsSaved.saved
                    ? `${state.contentsSaved.foundCount.toLocaleString()} links saved to Novelist.`
                    : 'Kept the longer list already saved.'}
                </p>
              )}
              {state.contentsSaveError && (
                <>
                  <p className="sample-error" role="alert">
                    {state.contentsSaveError}
                  </p>
                  <button
                    className="button"
                    disabled={locked}
                    onClick={() => void action({ type: 'save-contents' })}
                  >
                    <Save size={14} />
                    Retry saving
                  </button>
                </>
              )}
            </div>
          )}
          {chapterChoices.length > 0 && (
            <div className="chapter-test-picker">
              <label className="catalog-search">
                <Search size={16} />
                <input
                  aria-label="Find a chapter"
                  placeholder="Find a chapter"
                  value={chapterQuery}
                  onChange={(event) => setChapterQuery(event.target.value)}
                />
              </label>
              <label>
                Chapter
                <select
                  aria-label="Chapter"
                  title="Choose a chapter from this source's complete saved list."
                  value={selectedChapter?.url ?? ''}
                  disabled={locked}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  {!filteredChapters.length && <option value="">No matching chapters</option>}
                  {filteredChapters.map((chapter) => (
                    <option key={chapter.url} value={chapter.url}>
                      {chapter.title}
                      {'sourceTitle' in chapter && chapter.sourceTitle !== chapter.title
                        ? ` - ${chapter.sourceTitle}`
                        : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Download method
                <select
                  value={state.downloadTransport ?? 'browser'}
                  disabled={
                    locked ||
                    !state.connected ||
                    !state.savedSource ||
                    Boolean(state.chapterBatch?.jobId)
                  }
                  onChange={(event) =>
                    void action({
                      type: 'set-download-transport',
                      transport: event.target.value as 'browser' | 'http',
                    })
                  }
                  title="Applies to single chapters and bulk downloads. Direct fetch does not open chapter tabs. Pause a batch before switching."
                >
                  <option value="http">Direct URL fetch</option>
                  <option value="browser">Rendered browser pages</option>
                </select>
              </label>
              <div className="chapter-test-actions">
                <button
                  className="button primary"
                  title="Save the observed chapter list, then download this chapter with the selected method. Ask before scraper generation costs."
                  disabled={!selectedChapter || locked || !state.connected || !state.savedSource}
                  onClick={() => {
                    if (selectedChapter)
                      void action({
                        type: 'download-chapter',
                        url: selectedChapter.url,
                        confirmed: false,
                      })
                  }}
                >
                  <Download size={16} />
                  Download chapter
                </button>
                <button
                  className="icon-button"
                  aria-label="Test chapter extraction"
                  title="Test extraction without saving chapter text. Shows scraper diagnostics and asks before model use."
                  disabled={!selectedChapter || locked || !state.connected}
                  onClick={() => {
                    setPermission(false)
                    setConfirm('test')
                  }}
                >
                  <ScanText size={16} />
                </button>
                {selectedChapter && (
                  <a
                    className="icon-button"
                    href={selectedChapter.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open selected chapter"
                    title="Open selected chapter"
                  >
                    <ExternalLink size={16} />
                  </a>
                )}
              </div>
              {state.chapterDownload?.url === selectedChapter?.url && (
                <div className="download-result" role="status">
                  {state.chapterDownload?.state === 'ready' ? (
                    'Chapter saved. Ready to read in Novelist.'
                  ) : (
                    <>
                      <p>{state.chapterDownload?.message}</p>
                      {state.chapterDownload?.state === 'needs_scraper' && (
                        <button
                          className="button"
                          disabled={locked}
                          onClick={() => {
                            setPermission(false)
                            setConfirm('download')
                          }}
                        >
                          Review model use
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      )}
      {inspection && !catalogOnly && chapterChoices.length > 0 && (
        <BatchDownloads
          state={state}
          count={chapterChoices.length}
          locked={Boolean(locked)}
          action={action}
        />
      )}
      {result && <ScrapeResult job={state.job!} />}
      </div>
      {inspection && (
        <section className="inspection-section" hidden={view !== 'metadata'}>
          <h2>Metadata</h2>
          <span className={`classification ${inspection.classification}`}>
            {labels[inspection.classification]}
          </span>
          <IdentificationDetails result={state.inspection!} />
        </section>
      )}
      <section hidden={view !== 'settings'}>
        <h2>Captured page</h2>
        <small>{capture.page.html.length.toLocaleString()} HTML characters</small>
        <pre>{capture.preview || 'No readable text captured.'}</pre>
      </section>
      {confirm && selectedChapter && (
        <Confirmation
          label={confirm === 'download' ? 'Confirm chapter download' : 'Confirm scrape test'}
          onClose={() => setConfirm(null)}
        >
          <h2>
            {confirm === 'download' ? 'Download' : 'Test'} {selectedChapter.title}?
          </h2>
          <p>
            {confirm === 'test' && testTransport === 'http'
              ? 'The local server will fetch the selected chapter URL without navigating the source tab.'
              : 'The selected chapter will open in the source tab.'}{' '}
            {confirm === 'test' && forceRegenerate
              ? 'A fresh extractor will be generated even if a cached scraper passes.'
              : 'A saved site scraper is tested first, without an OpenAI call.'}{' '}
            Generation or repair can use up to three billable requests.
          </p>
          {confirm === 'test' && (
            <>
              <label>
                Page access
                <select
                  value={testTransport}
                  onChange={(event) => setTestTransport(event.target.value as 'browser' | 'http')}
                >
                  <option value="browser">Rendered browser page</option>
                  <option value="http">Direct URL fetch</option>
                </select>
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={forceRegenerate}
                  onChange={(event) => setForceRegenerate(event.target.checked)}
                />
                Rebuild cached scraper
              </label>
            </>
          )}
          <p className="usage-note">
            {confirm === 'download'
              ? 'Validated text is saved to this source. Existing chapters and links are kept.'
              : 'Only this chapter is tested. Saved chapter links are unchanged.'}
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={permission}
              onChange={(event) => setPermission(event.target.checked)}
            />
            I have permission to scrape and send these pages to OpenAI.
          </label>
          <div className="confirmation-actions">
            <button className="button" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={!permission || pending}
              onClick={() => {
                setConfirm(null)
                void action(
                  confirm === 'download'
                    ? { type: 'download-chapter', url: selectedChapter.url, confirmed: true }
                    : {
                        type: 'test-chapter',
                        url: selectedChapter.url,
                        confirmed: true,
                        transport: testTransport,
                        forceRegenerate,
                      },
                )
              }}
            >
              {confirm === 'download' ? 'Generate scraper & download' : 'Test chapter'}
            </button>
          </div>
        </Confirmation>
      )}
    </>
  )
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function ScrapeResult({ job }: { job: ExtensionJob }) {
  const result = job.scrape!
  const checks = result.report.attempts.at(-1)?.checks || []
  const partial = result.sampledPages.some((page) => page.error)
  const passed = result.report.status === 'needs_review'
  return (
    <section className="scrape-result" aria-label="Scrape test result">
      <div className={`result-heading ${passed ? 'passed' : ''}`}>
        {passed ? <Check size={19} /> : <CircleAlert size={19} />}
        <h2>
          {passed
            ? partial
              ? 'Partially testable'
              : 'Chapter extraction passed'
            : result.report.status === 'blocked'
              ? 'Content could not be read'
              : 'Chapter extraction failed'}
        </h2>
      </div>
      {result.report.adapter && (
        <p className="usage-note">
          {result.report.adapter.strategy === 'reused'
            ? 'Reused site scraper. No model call.'
            : result.report.adapter.strategy === 'repaired'
              ? 'Repaired the saved site scraper.'
              : 'Generated a site scraper.'}
        </p>
      )}
      {result.report.persistenceWarning && (
        <p className="sample-error" role="alert">
          {result.report.persistenceWarning}
        </p>
      )}
      <p className="usage-note">
        {passed ? 'Extraction checks passed for this chapter.' : 'No book has been imported.'}
      </p>
      {result.sampledPages
        .filter((page) => page.error)
        .map((page) => (
          <p className="sample-error" key={page.url}>
            <strong>{new URL(page.url).pathname}</strong>
            {page.error}
          </p>
        ))}
      {checks.map((check) => (
        <details className="page-result" key={check.url}>
          <summary>
            <span>
              {check.output && check.output.kind !== 'blocked'
                ? check.output.title
                : new URL(check.url).pathname}
            </span>
            {check.passed ? <Check size={14} /> : <CircleAlert size={14} />}
          </summary>
          {check.issues.map((issue) => (
            <p className="sample-error" key={issue}>
              {issue}
            </p>
          ))}
          {check.output?.kind === 'chapter' &&
            check.output.paragraphs.map((paragraph, index) => (
              <p className="extracted-paragraph" key={index}>
                {paragraph}
              </p>
            ))}
          {check.output?.kind === 'index' && (
            <p>{check.output.chapters.length} chapter links extracted.</p>
          )}
          {check.output?.kind === 'blocked' && <p>{check.output.reason}</p>}
        </details>
      ))}
      {result.report.attempts
        .filter((attempt) => attempt.error)
        .map((attempt) => (
          <p className="sample-error" key={attempt.number}>
            {attempt.error}
          </p>
        ))}
      <details className="extraction-report">
        <summary>Extraction report</summary>
        <small className="run-metadata">
          {result.report.attempts.length} attempts /{' '}
          {result.report.inputTokens + result.report.outputTokens} reported tokens
        </small>
        <div className="result-downloads">
          <button
            className="button"
            disabled={!result.code}
            onClick={() => download('novelist-scraper.mjs', result.code!, 'text/javascript')}
          >
            <Download size={15} /> Scraper code
          </button>
          <button
            className="button"
            onClick={() =>
              download(
                'novelist-scrape-report.json',
                JSON.stringify(result, null, 2),
                'application/json',
              )
            }
          >
            <Download size={15} /> Report
          </button>
        </div>
      </details>
    </section>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
