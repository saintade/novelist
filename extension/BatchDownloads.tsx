import { useState } from 'react'
import { Download, LoaderCircle, Pause, Play } from 'lucide-react'
import { hasChapterJobs, type PanelMessage, type PanelState } from './protocol'
import { Confirmation } from './Confirmation'

export function BatchDownloads({
  state,
  count,
  locked,
  action,
}: {
  state: PanelState
  count: number
  locked: boolean
  action: (message: PanelMessage) => Promise<boolean>
}) {
  const [from, setFrom] = useState(1)
  const [to, setTo] = useState(Math.min(5, count))
  const [confirm, setConfirm] = useState(false)
  const [permission, setPermission] = useState(false)
  const [delayOverride, setDelayOverride] = useState<number | null>(null)
  const [concurrencyOverride, setConcurrencyOverride] = useState<number | null>(null)
  const batch = state.chapterBatch
  const transport = batch?.transport ?? state.downloadTransport ?? 'browser'
  const delaySeconds = delayOverride ?? batch?.delaySeconds ?? state.downloadDelaySeconds ?? 1
  const concurrency = concurrencyOverride ?? batch?.concurrency ?? 3
  const running = batch?.state === 'running'
  const disabled = locked || !state.connected || !state.savedSource || hasChapterJobs(batch)
  const valid =
    Number.isInteger(from) && Number.isInteger(to) && from > 0 && to >= from && to <= count
  const validDelay =
    Number.isInteger(delaySeconds) &&
    delaySeconds >= (transport === 'http' ? 0 : 1) &&
    delaySeconds <= 60 &&
    Number.isInteger(concurrency) &&
    concurrency >= 1 &&
    concurrency <= 3
  const resume = (confirmed: boolean) => {
    setDelayOverride(null)
    void action({ type: 'resume-downloads', confirmed, delaySeconds, concurrency })
  }
  return (
    <section className="batch-downloads" aria-label="Bulk downloads">
      <h2>
        Bulk downloads <span>{count.toLocaleString()} unique chapters</span>
      </h2>
      <div className="batch-range">
        <label>
          From
          <input
            aria-label="Download from chapter"
            type="number"
            min={1}
            max={count}
            value={from}
            disabled={locked}
            onChange={(event) => setFrom(Number(event.target.value))}
          />
        </label>
        <label>
          To
          <input
            aria-label="Download to chapter"
            type="number"
            min={from}
            max={count}
            value={to}
            disabled={locked}
            onChange={(event) => setTo(Number(event.target.value))}
          />
        </label>
      </div>
      <label className="batch-delay">
        Seconds between chapters
        <input
          type="number"
          min={transport === 'http' ? 0 : 1}
          max={60}
          value={delaySeconds}
          disabled={locked}
          onChange={(event) => setDelayOverride(Number(event.target.value))}
          title="Saved for this site. A browser verification pauses the queue and increases pacing; it is never solved automatically."
        />
      </label>
      <label className="batch-delay">
        Concurrent downloads
        <input
          type="number"
          min={1}
          max={3}
          step={1}
          value={transport === 'http' ? concurrency : 1}
          disabled={locked || transport !== 'http'}
          onChange={(event) => setConcurrencyOverride(Number(event.target.value))}
        />
      </label>
      <div className="batch-actions">
        <button
          className="button"
          disabled={disabled || !valid || !validDelay}
          title="Download this inclusive range from the unique chapter list, not just the current search results. Already saved chapters are skipped."
          onClick={() => {
            setDelayOverride(null)
            void action({
              type: 'download-chapters',
              mode: 'range',
              from,
              to,
              delaySeconds,
              concurrency,
            })
          }}
        >
          <Download size={15} />
          Download range
        </button>
        <button
          className="button"
          disabled={disabled || !count || !validDelay}
          title={`Download all ${count} unique indexed chapters using ${transport === 'http' ? 'direct server fetches without opening tabs' : 'rendered browser pages'}. Partial inventories may not contain the whole novel. Already saved chapters are skipped.`}
          onClick={() => {
            setDelayOverride(null)
            void action({ type: 'download-chapters', mode: 'all', delaySeconds, concurrency })
          }}
        >
          <Download size={15} />
          Download all
        </button>
      </div>
      {batch && (
        <div className="batch-progress" role="region" aria-label="Batch download progress">
          <progress
            aria-label="Downloaded chapter progress"
            max={batch.urls.length}
            value={batch.completedUrls?.length ?? batch.next}
          />
          <p role="status">
            {running && <LoaderCircle size={14} className="spin" />}
            {batch.completedUrls?.length ?? batch.next} / {batch.urls.length} processed /{' '}
            {batch.saved} saved / {batch.skipped} already saved
          </p>
          <p>{batch.message}</p>
          <p>
            {transport === 'http'
              ? `Direct URL fetch / up to ${batch.concurrency ?? 3} at once`
              : 'Rendered browser pages'}
          </p>
          {batch.timing && (
            <details className="batch-timings">
              <summary>Download timings</summary>
              <p>
                {batch.timing.browserPages} page captures /{' '}
                {(batch.timing.browserMs / Math.max(1, batch.timing.browserPages) / 1000).toFixed(
                  1,
                )}
                s average browser time
              </p>
              <p>
                {batch.timing.processingJobs} jobs /{' '}
                {(
                  batch.timing.processingMs /
                  Math.max(1, batch.timing.processingJobs) /
                  1000
                ).toFixed(1)}
                s average extraction/save time
              </p>
            </details>
          )}
          {batch.state === 'needs_browser' && (
            <button
              className="button"
              title="Show the source tab for manual access review. Does not click or solve verification controls."
              onClick={() => void action({ type: 'show-tab' })}
            >
              Show source tab
            </button>
          )}
          {running ? (
            <button
              className="button"
              title="Pause after any current extraction finishes. Completed chapters and the remaining queue are kept."
              onClick={() => void action({ type: 'pause-downloads' })}
            >
              <Pause size={15} />
              Pause downloads
            </button>
          ) : batch.state === 'needs_scraper' ? (
            <button
              className="button"
              disabled={!state.connected || locked || !state.liveEnabled}
              title="Authorize model use for only the current chapter. Later chapters pause again if another repair is needed."
              onClick={() => {
                setPermission(false)
                setConfirm(true)
              }}
            >
              <Play size={15} />
              Review model use for chapter
            </button>
          ) : (
            batch.state !== 'completed' && (
              <button
                className="button"
                disabled={!state.connected || locked || !validDelay}
                onClick={() => resume(false)}
              >
                <Play size={15} />
                Resume downloads
              </button>
            )
          )}
        </div>
      )}
      {confirm && batch && (
        <Confirmation label="Confirm batch chapter" onClose={() => setConfirm(false)}>
          <h2>Generate scraper for chapter {batch.from + batch.next}?</h2>
          <p>
            Up to three billable model requests for this chapter only. The remaining batch tries
            saved scrapers and pauses again if model use is needed.
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={permission}
              onChange={(event) => setPermission(event.target.checked)}
            />
            I have permission to scrape and send this chapter to OpenAI.
          </label>
          <div className="confirmation-actions">
            <button className="button" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={!permission || locked || !validDelay}
              onClick={() => {
                setConfirm(false)
                resume(true)
              }}
            >
              Generate & resume
            </button>
          </div>
        </Confirmation>
      )}
    </section>
  )
}
