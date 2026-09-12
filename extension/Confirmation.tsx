import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function Confirmation({
  children,
  onClose,
  label = 'Confirm scrape test',
}: {
  children: ReactNode
  onClose: () => void
  label?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className="confirmation"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <button
        type="button"
        className="icon-button close-confirmation"
        title="Close confirmation"
        aria-label="Close confirmation"
        onClick={onClose}
      >
        <X size={19} />
      </button>
      {children}
    </dialog>
  )
}
