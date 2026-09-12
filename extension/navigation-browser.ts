import { contentsCaptureSchema, type ContentsCapture } from '../src/lib/extension/contracts'
import { capturedPageSchema, publicPageUrl } from '../src/lib/scraper/contracts'
import {
  navigationSnapshotSchema,
  type NavigationDecision,
  type NavigationSnapshot,
} from '../src/lib/extension/navigation'
import type { createNavigationDOM } from '../src/lib/extension/navigation-dom'
import { isNovelUpdatesSeries } from '../src/lib/extension/metadata'

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
type BrowserScope = typeof globalThis & {
  __novelistNavigation?: ReturnType<typeof createNavigationDOM>
}
type LinkBatch = ReturnType<ReturnType<typeof createNavigationDOM>['links']>

export class BrowserAccessError extends Error {
  constructor() {
    super(
      'The source requires browser verification. Complete it in the source tab, then resume. No challenge was clicked or sent for extraction.',
    )
  }
}

export function browserNavigation(
  tabId: number,
  allowedOrigin: string,
  stopped: () => Promise<boolean>,
) {
  const checkTab = async () => {
    let tab: chrome.tabs.Tab
    try {
      tab = await chrome.tabs.get(tabId)
    } catch {
      throw new Error(
        'The captured tab was closed. Open the novel and click the Novelist toolbar icon again.',
      )
    }
    if (!tab.url || new URL(tab.url).origin !== allowedOrigin)
      throw new Error(
        'The captured tab changed sites. Click the Novelist toolbar icon on the book page you want to explore.',
      )
    if (isNovelUpdatesSeries(tab.url))
      throw new Error(
        'Novel Updates is a metadata catalog. Open the original or translation site before exploring chapters.',
      )
    return tab
  }

  const documentReady = async (tab: chrome.tabs.Tab) => {
    if (tab.status !== 'loading') return true
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: () => ({ url: document.URL, readyState: document.readyState }),
    })
    const current = results[0]?.result
    return Boolean(
      current &&
      current.readyState !== 'loading' &&
      publicPageUrl(current.url) === publicPageUrl(tab.url!),
    )
  }

  const observe = async () => {
    await checkTab()
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['capture.js'],
      injectImmediately: true,
    })
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: (origin) => {
        if (location.origin !== origin) throw new Error('The tab left the approved site.')
        const api = (globalThis as BrowserScope).__novelistNavigation
        if (!api) throw new Error('The page is still loading.')
        return api.observe()
      },
      args: [allowedOrigin],
    })
    return navigationSnapshotSchema.parse(results[0]?.result)
  }

  return {
    observe,
    async open(target: string) {
      if (new URL(target).origin !== allowedOrigin)
        throw new Error('The selected page must belong to this source site.')
      const tab = await checkTab()
      if (tab.url !== target) await chrome.tabs.update(tabId, { url: target })
      const deadline = Date.now() + 15_000
      let latest: NavigationSnapshot | undefined
      let stableSince = 0
      while (Date.now() < deadline) {
        if (await stopped()) throw new Error('Page navigation stopped.')
        await pause(250)
        const currentTab = await checkTab()
        if (!(await documentReady(currentTab))) continue
        const snapshot = await observe()
        if (snapshot.url !== publicPageUrl(currentTab.url!)) {
          latest = undefined
          stableSince = 0
          continue
        }
        if (snapshot.blocked) throw new BrowserAccessError()
        if (
          snapshot.fingerprint === latest?.fingerprint &&
          stableSince &&
          Date.now() - stableSince >= 600
        )
          return snapshot
        if (snapshot.fingerprint !== latest?.fingerprint) stableSince = Date.now()
        latest = snapshot
      }
      throw new Error('The page did not settle in time. Open it in the browser and retry.')
    },
    async collect(snapshot: NavigationSnapshot): Promise<ContentsCapture> {
      const links: ContentsCapture['links'] = []
      let cursor: number | null = 0
      let truncated = false
      while (cursor !== null) {
        if (await stopped()) break
        const results: chrome.scripting.InjectionResult<LinkBatch | undefined>[] =
          await chrome.scripting.executeScript({
            target: { tabId },
            injectImmediately: true,
            func: (origin: string, snapshotId: string, offset: number) => {
              if (location.origin !== origin) throw new Error('The tab left the approved site.')
              return (globalThis as BrowserScope).__novelistNavigation?.links(snapshotId, offset)
            },
            args: [allowedOrigin, snapshot.id, cursor] as [string, string, number],
          })
        const batch: LinkBatch | undefined = results[0]?.result
        if (!batch) throw new Error('The page navigated while collecting its contents.')
        links.push(...batch.links)
        cursor = batch.next
        truncated ||= batch.truncated
      }
      return contentsCaptureSchema.parse({
        url: snapshot.url,
        title: snapshot.title,
        links,
        truncated,
      })
    },
    async act(snapshot: NavigationSnapshot, decision: NavigationDecision) {
      await checkTab()
      if (await stopped()) return
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        injectImmediately: true,
        func: (origin: string, snapshotId: string, actionJson: string) => {
          try {
            if (location.origin !== origin) throw new Error('The tab left the approved site.')
            const api = (globalThis as BrowserScope).__novelistNavigation
            if (!api) throw new Error('The navigation observation expired.')
            const click = api.act(snapshotId, JSON.parse(actionJson), true)
            return { ok: true, error: '', click }
          } catch (failure) {
            return {
              ok: false,
              error: failure instanceof Error ? failure.message : 'The page action failed.',
            }
          }
        },
        args: [allowedOrigin, snapshot.id, JSON.stringify(decision)] as [string, string, string],
      })
      if (!results[0]?.result?.ok)
        throw new Error(results[0]?.result?.error || 'The page action could not execute.')
      const click = results[0].result.click
      if (click) {
        const dispatched = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (serialized: string) => {
            const expected = JSON.parse(serialized) as {
              token: string
              pageUrl: string
              label: string
              href: string | null
            }
            const element = [
              ...document.querySelectorAll<HTMLElement>('[data-novelist-click]'),
            ].find((entry) => entry.getAttribute('data-novelist-click') === expected.token)
            if (!element) return false
            element.removeAttribute('data-novelist-click')
            const label = (
              element.getAttribute('aria-label') ||
              element.getAttribute('title') ||
              element.textContent ||
              ''
            )
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 240)
            if (
              document.URL !== expected.pageUrl ||
              label !== expected.label ||
              element.getAttribute('href') !== expected.href ||
              !element.isConnected ||
              !element.getClientRects().length ||
              element.matches(':disabled,[aria-disabled="true"]')
            )
              return false
            element.click()
            return true
          },
          args: [JSON.stringify(click)],
        })
        if (!dispatched[0]?.result)
          throw new Error('The contents control changed before it could be clicked.')
      }
    },
    async changed(previous: NavigationSnapshot) {
      const deadline = Date.now() + 10_000
      let latest = previous
      let stableSince = 0
      while (Date.now() < deadline) {
        if (await stopped()) return latest
        await pause(250)
        const tab = await checkTab()
        if (!(await documentReady(tab))) continue
        try {
          const snapshot = await observe()
          if (snapshot.fingerprint !== previous.fingerprint) {
            if (
              snapshot.fingerprint === latest.fingerprint &&
              stableSince &&
              Date.now() - stableSince >= 400
            )
              return snapshot
            if (snapshot.fingerprint !== latest.fingerprint) stableSince = Date.now()
          }
          latest = snapshot
        } catch (failure) {
          if ((await checkTab()).status !== 'loading') throw failure
        }
      }
      return latest
    },
    async capture() {
      await checkTab()
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        injectImmediately: true,
        func: (origin) => {
          if (location.origin !== origin) throw new Error('The tab left the approved site.')
          return (globalThis as BrowserScope).__novelistNavigation?.capture()
        },
        args: [allowedOrigin],
      })
      return capturedPageSchema.parse(results[0]?.result)
    },
  }
}
