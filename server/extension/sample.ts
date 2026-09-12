import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { MIMEType } from 'node:util'
import ipaddr from 'ipaddr.js'
import {
  capturedPageSchema,
  publicPageUrl,
  type CapturedPage,
} from '../../src/lib/scraper/contracts.ts'
import { prepareCapturedPage } from '../scraper/validate.ts'
import { pageNavigation } from './inspect.ts'

export function approvedSampleUrl(page: CapturedPage, candidate: string): URL {
  const url = new URL(publicPageUrl(candidate))
  if (url.hash)
    throw new Error(
      'This page uses browser routing. Use browser navigation to capture its rendered content.',
    )
  if (!pageNavigation(page).has(url.href))
    throw new Error('Only same-site links from the captured page can be sampled.')
  if (
    /(?:^|\/)(?:logout|signout|delete|unsubscribe|checkout|login|signin)(?:\/|$)/i.test(
      url.pathname,
    ) ||
    [...url.searchParams.keys()].some((name) => /^(action|operation|logout|delete)$/i.test(name))
  )
    throw new Error('Account and action links cannot be sampled.')
  if (url.port && !['80', '443'].includes(url.port))
    throw new Error('Only standard web ports can be sampled.')
  return url
}

export function requirePublicAddresses(addresses: { address: string; family: number }[]) {
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) => !ipaddr.isValid(address) || ipaddr.process(address).range() !== 'unicast',
    )
  )
    throw new Error('Private, local, and reserved network destinations cannot be sampled.')
  return addresses[0]
}

export async function fetchChapterSample(
  page: CapturedPage,
  candidate: string,
): Promise<CapturedPage> {
  const url = approvedSampleUrl(page, candidate)
  let dnsTimer: ReturnType<typeof setTimeout> | undefined
  const address = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }).then(requirePublicAddresses),
    new Promise<never>((_, reject) => {
      dnsTimer = setTimeout(() => reject(new Error('Source DNS resolution timed out.')), 3000)
    }),
  ]).finally(() => clearTimeout(dnsTimer))
  const html = await new Promise<string>((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = transport(
      {
        hostname: address.address,
        family: address.family,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        servername: url.hostname,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        agent: false,
        headers: {
          Host: url.host,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Encoding': 'identity',
          'User-Agent': 'Novelist-Preview/0.1',
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy()
          reject(
            new Error(
              response.statusCode && response.statusCode >= 300 && response.statusCode < 400
                ? 'This link redirects. Open its destination manually before sampling.'
                : `This page is unavailable for a public preview (HTTP ${response.statusCode}).`,
            ),
          )
          return
        }
        let mime: MIMEType
        try {
          mime = new MIMEType(response.headers['content-type'] || '')
        } catch {
          response.destroy()
          reject(new Error('This source did not return an HTML page.'))
          return
        }
        if (
          !['text/html', 'application/xhtml+xml'].includes(mime.essence) ||
          (response.headers['content-encoding'] &&
            response.headers['content-encoding'] !== 'identity')
        ) {
          response.destroy()
          reject(new Error('Only uncompressed HTML pages can be sampled.'))
          return
        }
        const chunks: Buffer[] = []
        let length = 0
        response.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > 1_000_000)
            request.destroy(new Error('This sample exceeds the 1 MB response limit.'))
          else chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          try {
            resolve(
              new TextDecoder(mime.params.get('charset') || 'utf-8').decode(Buffer.concat(chunks)),
            )
          } catch {
            reject(new Error('This sample uses an unsupported text encoding.'))
          }
        })
      },
    )
    const timer = setTimeout(
      () => request.destroy(new Error('The chapter sample timed out.')),
      8000,
    )
    request.on('close', () => clearTimeout(timer))
    request.on('error', reject)
    request.end()
  })
  return capturedPageSchema.parse(prepareCapturedPage({ url: url.href, html }))
}
