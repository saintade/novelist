# Scraper Code Experiment

Status: implemented local tool and execution harness, verified with original fixtures on 2026-09-10.
The local Chrome/Edge extension is now built; see [browser-extension.md](browser-extension.md)
for installation and its review/confirmation workflow. Live-model and live-site quality evaluation
has not been performed by the automated tests.

## What Works

Captured page HTML and URL -> saved site adapter, if available -> isolated execution -> host validation.
On a miss or failed validation: generation/repair -> isolated execution -> up to two repairs -> code
and a review-required report. Successful adapters are retained for subsequent pages on that origin.

This produces actual parser code, not a selector configuration. The model can branch on page type,
traverse the DOM with Cheerio, normalize content, and distinguish pagination from chapter links.
The initial `book-pages-v1` contract supports book indexes, individual chapters, and blocked pages.
It is a book-specific contract on a reusable generation/execution loop, not arbitrary-schema scraping yet.

- Index results: title, optional author/language/synopsis, ordered chapter titles and URLs.
- Chapter results: title, a source-container selector, ordered paragraphs, next-page and next-chapter links.
- Blocked results: a reason when readable content is missing or restricted.
- Reports: code/input hashes, model/prompt/contract versions, sandbox image ID, per-page checks,
  attempt history, reported token usage, duration, and separate held-out results when provided.

Passing captured-page checks never publishes chapters. The personal tool retains the latest passing
adapter per owner/origin/page kind in `site_scrapers`, revalidating it before every reuse. It may recover
eligible code from earlier successful owner-local artifact reports if the database cache is empty.
Database load failures stop rather than triggering unrequested regeneration. Without independently
reviewed expected output, text/link checks cannot prove that all paragraphs were captured, that the
correct body was selected, or that a scraper generalizes. `needs_review` is not an approval.
If all supplied pages return blocked, the report is `blocked`, not a successful extraction.
When `expectedKind` is supplied, a different output kind fails validation and is fed back for repair.
Cache hits use `provided-code` mode, a null model, zero model tokens and `adapter.strategy=reused`.
Generated/repaired runs identify that strategy in their reports. Reuse works with live AI disabled;
repair requires it. The normal confirmation applies before a request that may need paid repair.

## Run Locally

Requires Docker Desktop and the existing Node dependencies. The CLI uses Node's type stripping;
use Node 22.12+ with the included flag, or Node 24.

```sh
npm install
npm run scraper:setup
npm run scraper:experiment -- --fixture
npm run test:scraper
```

The fixture run deliberately returns an invalid adapter first, then a handwritten fixture adapter.
It exercises real Docker execution and feedback handling but makes no model call. The fixture
adapter knows the authored layouts, so its results must not be presented as model generalization.

The recorded run `f8e2b8c2-ce30-4c1b-9fbb-46bff425d6ca` completed in 2,463 ms with two attempts,
two passing training pages, and three passing held-out pages, with zero model tokens. Cases include
index discovery, advertisement noise, split chapters, changed body markup, and unavailable content.
A separate test proves a training-only adapter fails the changed held-out layout without passing
that failure back to the generator.

For a live benchmark against the original fixtures:

```sh
npm run scraper:experiment -- --live-fixture --allow-api-spend
```

This additionally requires `OPENAI_API_KEY` and `NOVELIST_ENABLE_LIVE_AI=true` in the ignored local
environment. `OPENAI_SCRAPER_MODEL` overrides the model used by other AI tools. Verify that the
selected model is available to the account and supports Responses structured outputs and the
configured reasoning setting. Configure secrets locally, never through chat or `VITE_` variables.
No live generation was made during this implementation because the server key was not configured.

For supplied captures, provide a JSON file matching the tool input below:

```sh
npm run scraper:experiment -- --input captures.json --allow-api-spend
npm run scraper:experiment -- --input captures.json --adapter parser.mjs
```

The second command tests an existing module without a model call. It does not import that module
into the host process. Captures without reviewed expected output receive structural/evidence checks
only, and no held-out result is claimed. Permission fields do not cause an API call in provided-code mode.

Artifacts are under `.novelist/scraper/cli/<run-id>/` for CLI runs and
`.novelist/scraper/<owner-id>/<run-id>/` for authenticated tool runs. They include sanitized captures,
each generated module, explanation/limitations, and the final JSON report. Fixture runs also preserve
held-out cases separately. Directories are mode 0700, files mode 0600, ignored by Git, and denied by
Vite's file server. These are local experimental artifacts, not yet Supabase-managed source records.
Provider errors or incomplete responses can be billable; totals only include usage reported by
successful generator responses and are not a billing ledger.

## Tool and Plugin Boundary

- Tool name: `generate_book_scraper`.
- Discover its schema: `GET /api/ai/scraper-tool`.
- Run it: `POST /api/ai/generate-scraper`, with JSON and the library's Bearer session token.
- Implementation: [tool.ts](../server/scraper/tool.ts).
- Typed application client: [client.ts](../src/lib/scraper/client.ts).
- Browser DOM capture helper: [capture.ts](../src/lib/scraper/capture.ts).

Example request shape:

```json
{
  "pages": [
    {
      "url": "https://books.example.com/novel/chapter-1",
      "html": "<!doctype html><html><body><h1>Chapter 1</h1><article><p>Captured text.</p></article></body></html>"
    }
  ],
  "rightsConfirmed": true,
  "sendToModelConfirmed": true
}
```

The response contains `{ report, code }`. Always render returned code as text and inspect the
report status; do not use `eval`, inject a script element, or run it in an extension/content script.

The implemented plugin workflow is:

1. On an explicit user gesture, call `captureCurrentPage(document)` in the visited book tab.
2. Preview the capture and get permission to send it to the model. The helper removes forms,
   scripts, comments, explicit hidden content, event handlers, and common secret attributes/URLs.
   It does not read cookies, local storage, passwords, or browser credentials. Filtering is not a
   guarantee that visible page text contains no private data; the preview/consent step remains necessary.
3. The personal extension connects automatically through the local app's browser session, with
  an extension-initiated nonce handshake and no approval click. Analyze the separately approved capture
  first and display structurally validated metadata and chapter candidates, without an initial
  evidence-quote gate. No scraping starts here.
4. Separately confirm a scrape test of the current page and up to two selected same-site links.
  The host validates public DNS addresses and fetches cookie-free samples without redirects.
5. Show generated code, sample outputs, failures, and limitations for review. A separate explicit
  Scan contents action can navigate the captured tab to its same-site contents URL and enumerate
  chapter links without a model call. Add to Novelist saves reviewed metadata, inventory and paired
  edition URLs; chapter bodies are not automatically imported.
6. Separately approved browser exploration can click registered navigation controls, choose an
  observed dropdown option or scroll, bounded at 12 actions, three model decisions and four minutes.
  Contents transfer in 500-link batches. Up to three rendered reading samples may replace HTTP samples
  in the scraper test, with the same text budget and a separate confirmation; they are not refetched.
7. A captured Novel Updates series entry may be kept as metadata reference for later identification.
  Its associated names and publisher information can support matching, but catalog release rows and
  redirects are excluded from chapter enumeration and scraper tests. This reference is not supplied
  as chapter text to the generated adapter.

The capture helper does not transmit data itself, and the client is for the trusted Novelist origin,
not for direct injection into an arbitrary website. The current localhost API deliberately rejects
cross-origin requests. The extension instead uses a separate extension-ID-bound, short-lived
connection through `/api/extension/` and its own review interface. A one-time code is passed
via Chrome external messaging from a nonce-bound temporary local app tab; it does not hand the library token to
the extension or add wildcard website CORS. No MCP server is registered by this change.

## Execution and Limits

- One public origin, 1-3 supplied pages, at most 80,000 HTML characters each and 160,000 total.
- The core scraper tool operates on supplied DOM and does not fetch or navigate. The extension
  bridge can additionally fetch at most two explicitly selected public chapter pages, or accept
  already-rendered pages from the approved browser navigation driver. It never runs generated scraper
  code in the extension or novel tab; the browser planner selects only registered host actions.
- At most three generation calls, 6,000 output tokens each, SDK retries disabled.
- Two scraper jobs concurrently per server process. Authentication holds the library lock with zero
  model reservations while checking saved code. Generation/repair reserves three of the shared 20
  AI requests/hour; unused reserved capacity is conservatively not refunded.
- A fresh Docker container per page, with no network, no host mounts, no credentials, UID 1000,
  read-only root filesystem, dropped capabilities, and no privilege escalation.
- Per execution: five-second wall limit including startup, 192 MB memory, 0.5 CPU quota, 32-process
  limit, 4 MB temporary filesystem, and bounded 512 KB process output. Containers are removed afterward.
- Node and Cheerio versions are pinned for the sandbox; dependency installation is locked and scripts disabled.
- Submitted URLs reject credentials, unsafe schemes, private IP literals, and common secret parameters.
  The host only accepts same-origin navigation found in the supplied HTML. There is no host fetcher,
  so these lexical checks are not a claim of DNS-rebinding or redirect protection for future fetching.

Tests exercise unprivileged execution, blocked root writes, host-secret isolation, unavailable
external networking, non-returning/flooding adapters, repair budgets, held-out isolation, authentication,
source filtering, and file-server denial. Docker is an isolation layer for a local developer prototype,
not a security certification for arbitrary adversarial code in a multi-tenant hosted service.

`RUN_SUPABASE_TESTS=1 npm run test:scraper` also tests the authenticated tool against local Supabase
with a mocked provider. `RUN_SUPABASE_TESTS=1 RUN_SCRAPER_TESTS=1 npm test` runs all unit/integration gates.

## Next Experiment

Configure a permitted live model and run the fixture benchmark, without exposing held-out pages or
their expected outputs to the generator. Then capture representative and held-out pages from one
authorized public source and compare actual omissions, chrome, pagination, failures, cost, and repairs.

The paired plugin capture/review UI and a small public sampler now exist. Extend the host-owned
queue only after live-source evaluation and explicit bulk-scrape approval. Add Supabase adapter/source versions and an
explicit reviewed import into the existing library. Virtualized chapters, iframe content, scans/canvas,
login/paywalls/CAPTCHAs, and whole-site reliability are not solved by the current HTML experiment.