import { Link } from 'react-router-dom'
import { FileText, ArrowLeft } from 'lucide-react'

export function NotFound() {
  return (
    <div className="empty-state">
      <FileText size={30} />
      <h1>Book not found</h1>
      <Link className="button" to="/">
        <ArrowLeft size={16} /> Back to library
      </Link>
    </div>
  )
}
