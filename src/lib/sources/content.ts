export async function storedChapterText(file: Blob, path: string): Promise<string> {
  const maximumBytes = 2_000_000
  if (file.size > maximumBytes) throw new Error('Stored chapter text is too large.')
  if (!path.endsWith('.gz')) return file.text()
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return text + decoder.decode()
      size += chunk.value.byteLength
      if (size > maximumBytes) throw new Error('Decompressed chapter text is too large.')
      text += decoder.decode(chunk.value, { stream: true })
    }
  } catch (failure) {
    await reader.cancel().catch(() => undefined)
    throw failure
  } finally {
    reader.releaseLock()
  }
}
