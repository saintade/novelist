import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { BookOpen, X } from 'lucide-react'
import type { LibraryBook } from '../lib/books'

export function IconButton({
  label,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      title={label}
      aria-label={label}
      {...props}
    >
      {children}
    </button>
  )
}

export function BookCover({ book, className = '' }: { book: LibraryBook; className?: string }) {
  const [failed, setFailed] = useState(false)
  const colors = ['#385950', '#685d81', '#a15b49', '#4b6976', '#826d42']
  return (
    <div
      className={`book-cover ${className}`}
      style={{ '--cover-color': colors[book.title.length % colors.length] } as CSSProperties}
    >
      {book.cover && !failed ? (
        <img src={book.cover} alt={`${book.title} cover`} onError={() => setFailed(true)} />
      ) : (
        <div className="cover-fallback">
          <BookOpen size={24} strokeWidth={1.2} />
          <span>{book.title}</span>
          <small>{book.author}</small>
        </div>
      )}
    </div>
  )
}

export function ProgressBar({
  value,
  label = 'Reading progress',
}: {
  value: number
  label?: string
}) {
  return (
    <div
      className="progress-track"
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span style={{ width: `${value}%` }} />
    </div>
  )
}

export function Dialog({
  title,
  onClose,
  children,
  className = '',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      dialog?.close()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose()
      }}
    >
      <div className="dialog-header">
        <h2 id={titleId}>{title}</h2>
        <IconButton label={`Close ${title.toLowerCase()}`} onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>
      {children}
    </dialog>
  )
}
