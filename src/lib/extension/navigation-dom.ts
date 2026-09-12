import { captureContentsNavigation, captureCurrentPage } from '../scraper/capture'
import { publicPageUrl } from '../scraper/contracts'
import { discoverContents } from './contents'
import {
  checkNavigationDecision,
  isAccessChallenge,
  NAVIGATION_LIMITS,
  prohibitedNavigation,
  type NavigationControl,
  type NavigationDecision,
  type NavigationSnapshot,
} from './navigation'

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
const navigationLabel =
  /contents|chapters?|catalog|directory|expand|order|sort|ascending|oldest|first|read|next|more|continue|\u76ee\u5f55|\u76ee\u9304|\u5c55[\u5f00\u958b]|\u6b63\u5e8f|\u5347\u5e8f|\u5f00\u59cb|\u958b\u59cb|\u4e0b\u4e00|\u4e0b[\u9875\u9801]|\u66f4\u591a|\u9605\u8bfb|\u95b1\u8b80/i

export function createNavigationDOM(document: Document) {
  const window = document.defaultView!
  let current: NavigationSnapshot | undefined
  let inventory = captureContentsNavigation(document)
  let registry = new Map<string, { element: HTMLElement; control: NavigationControl }>()
  const visible = (element: HTMLElement) =>
    !element.closest('[hidden],[aria-hidden="true"],[inert]') &&
    window.getComputedStyle(element).display !== 'none' &&
    window.getComputedStyle(element).visibility !== 'hidden' &&
    Boolean(element.getClientRects().length)
  const labelOf = (element: HTMLElement) =>
    normalize(
      element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.textContent ||
        '',
    ).slice(0, 240)
  const destination = (element: HTMLElement) => {
    const href = element.getAttribute('href')
    if (!href || /^javascript:/i.test(href)) return null
    try {
      return publicPageUrl(new URL(href, document.URL).href)
    } catch {
      return 'invalid'
    }
  }
  const fingerprint = (text: string) => {
    let value = 2166136261
    for (let index = 0; index < text.length; index++)
      value = Math.imul(value ^ text.charCodeAt(index), 16777619)
    return (value >>> 0).toString(16)
  }

  const observe = (): NavigationSnapshot => {
    const url = publicPageUrl(document.URL)
    const origin = new URL(url).origin
    inventory = captureContentsNavigation(document)
    const counted = discoverContents(inventory, {
      chapterCount: null,
      chapterLinks: [],
      indexUrl: null,
    })
    const controls: { element: HTMLElement; control: NavigationControl; priority: number }[] = []
    const seen = new Set<HTMLElement>()
    for (const element of document.querySelectorAll<HTMLElement>(
      'a,button,select,[role="button"],[role="link"],[onclick]',
    )) {
      if (
        seen.has(element) ||
        !visible(element) ||
        element.closest('form') ||
        element.matches(':disabled,[aria-disabled="true"]')
      )
        continue
      const parentControl = element.parentElement?.closest(
        'a,button,select,[role="button"],[role="link"]',
      )
      if (parentControl) continue
      const label = labelOf(element)
      const target = element.getAttribute('target')
      const href = destination(element)
      if (
        !label ||
        prohibitedNavigation(label, href) ||
        element.hasAttribute('download') ||
        (target && target !== '_self') ||
        href === 'invalid' ||
        (href && new URL(href).origin !== origin)
      )
        continue
      const isSelect = element.tagName === 'SELECT'
      if (isSelect && !navigationLabel.test(label + (element.getAttribute('name') || ''))) continue
      const options = isSelect
        ? [...(element as HTMLSelectElement).options]
            .filter((option) => !option.disabled)
            .slice(0, 30)
            .map((option) => ({
              value: option.value.slice(0, 150),
              label: normalize(option.text).slice(0, 150),
            }))
        : []
      const control: NavigationControl = {
        id: `control-${controls.length}`,
        label,
        role: isSelect ? 'select' : element.tagName === 'A' ? 'link' : 'button',
        url: href,
        options,
      }
      controls.push({
        element,
        control,
        priority: /^(?:chapter\s*|\u7b2c\s*|\u3010)\d/i.test(label)
          ? 2
          : navigationLabel.test(label)
            ? 0
            : 1,
      })
      seen.add(element)
    }
    controls.sort((first, second) => first.priority - second.priority)
    registry = new Map(
      controls
        .slice(0, NAVIGATION_LIMITS.controls)
        .map(({ element, control }) => [control.id, { element, control }]),
    )
    const body = document.body.cloneNode(true) as HTMLElement
    body
      .querySelectorAll('script,style,form,input,textarea,[hidden],[aria-hidden="true"],iframe')
      .forEach((element) => element.remove())
    const text = normalize(body.textContent || '')
    const excerpt = text.length <= 1600 ? text : `${text.slice(0, 1000)} ... ${text.slice(-590)}`
    const scrolling = document.scrollingElement || document.documentElement
    const blocked =
      isAccessChallenge(document.title, text) ||
      Boolean(
        document.querySelector('input[type="password"],iframe[src*="captcha"],[class*="captcha"]'),
      ) ||
      /(?:verify you are human|access denied|captcha required|\u8acb\u5148\u767b\u9304|\u8bf7\u5148\u767b\u5f55|\u9a8c\u8bc1\u7801|\u9a57\u8b49\u78bc)/i.test(
        text.slice(0, 1500),
      )
    current = {
      id: window.crypto.randomUUID(),
      url,
      title: document.title.slice(0, 500),
      excerpt,
      fingerprint: fingerprint(
        `${url}|${text}|${scrolling.scrollTop}|${inventory.links.map((entry) => entry.url).join('|')}`,
      ),
      controls: [...registry.values()].map((entry) => entry.control),
      linkCount: inventory.links.length,
      chapterLinkCount: counted.foundCount,
      chapterSamples: [
        ...counted.chapters.slice(0, 3),
        ...(counted.chapters.length > 3 ? counted.chapters.slice(-3) : []),
      ].map((entry) => ({ url: entry.url, title: entry.sourceTitle.slice(0, 240) })),
      canScroll: scrolling.scrollTop + window.innerHeight < scrolling.scrollHeight - 4,
      blocked,
    }
    return current
  }

  return {
    observe,
    links(snapshotId: string, cursor: number) {
      if (
        !current ||
        snapshotId !== current.id ||
        publicPageUrl(document.URL) !== current.url ||
        !Number.isInteger(cursor) ||
        cursor < 0
      )
        throw new Error('The page changed before its contents were collected.')
      return {
        url: inventory.url,
        title: inventory.title,
        links: inventory.links.slice(cursor, cursor + NAVIGATION_LIMITS.linkBatch),
        next:
          cursor + NAVIGATION_LIMITS.linkBatch < inventory.links.length
            ? cursor + NAVIGATION_LIMITS.linkBatch
            : null,
        truncated: inventory.truncated,
      }
    },
    act(snapshotId: string, value: NavigationDecision, deferClick = false) {
      if (!current || current.id !== snapshotId || current.url !== publicPageUrl(document.URL))
        throw new Error('The page changed. Observe it again before clicking.')
      const decision = checkNavigationDecision(current, value)
      if (decision.action === 'scroll') {
        window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'instant' })
        return
      }
      if (!decision.controlId || !['click', 'select'].includes(decision.action)) return
      const registered = registry.get(decision.controlId)
      if (
        !registered ||
        !registered.element.isConnected ||
        !visible(registered.element) ||
        labelOf(registered.element) !== registered.control.label ||
        destination(registered.element) !== registered.control.url ||
        registered.element.matches(':disabled,[aria-disabled="true"]')
      )
        throw new Error('This control changed. Observe the page again.')
      if (decision.action === 'select') {
        const select = registered.element as HTMLSelectElement
        if (
          ![...select.options].some((option) => option.value === decision.value && !option.disabled)
        )
          throw new Error('The select option changed.')
        select.value = decision.value!
        select.dispatchEvent(new window.Event('input', { bubbles: true }))
        select.dispatchEvent(new window.Event('change', { bubbles: true }))
      } else {
        if (deferClick) {
          const token = window.crypto.randomUUID()
          registered.element.setAttribute('data-novelist-click', token)
          return {
            token,
            pageUrl: document.URL,
            label: registered.control.label,
            href: registered.element.getAttribute('href'),
          }
        }
        registered.element.click()
      }
    },
    capture: () => captureCurrentPage(document),
  }
}
