import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { copyFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BookOpen } from 'lucide-react'

const root = resolve('extension')
const outDir = resolve('dist-extension')
await build({
  configFile: false,
  root,
  publicDir: false,
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: { panel: resolve(root, 'panel.html'), background: resolve(root, 'background.ts') },
      output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
    },
  },
})
await build({
  configFile: false,
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: false,
    lib: {
      entry: resolve(root, 'capture-entry.ts'),
      name: 'NovelistCapture',
      formats: ['iife'],
      fileName: () => 'capture.js',
    },
  },
})
await copyFile(resolve(root, 'manifest.json'), resolve(outDir, 'manifest.json'))
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  const icon = renderToStaticMarkup(
    createElement(BookOpen, { size: 72, stroke: '#f8f8fa', strokeWidth: 1.7 }),
  )
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(
      `<html><head><style>body{margin:0;background:transparent;width:100vw;height:100vh;display:grid;place-items:center}div{width:100%;height:100%;border-radius:18%;background:#35353b;display:grid;place-items:center}svg{width:65%;height:65%}</style></head><body><div>${icon}</div></body></html>`,
    )
    await page.screenshot({ path: resolve(outDir, `icon-${size}.png`), omitBackground: true })
  }
} finally {
  await browser.close()
}
console.log(`Unpacked browser extension: ${outDir}`)
