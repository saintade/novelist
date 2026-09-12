import { ensureSession, supabase } from '../supabase/client'
import { scraperRequestSchema, type ScraperRequest, type ScraperToolResult } from './contracts'

export async function generateBookScraper(request: ScraperRequest): Promise<ScraperToolResult> {
  const payload = scraperRequestSchema.parse(request)
  await ensureSession()
  const { data } = await supabase.auth.getSession()
  if (!data.session) throw new Error('The library session has expired.')
  const response = await fetch('/api/ai/generate-scraper', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify(payload),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'The scraper experiment failed.')
  return result
}
