export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en').format(value)
}

export function readingTime(words: number): string {
  const minutes = Math.max(1, Math.ceil(words / 230))
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} min`
}
