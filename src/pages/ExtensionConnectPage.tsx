import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Check, Link2, LoaderCircle, Puzzle } from 'lucide-react'
import {
  extensionConnectNonceSchema,
  extensionIdSchema,
  type ExtensionConnectMessage,
} from '../lib/extension/contracts'
import { ensureSession, supabase } from '../lib/supabase/client'

type ExtensionRuntime = {
  sendMessage: (
    id: string,
    message: ExtensionConnectMessage,
  ) => Promise<{ ok: boolean; error?: string }>
}

async function connectExtension(extensionId: string, nonce: string) {
  if (location.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(location.hostname))
    throw new Error('Automatic extension connections are available only in the local Novelist app.')
  const runtime = (window as Window & { chrome?: { runtime?: ExtensionRuntime } }).chrome?.runtime
  if (!runtime?.sendMessage)
    throw new Error('Load the Novelist extension in Chrome or Edge, then open its panel again.')
  const ready = await runtime.sendMessage(extensionId, { type: 'novelist-connect-ready', nonce })
  if (!ready?.ok)
    throw new Error(
      ready?.error || 'This connection was not started by the extension. Reopen its panel.',
    )
  await ensureSession()
  const session = (await supabase.auth.getSession()).data.session
  if (!session) throw new Error('Your library session expired. Reload and try again.')
  const response = await fetch('/api/extension/pair', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ extensionId }),
  })
  const approval = await response.json()
  if (!response.ok) throw new Error(approval.error || 'The local connection could not be created.')
  const result = await runtime.sendMessage(extensionId, {
    type: 'novelist-pair',
    nonce,
    code: approval.code,
  })
  if (!result?.ok) throw new Error(result?.error || 'The extension did not accept the connection.')
}

export function ExtensionConnectPage() {
  const [parameters] = useSearchParams()
  const extension = extensionIdSchema.safeParse(parameters.get('extensionId'))
  const handshake = extensionConnectNonceSchema.safeParse(parameters.get('nonce'))
  const extensionId = extension.success ? extension.data : ''
  const nonce = handshake.success ? handshake.data : ''
  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState<{ key: string; error: string } | null>(null)
  const pending = useRef<{ key: string; promise: Promise<void> } | null>(null)
  const key = `${extensionId}:${nonce}:${attempt}`
  const complete = outcome?.key === key
  const connected = complete && !outcome.error
  const error = complete ? outcome.error : ''
  useEffect(() => {
    if (!extensionId || !nonce) return
    let active = true
    if (pending.current?.key !== key)
      pending.current = { key, promise: connectExtension(extensionId, nonce) }
    void pending.current.promise
      .then(() => {
        if (active) setOutcome({ key, error: '' })
      })
      .catch((failure: unknown) => {
        if (active)
          setOutcome({
            key,
            error:
              failure instanceof Error ? failure.message : 'The extension could not be connected.',
          })
      })
    return () => {
      active = false
    }
  }, [extensionId, nonce, key])
  return (
    <main className="library-page extension-connect-page">
      <Puzzle size={30} strokeWidth={1.5} />
      <div className="page-heading">
        <h1>
          {connected
            ? 'Extension connected'
            : error
              ? 'Connection unavailable'
              : 'Connecting extension'}
        </h1>
      </div>
      {connected ? (
        <>
          <p>Connected to this local library.</p>
          <Link className="button" to="/">
            Back to library
          </Link>
        </>
      ) : extension.success && handshake.success ? (
        <>
          {!error && (
            <p role="status">
              <LoaderCircle size={17} className="spin" />
              Connecting to your local library.
            </p>
          )}
          <dl className="file-details">
            <div>
              <dt>Extension ID</dt>
              <dd className="extension-id">{extension.data}</dd>
            </div>
          </dl>
          {error && (
            <button className="button primary" onClick={() => setAttempt(attempt + 1)}>
              <Link2 size={17} />
              Retry connection
            </button>
          )}
        </>
      ) : (
        <p role="alert">
          This extension connection link is invalid. Open the installed Novelist extension to
          reconnect.
        </p>
      )}
      {connected && <Check size={22} className="extension-connected-mark" />}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </main>
  )
}
