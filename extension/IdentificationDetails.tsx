import { useState } from 'react'
import { BookOpen, Download, ExternalLink } from 'lucide-react'
import type { InspectionResult } from '../src/lib/extension/contracts'
import type { IdentificationCost } from '../src/lib/ai/pricing'
import { identificationFilename, inspectionAliases } from '../src/lib/extension/metadata'
import { publicPageUrl } from '../src/lib/scraper/contracts'

function MetadataValue({ value }: { value: string | number | boolean | null }) {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    let url: string
    try {
      url = publicPageUrl(value)
    } catch {
      return value
    }
    return (
      <a href={url} target="_blank" rel="noreferrer">
        {value}
        <ExternalLink size={12} />
      </a>
    )
  }
  return value === null ? 'Unknown' : String(value)
}

function languageName(language: string | null | undefined, locale = 'en') {
  if (!language) return 'Unknown'
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(language) || language
  } catch {
    return language
  }
}

const dollars = (amount: number | null) =>
  amount === null
    ? 'Unknown'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 6,
        maximumFractionDigits: 7,
      }).format(amount)

export function IdentificationCosts({ cost }: { cost: IdentificationCost }) {
  return (
    <section className="identification-costs" aria-label="Identification cost">
      <p>
        <strong>{cost.model}</strong>
        <span>{dollars(cost.estimatedUsd)} est.</span>
      </p>
      <small>
        {cost.basis === 'preflight'
          ? `About ${cost.inputTokens.toLocaleString()} input tokens plus ${cost.outputTokens.toLocaleString()} assumed output tokens.`
          : cost.usageKnown
            ? `${cost.inputTokens.toLocaleString()} input / ${cost.outputTokens.toLocaleString()} output tokens reported.`
            : 'The provider did not report token usage.'}
      </small>
      {cost.basis === 'reported-usage' && cost.usageKnown && (
        <small>
          {cost.cachedInputTokens.toLocaleString()} cached input /{' '}
          {cost.reasoningTokens.toLocaleString()} reasoning tokens (included in output).
        </small>
      )}
      <details>
        <summary>Compare model costs</summary>
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>In / out per 1M</th>
              <th>Estimate</th>
            </tr>
          </thead>
          <tbody>
            {cost.comparisons.map((row) => (
              <tr key={row.model}>
                <th scope="row">{row.model}</th>
                <td>
                  ${row.inputPerMillion} / ${row.outputPerMillion}
                </td>
                <td>{dollars(row.estimatedUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="usage-note">
          Same token counts at standard USD rates. Actual model outputs and reasoning vary; this is
          not a billed comparison.{' '}
          {cost.basis === 'preflight'
            ? 'No caching assumed. Input includes an estimated prompt and schema overhead.'
            : 'Cache discounts use the reported cached-input count.'}
        </p>
        <a href={cost.pricingSource} target="_blank" rel="noreferrer" className="source-link">
          Prices checked {cost.pricesAsOf}
          <ExternalLink size={12} />
        </a>
      </details>
    </section>
  )
}

function Cover({ url, alt }: { url: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  return failed ? (
    <div className="identification-cover" role="img" aria-label="Cover unavailable">
      <BookOpen size={26} />
    </div>
  ) : (
    <img
      className="identification-cover"
      src={url}
      alt={alt || 'Book cover'}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

export function IdentificationDetails({ result }: { result: InspectionResult }) {
  const inspection = result.inspection
  const output = result.outputLanguage ?? 'en'
  const aliases = inspectionAliases(inspection)
  const metadata = [
    { label: 'Author', value: inspection.author },
    {
      label: 'Source language',
      value: languageName(result.sourceLanguage ?? inspection.language, output),
    },
    { label: 'Output language', value: languageName(output, output) },
    { label: 'Status', value: inspection.publicationStatus },
    { label: 'Chapters', value: inspection.chapterCount?.toLocaleString() },
    { label: 'Words', value: inspection.wordCount?.toLocaleString() },
    { label: 'Updated', value: inspection.updatedAt },
    { label: 'Genres', value: inspection.genres?.join(', ') },
    { label: 'Tags', value: inspection.tags?.join(', ') },
  ]
  return (
    <>
      <div className="identified-book">
        {inspection.coverImage && (
          <Cover
            key={inspection.coverImage.url}
            url={inspection.coverImage.url}
            alt={inspection.coverImage.alt}
          />
        )}
        <div>
          {inspection.title && <h2 className="novel-title">{inspection.title}</h2>}
          <dl className="novel-metadata">
            {metadata
              .filter(
                (field) => field.value !== null && field.value !== undefined && field.value !== '',
              )
              .map((field) => (
                <div key={field.label}>
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
          </dl>
        </div>
      </div>
      {aliases.length > 0 && (
        <section className="identified-aliases" aria-label="Novel aliases">
          <h3>Aliases</h3>
          <ul>
            {aliases.map((alias) => (
              <li key={alias}>{alias}</li>
            ))}
          </ul>
        </section>
      )}
      {result.metadataReference && (
        <p className="identified-reference">
          Metadata reference:{' '}
          <a href={result.metadataReference.url} target="_blank" rel="noreferrer">
            {result.metadataReference.title}
            <ExternalLink size={12} />
          </a>
        </p>
      )}
      {inspection.synopses?.map((synopsis, index) => (
        <section className="identified-synopsis" key={index}>
          <h3>{synopsis.label}</h3>
          <p className="synopsis">{synopsis.text}</p>
        </section>
      ))}
      {Boolean(inspection.additionalMetadata?.length) && (
        <section className="additional-metadata">
          <h3>Additional information</h3>
          <dl className="novel-metadata">
            {inspection.additionalMetadata.map((field, index) => (
              <div key={`${field.field}-${index}`}>
                <dt>{field.field}</dt>
                <dd>
                  {Array.isArray(field.value) ? (
                    field.value.map((value, position) => (
                      <span key={position}>
                        {position > 0 ? ', ' : ''}
                        <MetadataValue value={value} />
                      </span>
                    ))
                  ) : (
                    <MetadataValue value={field.value} />
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <p className="detection-reason">{inspection.reason}</p>
      {result.cost && <IdentificationCosts cost={result.cost} />}
      {result.storageWarning && (
        <p className="sample-error" role="alert">
          {result.storageWarning}
        </p>
      )}
      <div className="identification-download">
        <button
          className="button"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }),
            )
            const link = document.createElement('a')
            link.href = url
            link.download = identificationFilename(result)
            link.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
          }}
        >
          <Download size={15} /> Identification JSON
        </button>
        {result.recordId && <small>Saved to library database</small>}
      </div>
    </>
  )
}
