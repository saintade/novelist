import { useState } from 'react'
import { Download, ListTree, LoaderCircle, Route, Square, SwitchCamera } from 'lucide-react'
import type { AnalysisModel } from '../src/lib/extension/contracts'
import { NAVIGATION_LIMITS, type NavigationGoal } from '../src/lib/extension/navigation'
import type { PanelMessage, PanelState } from './protocol'
import { Confirmation } from './Confirmation'

export function NavigationPanel({
  state,
  model,
  pending,
  action,
}: {
  state: PanelState
  model: AnalysisModel | ''
  pending: boolean
  action: (message: PanelMessage) => Promise<boolean>
}) {
  const [goal, setGoal] = useState<NavigationGoal | null>(null)
  const [permission, setPermission] = useState(false)
  const run = state.navigation
  const running = run?.state === 'running'
  const disabled =
    pending ||
    running ||
    state.job?.state === 'running' ||
    state.scanningContents ||
    !state.connected ||
    !state.liveEnabled
  return (
    <section className="navigation-panel" aria-label="Browser exploration">
      <div className="section-title">
        <h2>Browser exploration</h2>
        <button
          className="icon-button"
          title="Show captured tab"
          aria-label="Show captured tab"
          onClick={() => void action({ type: 'show-tab' })}
        >
          <SwitchCamera size={18} />
        </button>
      </div>
      <div className="navigation-goals">
        <button
          className="button"
          disabled={disabled}
          onClick={() => {
            setPermission(false)
            setGoal('contents')
          }}
        >
          <ListTree size={16} />
          Explore contents
        </button>
        <button
          className="button"
          disabled={disabled}
          onClick={() => {
            setPermission(false)
            setGoal('samples')
          }}
        >
          <Route size={16} />
          Capture reading samples
        </button>
      </div>
      {run && (
        <>
          <div className="navigation-progress" role="status">
            {running && <LoaderCircle className="spin" size={17} />}
            <span>{run.stage}</span>
            {running && (
              <button className="button" onClick={() => void action({ type: 'stop-navigation' })}>
                <Square size={13} />
                Stop
              </button>
            )}
          </div>
          <small>
            {run.actions} / {NAVIGATION_LIMITS.actions} actions / {run.modelCalls} /{' '}
            {NAVIGATION_LIMITS.decisions} model decisions / {run.pages.length} rendered pages
          </small>
          {run.reason && (
            <p className={run.state === 'failed' ? 'sample-error' : 'usage-note'}>{run.reason}</p>
          )}
          {run.activity.length > 0 && (
            <details className="navigation-activity">
              <summary>Navigation activity</summary>
              <ol>
                {run.activity.map((entry, index) => (
                  <li key={index}>
                    <strong>{entry.action.replaceAll('_', ' ')}</strong>
                    <p>{entry.outcome}</p>
                    {entry.reused && <small>Reused the observed navigation path</small>}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {run.pages.length > 0 && (
            <ul className="navigation-samples">
              {run.pages.map((page, index) => (
                <li key={page.url}>
                  <a href={page.url} target="_blank" rel="noreferrer">
                    Rendered page {index + 1}
                  </a>
                  <small>{new URL(page.url).hash || new URL(page.url).pathname}</small>
                </li>
              ))}
            </ul>
          )}
          {!running && (
            <button
              className="button navigation-report"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' }),
                )
                const link = document.createElement('a')
                link.href = url
                link.download = 'novelist-navigation.json'
                link.click()
                setTimeout(() => URL.revokeObjectURL(url), 1000)
              }}
            >
              <Download size={15} />
              Navigation report
            </button>
          )}
        </>
      )}
      {goal && (
        <Confirmation label="Confirm browser exploration" onClose={() => setGoal(null)}>
          <h2>{goal === 'contents' ? 'Explore the contents?' : 'Capture reading samples?'}</h2>
          <p>
            Novelist may click navigation controls, select reading order and scroll this tab on{' '}
            {state.capture ? new URL(state.capture.page.url).hostname : 'this site'}.
          </p>
          <p className="usage-note">
            Up to 12 actions and 3 billable model decisions using{' '}
            {model || state.identificationModel || 'gpt-5-nano'}. Compact page text and control
            labels go to OpenAI.{' '}
            {goal === 'samples'
              ? 'Up to three rendered pages will be captured for a separately confirmed scraper test.'
              : 'Discovered chapter links are collected locally; this does not download the novel.'}
          </p>
          {state.savedSource && goal === 'contents' && (
            <p className="usage-note">
              Discovered contents will be saved to {state.savedSource.book.title}. Existing
              metadata, reading progress and longer contents lists are retained.
            </p>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={permission}
              onChange={(event) => setPermission(event.target.checked)}
            />
            Allow navigation on this site and send page observations to OpenAI.
          </label>
          <div className="confirmation-actions">
            <button className="button" onClick={() => setGoal(null)}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={!permission || pending}
              onClick={() => {
                void action({ type: 'navigate', goal, model: model || undefined, confirmed: true })
                setGoal(null)
              }}
            >
              Start exploration
            </button>
          </div>
        </Confirmation>
      )}
    </section>
  )
}
