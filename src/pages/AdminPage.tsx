import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ExternalLink, LoaderCircle, RefreshCw, Save } from 'lucide-react'
import { aiAdminTask } from '../lib/ai/client'
import type { AIAdminOverview } from '../lib/ai/admin'
import { IconButton } from '../components/ui'
import '../styles/admin.css'

const currency = (amount: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amount)
const operationLabel = (value: string) => value.replaceAll('_', ' ')

export function AdminPage() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))
  const [revision, setRevision] = useState(0)
  const [data, setData] = useState<AIAdminOverview | null>(null)
  const [budget, setBudget] = useState('')
  const [warningPercent, setWarningPercent] = useState(80)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let cancelled = false
    void aiAdminTask({ action: 'overview', month })
      .then((result) => {
        if (cancelled) return
        setData(result)
        setBudget(result.budgetUsd === null ? '' : String(result.budgetUsd))
        setWarningPercent(result.warningPercent)
        setError('')
      })
      .catch((failure) => {
        if (!cancelled)
          setError(failure instanceof Error ? failure.message : 'AI usage could not be loaded.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [month, revision])
  const spent = data?.totals.estimatedUsd ?? 0
  const percentage = data?.budgetUsd ? (spent / data.budgetUsd) * 100 : null
  const quotaBlocked =
    data?.providerSignal?.errorCode === 'quota' ||
    data?.jobs.some((job) => job.last_error_code === 'quota')
  return (
    <main className="library-page admin-page">
      <div className="page-heading">
        <h1>Admin & usage</h1>
        <IconButton
          label="Refresh AI usage"
          disabled={loading}
          onClick={() => {
            setLoading(true)
            setRevision((value) => value + 1)
          }}
        >
          <RefreshCw size={18} />
        </IconButton>
      </div>
      <div className="admin-toolbar">
        <label>
          Month (UTC)
          <input
            type="month"
            value={month}
            onChange={(event) => {
              if (event.target.value) {
                setLoading(true)
                setMonth(event.target.value)
              }
            }}
          />
        </label>
        <a
          className="button"
          href="https://platform.openai.com/usage"
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink size={16} />
          OpenAI usage
        </a>
        <a
          className="button"
          href="https://platform.openai.com/settings/organization/billing/overview"
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink size={16} />
          Billing
        </a>
      </div>
      {loading && (
        <p className="empty-inline" role="status">
          <LoaderCircle className="spin" size={18} />
          Loading usage...
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {data && data.month === month && (
        <>
          {quotaBlocked && (
            <div className="admin-alert" role="alert">
              <AlertTriangle size={20} />
              <div>
                <strong>Provider quota or billing limit reached</strong>
                <p>Translation requests are stopped. Check OpenAI billing before resuming.</p>
              </div>
            </div>
          )}
          {percentage !== null && percentage >= data.warningPercent && (
            <div className="admin-alert" role="alert">
              <AlertTriangle size={20} />
              <div>
                <strong>
                  {percentage >= 100
                    ? 'Monthly alert budget reached'
                    : 'Approaching monthly alert budget'}
                </strong>
                <p>
                  {currency(spent)} recorded estimate / {currency(data.budgetUsd!)} alert budget.
                  This threshold does not stop API requests.
                </p>
              </div>
            </div>
          )}
          <dl className="admin-metrics">
            <div>
              <dt>Recorded estimate</dt>
              <dd>{currency(spent)}</dd>
            </div>
            <div>
              <dt>Provider requests</dt>
              <dd>{data.totals.requests.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Unknown costs</dt>
              <dd>{data.totals.unknownCosts.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Failed / incomplete</dt>
              <dd>{data.totals.failed.toLocaleString()}</dd>
            </div>
          </dl>
          <p className="admin-caption">
            Recorded requests only
            {data.trackingSince
              ? `, since ${new Date(data.trackingSince).toLocaleDateString()}`
              : ''}
            . Unknown charges and untracked activity are excluded. OpenAI billing is authoritative;
            remaining provider credit is unavailable here.
          </p>
          <section className="admin-section" aria-labelledby="admin-budget-heading">
            <h2 id="admin-budget-heading">Spending alert</h2>
            <form
              className="admin-budget-form"
              onSubmit={async (event) => {
                event.preventDefault()
                setSaving(true)
                setNotice('')
                try {
                  await aiAdminTask({
                    action: 'budget',
                    monthlyAlertUsd: budget.trim() ? Number(budget) : null,
                    warningPercent,
                  })
                  setNotice('Spending alert saved.')
                  setLoading(true)
                  setRevision((value) => value + 1)
                } catch (failure) {
                  setError(failure instanceof Error ? failure.message : 'Alert could not be saved.')
                } finally {
                  setSaving(false)
                }
              }}
            >
              <label>
                Monthly alert budget (USD)
                <input
                  type="number"
                  min="0.01"
                  max="1000000"
                  step="0.01"
                  value={budget}
                  placeholder="Not set"
                  disabled={saving}
                  onChange={(event) => setBudget(event.target.value)}
                />
              </label>
              <label>
                Warn at (%)
                <input
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={warningPercent}
                  disabled={saving}
                  onChange={(event) => setWarningPercent(Number(event.target.value))}
                />
              </label>
              <button className="button" disabled={saving}>
                <Save size={16} />
                Save alert
              </button>
            </form>
            {data.budgetUsd && (
              <progress
                aria-label="Monthly alert budget used"
                value={Math.min(spent, data.budgetUsd)}
                max={data.budgetUsd}
              />
            )}
            {notice && (
              <p role="status" className="admin-caption">
                {notice}
              </p>
            )}
          </section>
          <section className="admin-section" aria-labelledby="admin-jobs-heading">
            <h2 id="admin-jobs-heading">Translation jobs</h2>
            <p className="admin-caption">
              {data.liveEnabled ? 'AI enabled' : 'AI disabled'} / {data.limits.concurrency}{' '}
              concurrent slots /{' '}
              {data.limits.hourlyRequests
                ? `${data.limits.hourlyRequests} requests per hour`
                : 'No hourly request cap'}
            </p>
            {!data.jobs.length && <p className="empty-inline">No open translation jobs.</p>}
            <div className="admin-job-list">
              {data.jobs.map((job) => (
                <article key={job.id} className="admin-job">
                  <div>
                    <Link to={`/books/${job.book_id}?tab=translate`}>{job.title}</Link>
                    <p>
                      {job.request_kind === 'reader' ? 'Reader' : 'Bulk'} / chapters{' '}
                      {job.range_start}-{job.range_end} / up to {job.max_attempts} attempts per
                      chapter
                    </p>
                  </div>
                  <strong>
                    {job.state === 'running' && job.retry_at
                      ? 'Retrying automatically'
                      : operationLabel(job.state)}
                  </strong>
                  {job.error && <p className="admin-job-error">{job.error}</p>}
                </article>
              ))}
            </div>
          </section>
          <section className="admin-section" aria-labelledby="admin-models-heading">
            <h2 id="admin-models-heading">Models</h2>
            <div className="admin-table-scroll">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Requests</th>
                    <th>Input tokens</th>
                    <th>Output tokens</th>
                    <th>Estimate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.models.map((model) => (
                    <tr key={model.model}>
                      <td>{model.model}</td>
                      <td>{model.requests.toLocaleString()}</td>
                      <td>{model.input_tokens.toLocaleString()}</td>
                      <td>{model.output_tokens.toLocaleString()}</td>
                      <td>
                        {currency(model.estimated_usd)}
                        {model.unknown_costs ? ` + ${model.unknown_costs} unknown` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="admin-caption">
              Rate table: {data.pricingAsOf}. Provider prices and reported billing may differ.
            </p>
          </section>
          <section className="admin-section" aria-labelledby="admin-requests-heading">
            <h2 id="admin-requests-heading">Recent requests</h2>
            <div className="admin-table-scroll">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Operation</th>
                    <th>Model</th>
                    <th>Chapters</th>
                    <th>Result</th>
                    <th>Estimate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((request) => (
                    <tr key={request.id}>
                      <td>{new Date(request.created_at).toLocaleString()}</td>
                      <td>{operationLabel(request.operation)}</td>
                      <td>{request.model}</td>
                      <td>{request.group_size}</td>
                      <td>{operationLabel(request.error_code || request.state)}</td>
                      <td>
                        {request.estimated_usd === null
                          ? 'Unknown'
                          : currency(request.estimated_usd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  )
}
