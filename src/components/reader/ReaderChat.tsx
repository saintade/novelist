import { useEffect, useEffectEvent, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react'
import { askReadingQuestion, getAIStatus, prepareReadingSearch } from '../../lib/ai/client'
import { ensureSession, supabase } from '../../lib/supabase/client'
import type { Database } from '../../lib/supabase/database.types'
import { readerChatCitationSchema, type ReaderChatContext, type ReaderIndexStatus } from '../../lib/reader/chat'
import { Dialog, IconButton } from '../ui'

type Turn = Database['public']['Tables']['reader_chat_turns']['Row']

export function ReaderChat({ context, chapterTitle, onClose }: { context: ReaderChatContext; chapterTitle: string; onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [question, setQuestion] = useState('')
  const [index, setIndex] = useState<ReaderIndexStatus | null>(null)
  const [indexError, setIndexError] = useState('')
  const [indexAttempt, setIndexAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [available, setAvailable] = useState(false)
  const [model, setModel] = useState('')
  const [error, setError] = useState('')
  const [pendingQuestion, setPendingQuestion] = useState('')
  const [clear, setClear] = useState(false)
  const messagesRef = useRef<HTMLDivElement>(null)
  const load = async () => {
    await ensureSession()
    const result = await supabase.from('reader_chat_turns').select('*').eq('book_id', context.bookId).eq('source_key', context.sourceKey).order('created_at', { ascending: false }).limit(50)
    if (result.error) throw new Error(result.error.message)
    setTurns(result.data.reverse())
  }
  const loadOnReturn = useEffectEvent(load)
  const prepareIndex = useEffectEvent((signal: AbortSignal) => prepareReadingSearch(context, signal))
  useEffect(() => {
    const controller = new AbortController()
    const prepare = async () => {
      let previousRemaining = Number.POSITIVE_INFINITY
      while (!controller.signal.aborted) {
        const result = await prepareIndex(controller.signal)
        if (controller.signal.aborted) return
        setIndex(result)
        setIndexError('')
        if (!result.remaining) return
        if (result.remaining >= previousRemaining) throw new Error('The reading index changed while preparing. Retry indexing.')
        previousRemaining = result.remaining
      }
    }
    void prepare().catch(failure => {
      if (!controller.signal.aborted) setIndexError(failure instanceof Error ? failure.message : 'Reading search is unavailable.')
    })
    return () => controller.abort()
  }, [context.bookId, context.sourceKey, context.sourceId, indexAttempt])
  useEffect(() => {
    let cancelled = false
    const refresh = () => { void loadOnReturn().catch(failure => { if (!cancelled) setError(failure instanceof Error ? failure.message : 'Conversation could not be loaded.') }).finally(() => { if (!cancelled) setLoading(false) }) }
    refresh()
    void Promise.all([getAIStatus(), supabase.from('book_translation_settings').select('chat_model').eq('book_id', context.bookId).maybeSingle()]).then(([status, preferences]) => { if (!cancelled) { setAvailable(status.liveEnabled); setModel(preferences.data?.chat_model || status.chatModel || status.model) } }).catch(() => { if (!cancelled) setError('The local AI server is unavailable.') })
    window.addEventListener('focus', refresh)
    return () => { cancelled = true; window.removeEventListener('focus', refresh) }
  }, [context.bookId, context.sourceKey])
  useEffect(() => {
    const messages = messagesRef.current
    if (messages) messages.scrollTop = messages.scrollHeight
  }, [turns, pendingQuestion])
  const send = async () => {
    if (busy || !question.trim() || !available || !index || index.remaining || indexError) return
    const submitted = question.trim()
    setBusy(true)
    setError('')
    setPendingQuestion(submitted)
    setQuestion('')
    try {
      const turn = await askReadingQuestion({ ...context, requestId: crypto.randomUUID(), question: submitted, scope: 'retrieval', confirmed: true })
      setTurns(previous => [...previous.filter(entry => entry.id !== turn.id), turn])
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The question could not be answered.')
      setQuestion(submitted)
      await load().catch(() => undefined)
    } finally { setBusy(false); setPendingQuestion('') }
  }
  return <Dialog title="Reading chat" className="drawer reader-chat" onClose={onClose}>
    <div className="chat-context"><p>{chapterTitle}</p>
      <div className="chat-index-status" role="status">
        {indexError ? <><span>{indexError}</span><button className="button" onClick={() => setIndexAttempt(attempt => attempt + 1)}>Retry indexing</button></> : !index || index.remaining ? <><LoaderCircle className="spin" size={14} /><span>{index ? `Indexing ${index.indexedChapters} / ${index.chapters} saved chapters` : 'Preparing reading search...'}</span></> : <><span>{index.indexedChapters} {index.indexedChapters === 1 ? 'chapter' : 'chapters'} searchable</span><small title="Search-term payload and document allowance. PostgreSQL indexes add overhead; original prose is not duplicated.">{index.estimatedBytes < 1048576 ? `${Math.ceil(index.estimatedBytes / 1024)} KB` : `${(index.estimatedBytes / 1048576).toFixed(1)} MB`} index estimate</small></>}
      </div>
    </div>
    <div className="chat-history-tools"><span>{turns.length ? `${turns.length} ${turns.length === 1 ? 'question' : 'questions'}` : 'New conversation'}</span><IconButton label="Reload conversation" disabled={busy} onClick={() => void load().catch(failure => setError(failure.message))}><RefreshCw size={16} /></IconButton><IconButton label="Clear chapter conversation" disabled={busy || !turns.length} onClick={() => setClear(true)}><Trash2 size={16} /></IconButton></div>
    <div className="chat-messages" ref={messagesRef} role="log" aria-label="Chapter conversation" aria-live="polite">
      {loading && <p role="status"><LoaderCircle className="spin" size={16} />Loading conversation...</p>}
      {!loading && !turns.length && !pendingQuestion && <p className="chat-empty">No questions yet.</p>}
      {turns.map(turn => {
        const citations = readerChatCitationSchema.array().safeParse(turn.citations)
        return <article className="chat-turn" key={turn.id}>
          <div className="chat-question"><span>You</span><p>{turn.question}</p></div>
          {turn.status === 'completed' ? <div className="chat-answer"><span>Novelist</span><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']} components={{ a: ({ children }) => <span>{children}</span> }}>{turn.answer}</ReactMarkdown>
            {citations.success && citations.data.map((citation, index) => <blockquote className="chat-citation" key={index}><p>{citation.quote}</p><cite>{citation.title}{citation.sourceId === 'translation' ? ' / Translation' : citation.sourceId === 'original' ? ' / Original' : ''}</cite></blockquote>)}
          </div> : <div className="chat-answer"><p className="muted">{turn.status === 'running' ? 'Submitted. Reopen or reload the conversation to check the result.' : turn.error || 'This answer did not complete.'}</p>{turn.status === 'failed' && <button className="button" disabled={busy} onClick={() => setQuestion(turn.question)}>Retry question</button>}</div>}
        </article>
      })}
      {pendingQuestion && <article className="chat-turn"><div className="chat-question"><span>You</span><p>{pendingQuestion}</p></div><p role="status"><LoaderCircle className="spin" size={16} />Thinking...</p></article>}
    </div>
    {clear && <div className="chat-clear" role="alert"><p>Clear this chapter's conversation?</p><button className="button" onClick={() => setClear(false)}>Cancel</button><button className="button danger-button" onClick={async () => {
      const result = await supabase.from('reader_chat_turns').delete().eq('book_id', context.bookId).eq('source_key', context.sourceKey)
      if (result.error) setError(result.error.message)
      else { setTurns([]); setClear(false) }
    }}>Clear conversation</button></div>}
    {error && <p className="form-error chat-error" role="alert">{error}</p>}
    <form className="chat-composer" onSubmit={event => { event.preventDefault(); void send() }}>
      <label className="sr-only" htmlFor="reading-question">Ask about this chapter</label>
      <textarea id="reading-question" rows={3} maxLength={4000} value={question} onChange={event => setQuestion(event.target.value)} placeholder="Ask about a passage or translation..." disabled={busy} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send() } }} />
      <div className="chat-send-row"><small>{available ? `${model} / Billable on send` : 'AI unavailable'}</small><button className="icon-button primary" type="submit" aria-label="Send question" title="Send question. One billable AI request." disabled={busy || loading || !available || !question.trim() || !index || index.remaining > 0 || Boolean(indexError)}>{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={19} />}</button></div>
    </form>
  </Dialog>
}