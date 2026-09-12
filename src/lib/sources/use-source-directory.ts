import { useEffect, useState } from 'react'
import type { LibraryBook } from '../books'
import { getSourceDirectory } from './repository'

export function useSourceDirectory(book?: LibraryBook, contextSourceId?: string) {
  const novelId = book?.novelId
  const [directory, setDirectory] = useState<{
    novelId: string
    data: Awaited<ReturnType<typeof getSourceDirectory>>
  } | null>(null)
  const [failure, setFailure] = useState<{ novelId: string; message: string } | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  useEffect(() => {
    let cancelled = false
    if (!novelId) return
    getSourceDirectory(novelId, contextSourceId)
      .then((data) => {
        if (!cancelled) {
          setDirectory({ novelId, data })
          setFailure(null)
        }
      })
      .catch((error) => {
        if (!cancelled)
          setFailure({
            novelId,
            message: error instanceof Error ? error.message : 'Sources could not be loaded.',
          })
      })
    return () => {
      cancelled = true
    }
  }, [novelId, contextSourceId, revision])
  const data = directory?.novelId === novelId ? directory?.data : null
  const error = failure?.novelId === novelId ? (failure?.message ?? '') : ''
  return {
    sources: data?.sources ?? [],
    downloaded: data?.downloaded ?? [],
    progress: data?.progress ?? [],
    loading: Boolean(novelId && !data && !error),
    error,
    refresh: () => setRevision((value) => value + 1),
  }
}
