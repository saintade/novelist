# Novelist

A personal reading library built with React, TypeScript, Vite, and local Supabase.
This first version focuses on importing books and reading comfortably on desktop and phones.
It is not a public book-discovery website.

## Run Locally

Requires Node.js 22.12+ and Docker Desktop running. The Supabase CLI is a project dependency.

```sh
npm install
npm run db:start
npx supabase migration up --local
npm run dev -- --host 127.0.0.1
```

- App: http://127.0.0.1:5173
- Supabase API: http://127.0.0.1:55321
- Supabase Studio: http://127.0.0.1:55323
- Postgres: localhost:55322

The nondefault ports avoid another local project. The initialized Supabase project ID remains
`translator` to retain its existing Docker volumes; the app and npm package are named Novelist.
Do not rename that ID without migrating its data.

[.env.example](.env.example) lists the browser configuration variables. This workspace's ignored
`.env.local` is already configured. For a fresh setup, obtain the local API URL and publishable
key from the Supabase CLI. Never put secret or service-role keys in `VITE_` variables.

`npm run db:stop` stops this project's services and retains data. Database resets and Docker
volume deletion are destructive. Do not expose the local API, database, or Studio publicly.

## Included

- Library cover/table views, search, sorting, and reading-status filters.
- EPUB and UTF-8 TXT imports, duplicate detection, original downloads, and removal.
- Editable book details and synopsis, searchable/paginated chapter lists, and bookmarks.
- Reader with light/dark themes, font selection, text size, line spacing, and width controls.
- Chapter navigation, in-chapter search, reading progress, and browser recovery checkpoints.
- Phone-sized touch targets, safe-area spacing, compact toolbar, and full-height reading settings.
- Three real public-domain sample EPUBs with [source attribution](public/books/SOURCES.md).
- A synthetic Chinese test novel with a paired English reference in private Storage.
- Independent source books with source-host labels, folders, optional context books, selected
  language-pair glossaries and evolving style guides. No chapter-pairing workflow is required.
- Preview or translate title/synopsis, explicitly apply metadata, and translate source chapters
  into immutable versions with clickable noun review and contextual AI term suggestions.
- A plain top-right settings button with Light/Dark choices and reading preferences.

## Storage and Privacy

There is no sign-in screen. Supabase silently creates an anonymous authenticated session so
row-level policies can isolate the library. Retain that browser session to access its books.
Clearing browser data or using another browser creates a different library; cross-device access
will require linking the anonymous session to a durable account later.

Postgres stores books, folders, chapter metadata, reading progress, bookmarks, and sample-import state.
Canonical novels, source records, glossary entries, chapter examples, style profiles, and experiment history are
also stored in owner-isolated tables. Existing reading copies keep their content and progress.
Translation settings, chapter-reference pairs, draft/context snapshots and successful site-navigation
recipes are owner-isolated too. Site reuse spans this library's novels, never other libraries.
The private `library` bucket stores originals, covers, chapter examples, and one JSON object per chapter.
Imports upload in bounded batches and become visible after completion. Retry an interrupted
import with the same file. File uploads and SQL writes are not a single transaction.
There is no MinIO or IndexedDB book backend.

Appearance preferences and last-position recovery checkpoints use browser local storage.
Chapter content comes from Supabase. This is not yet an offline/PWA reader.

## Code Layout

```text
src/
  app/                  Shared library context
  components/
    layout/             Library navigation and shell
    library/            Book tiles, table, import/edit dialogs, bookmarks
    reader/             Contents and reading-settings panels
    translation/        Source/reference setup, metadata previews, drafts, glossary and style
    Reader.tsx          Reading workflow and chapter view
    ui.tsx              Shared accessible UI primitives
  pages/                Library, book details, bookmarks, reader routes
  lib/
    books.ts            EPUB/TXT normalization and content sanitization
    library/            Supabase repository, sample import, presentation helpers
    reader/             Chapter rendering, reader settings, recovery checkpoints
    translation/        Translation repositories, chapter pairing and context contracts
    ai/                 Shared extraction contracts and authenticated API client
    supabase/           Client and generated database types
    preferences.ts      Browser preference persistence
    format.ts           Display formatting
  styles/               Global tokens, library, and reader styles
supabase/migrations/    SQL schema and access policies
server/ai/             Local authenticated OpenAI experiment handler and validators
tests/browser/          Desktop Chromium, Android, and iPhone/WebKit workflows
public/books/           Public-domain sample files and attribution
```

## Verification

```sh
npm run build
npm run lint
npm test
npm run test:integration
npx playwright install chromium webkit
npm run test:browser
npm run db:lint
```

The integration test requires local Supabase and checks tables, files, duplicate imports,
serialized updates, scoped glossary precedence, optimistic versions, atomic proposal rollback,
deletion, and denial of cross-session access. Browser tests use isolated
sessions and remove their own books afterward. They cover reading, reloads, bookmarks, themes,
search, a 105-chapter import, failed-save recovery, and phone overflow. Run them locally.
They also exercise fixture extraction through the internal API, URL linking, example uploads,
inference consent/failure states, glossary approval, and the settings menu.
Screenshots and failure traces are written to the ignored `test-results` directory.

Run `npm run db:types` after schema changes and `npm run format` to format the frontend.
The XML-parser override patches the old transitive dependency used by epub.js.

## Deployment and Limits

Deploy with an SPA fallback to `index.html`, HTTPS, and a reachable hosted Supabase URL/public
key. Apply the migrations and configure Auth for the deployment. Link the anonymous library
to a recoverable identity before relying on it across devices. `127.0.0.1` on a phone points
to that phone, not this development machine. Phone layouts are browser-emulation tested,
not tested on physical devices.

Supabase Cloud plus a Render Free Node service is the selected private hosting setup. The
production server, permanent sign-in and restrictive owner policies are implemented, but the
hosted restore/deployment is pending CLI authorization. `npm run build && npm start` serves the
app and API with production configuration. Static hosting alone cannot run the worker. See
[note.txt](note.txt) for exact Render settings and the [deployment guide](docs/deployment.md) for
owner-preserving migration. Free Render can sleep or restart; saved jobs/results remain in Supabase.

Imports support unencrypted reflowable EPUBs and plain text, up to 50 MB per file. Complex
fixed layouts, DRM, PDF, and cross-chapter EPUB footnote navigation are not supported.
Imported HTML is sanitized; remote embedded images and scripts are not executed. This is a
personal-use prototype, not an untrusted public-upload service.

## Books and Folders

Each reading source is its own library book with its own chapters, downloaded text and reading
position. Novel Updates is an optional catalog attachment, not a reading edition. Source hosts and
languages distinguish similar titles in the library. Another library book can be used as translation
context without merging or pairing the books.

Migrations012-016 converted the existing secondary reading sources into independent books. A private
backup was taken first. Source IDs, files, progress and reviewed matches were retained; migration016
verified all 659 chapter records present at that time were unchanged.

Create folders with the folder-plus icon in Library. Use a book's actions menu > **Move to folder**,
then filter with **Folder**. Rename/delete controls appear for the selected folder. Deleting a folder
moves its books to **Unfiled** without deleting content. Folders are flat, owner-scoped, and allow one
folder per book. The current-book strip remains visible across folder and shelf filters.

## Source Downloads and Reading

Each book opens its own source inventory. Novel Updates and Open source are aligned actions in
**Metadata**, never chapter sources. Genre is in Metadata; Edit is in the three-dot book menu.
Library cards use fixed two-line title/author slots; hovering reveals the full text.

Open the book's **Downloads** tab for direct batch controls and extraction tools, without dropdown panels.
Opening a chapter downloads it if needed, then opens its text in Novelist. Stored chapters are
reused without another site request. **Download range** starts at the first missing chapter and suggests
the next five positions; **Download all** includes the full saved inventory. Both skip saved URLs,
run sequentially and can stop
after the current chapter. **Resume downloads** keeps the queue while the page stays open; after reload,
rerun the range or all to skip completed chapters. This is not an unattended background scheduler.

In Downloads, **Extraction tools** offers a free **Test direct fetch** against a selected
saved chapter URL. It bypasses downloaded text, fetches fresh HTML and tests the cached extractor,
without a model call or chapter overwrite. **Rebuild scraper** explicitly authorizes up to three model
requests for a fresh extractor. Only a passing replacement is cached; failures preserve the previous
scraper. An extracted-text preview helps distinguish a successful HTTP fetch from successful extraction.
Split-page tests validate the first page only; downloads validate every page before saving.

In the extension, **Download method** beside the chapter picker switches between **Direct URL fetch** and
**Rendered browser pages**. This per-site setting also controls single chapter downloads. Direct mode
sends saved chapter URLs to asynchronous server jobs and never opens or captures chapter tabs. A
successful direct extraction test selects it automatically for subsequent downloads. Pause before
switching methods, then resume the same queue. Failed direct access pauses instead of silently navigating
the browser. Cached scrapers are reused without a model call for each chapter.
**Bulk downloads** contains the all/range controls. Both modes remain sequential. There is no
production concurrent-workers setting; the earlier parallel experiment was a local benchmark.

To remove a source, open **Translation > Metadata** and use its trash icon. Confirmation removes the
source inventory, downloaded source text, source reading progress and pairings. The novel, other
sources, imported files, glossary, style history and saved translation snapshots remain. Preferences
referencing the source are cleared; a selected continuation guide based on it is deselected. Removing
the last source leaves the novel in the library with no indexed chapters. Storage-cleanup failures are
reported separately from successful source removal.

Direct fetching is attempted first, with public DNS/address validation, standard ports, no cookies,
redirect rejection, 1 MB response and eight-second request limits. HTML is filtered, then parsed by
a cached scraper inside the network-disabled Docker sandbox. If generation or repair is needed,
the app asks before allowing up to three model requests for that chapter request. Extraction must
pass before text is saved. At most five pages, 160,000 text characters and 2,000 paragraphs are
accepted per chapter; incomplete or repeating pagination never publishes a partial chapter.

If a site blocks direct access, open its paired source page in the extension, select **Chapter**,
then **Download chapter**. This uses the rendered tab and saves text to the same source; a model
confirmation appears only if the cached scraper fails. **Open source in browser** on the blocked
reader opens the paired source page; its tooltip describes the extension action. Use the same
Chrome/Edge library session. Returning to Novelist checks saved text and opens the chapter without
retrying the blocked HTTP request; **Check saved chapter** performs that check manually. For a paused
range, **Resume downloads** checks the blocked chapter is saved before continuing. Neither check
fetches the blocked page or starts AI when the text is still missing. Scan & save chapters remains
link-only; it does not save chapter text. Do not bypass login, CAPTCHA or access restrictions.
On 2026-09-11 the guarded live fetch
accepted Freewebnovel chapter one (31,232 filtered HTML characters), while 101kks returned HTTP 403
and required browser capture. No model call was made for that access check.

## Translation Settings

**Translation > Settings** contains the target language, optional context book, model choices and
selected glossary sources. Chapter selection and translation happen in the reader, not in Settings.
Context can use recent earlier chapters or broad writing style; historical matches are retained but
the pairing controls are removed. Other-book glossaries show their language pair, category and
approved-term count. Chinese-to-Spanish terms do not enter a Chinese-to-English request.

**Metadata** contains catalog attachments and review. Attach a Novel Updates series URL, preview
saved metadata without AI, or explicitly translate it. Review before **Apply to book page** changes
the title, author, synopsis or cover. A later book/settings change rejects a stale preview.

**Glossary** searches the whole loaded collection, including aliases, meaning, notes, evidence,
categories and language fields; results are paginated25 per page. Approved chapter/book terms take
precedence over explicitly selected external glossaries and global defaults. Rejected terms are
excluded. Similarity matches remain hints, not evidence of the same person or ability.

## Translate and Read

Open a source chapter and click **Translate** in the centered Original/Translate switch. With saved
preferences, one click translates, saves and opens the result. A request contains the complete current
source (up to18,000 characters), chapter title/position, recent saved translations, available earlier
context chapters, relevant approved glossary mappings and a compatible compact guide. The current
original is authoritative; neither prior translations nor the style guide can introduce story facts.

The Translate side reuses a saved result for the source, content hash and language, including after
reload. **Original** switches back. Previous/Next are above and below the chapter text. If the next chapter is
untranslated, its original text stays visible instead of a blank page; navigation never starts AI.
Contents is on the left of the bottom toolbar, Settings alone on the right, and chat/Search at the top.
Light/dark is inside Settings. The visible scrollbar is hidden only while reading; normal scrolling
continues. Contents opens on the active chapter's page and centers its row, without moving the text
underneath. Original and translated chapter/language/version/scroll positions are persisted separately.
Continue uses the newest reading activity; old delayed saves cannot rewind it.

Reading settings contains **Retranslate chapter**, **Chapter terms**, guide/settings links and version history.
Retranslation creates a new version. The latest 20 matching versions are selectable; older rows are
retained. Paragraph breaks, margins and deliberate line breaks are preserved. Collapsing a
multi-paragraph source into one paragraph is rejected before saving.

Names and specialist terms are underlined in both modes when a saved mapping exists. Matching handles
unspaced Chinese and supported English noun inflections without matching inside unrelated names.
Shared English labels open a source-mapping review instead of guessing. **Chapter terms** shows
established mappings, new candidates, different renderings, missing target spellings and rejected
term-evidence warnings. Saved glossary context can supply mappings the model did not repeat.

Click an unambiguous term to save a corrected version and approved glossary preference atomically,
without a model call. English inflections are preserved. Highlight other text to save a preference.
**Suggest with AI** is a separate explicit billable action: it sends the full current original,
selected translation when available, exact/alias/similar glossary choices from allowed sources,
and your optional **Context for this term**. Results include an explanation, source evidence and
alternatives. **Use suggestion** fills the form; only Save changes the library. Shared-label or
glossary-only corrections remain preferences until the chapter is retranslated.

Translation defaults to `gpt-5.6-luna` and chat to `gpt-4.1-mini`, independently overridable per book.
**Average translation time** groups measured translations by model and target language, with a
sample count and separate preparation, guide-update and generation averages. Missing timings and
manual edits are excluded rather than counted as zero. Timing-only records are read across all
history pages; the average is not limited to the newest preview list. The extraction
uses strict JSON Schema, seven term categories, exact source evidence and complete compound names.
It explicitly requests established terms as well as new candidates. Unsupported term evidence is
skipped with saved warnings rather than discarding an otherwise valid chapter.

**Rolling context** defaults to three recent full translations and a 128,000-token total application
budget, including a16,384-token output reserve. Recent reference chapters are also included. Counts
(1-10) and the total budget (32k-128k) are configurable per book. Older optional context is dropped
first above 80% of the input budget; the source, glossary and compact guide are retained. Estimates
use o200k_base plus a prompt allowance, not a guarantee about Luna's exact tokenizer or model capacity.
The server checks the budget before spending and saves provider-reported usage with each version.

**Style Guide** shows current instructions, eligible/covered chapters, a reader request, version
history and highlighted **Before / after** comparisons. Updates compact older generated translations
outside the recent window and downloaded reference examples with the previous guide into a complete
replacement, not an ever-growing appendix. A batch uses at most8 examples/32,000 characters and
produces at most6,000 instruction characters. It records broad prose conventions, not a plot summary
or a glossary, and can continue after an external English reference ends.

Automatic updates are opt-in; they were explicitly enabled for the user's current Novel543 book.
The default cadence is5 newly translated chapters (configurable1-100), or context pressure. An eligible
update makes one request before translation; no new evidence/feedback means no call. Retranslations
and manual edits do not advance the counter. Exact source hashes and translation-version identities
protect guide reuse after corrections, language/source changes or moving to an earlier chapter.

Raw model completion/refusal status is checked before parsing the JSON. Incomplete output never
publishes a partial chapter. Output ceilings are16,384 for a chapter,8,192 for metadata or a guide,
12,000 for standalone noun extraction, and4,096 for a contextual term suggestion. These are ceilings,
not guaranteed sufficiency for arbitrary text. A limit hit, timeout, rate limit, credential problem
or save conflict is reported explicitly. There is no automatic paid retry; saved versions retain
provider completion and token-usage metadata. Semantic omissions still require reading/review.

`NOVELIST_AI_CONCURRENCY` defaults to8 (maximum32); `NOVELIST_AI_REQUESTS_PER_HOUR=0` disables the
optional hourly cap. This does not change sequential site-download pacing or Docker limits.

## Mass Translation

1. Open a source book and its **Translate** tab. Download the original chapters first under
   **Downloads** and save the book's translation preferences if prompted.
2. Choose **Translate untranslated** for the entire indexed book, or set **From chapter** and
  **To chapter**, then **Review translation range**. Manual ranges are inclusive, up to1,000
  chapters; whole-book jobs support the20,000-chapter inventory limit. All originals must be
  downloaded first. **Chapters per request (maximum)** defaults to10 and accepts1-10.
3. Review the model/language, existing versions, missing downloads, request count and cost estimate.
   Confirm billable usage, then choose **Start translations**. Merely opening/reviewing makes no
   model request. The estimate includes selected chapters before skips; actual cost can be lower.
4. Track saved/skipped/remaining chapters in the queue. **Pause translations** finishes the current
  request before pausing. Starting authorizes up to3 total attempts per unfinished chapter.
  Transient model failures and incomplete results retry automatically with backoff; already saved
  chapters are kept. Quota/access/source/preference errors and exhausted attempts stop the job.
5. **Cancel queue** cancels the remaining chapters after the current request. Originals, reading
   position, earlier versions and completed translations are kept. Saved rows have **Read** links.

Groups shrink to fit source lengths, output headroom and the total context budget. Luna's grouped
application output ceiling is65,536 tokens, GPT-4.1's32,768 and GPT-4o mini's16,384. Unknown models
default to16,384; a verified `NOVELIST_GROUP_OUTPUT_LIMIT` override can raise this up to65,536,
still clamped for known models. Ten is a maximum, not a promise for each request.

Each group shares its first chapter's recent/reference/style context and uses per-chapter approved
glossaries. New translations and opt-in guide updates affect the next request. A10-chapter group
can pass the default5-chapter guide cadence before updating. Choose1 for per-chapter continuity.
Exact source/hash/language checks skip valid saved versions. Retranslate creates a new version.

Strict grouped output carries source keys, hashes, ordered paragraph IDs and a completion marker.
At an output-token limit, fully closed chapter objects can be independently validated and saved.
Missing/duplicate/mismatched or unfinished chapters are not published. Malformed JSON is not repaired.
Automatic retries use smaller groups after invalid/truncated output, without regenerating successful
chapters. Paragraph coverage is structural validation, not proof of semantic completeness.

Regular Translate/Retranslate starts a durable one-chapter background job and returns promptly.
Completion never redirects another book; return to the requested chapter to load its saved result.
Reader and bulk jobs run on different chapters together, share overlapping running work and do not
replace each other's queues. Reader recovery controls affect only that reader job.

Queues and per-chapter results live in Supabase (migrations027-041), and new previews are committed
atomically with their queue result. Changing tabs, navigating away or reloading does not discard a
queue. Workers wait for occupied local AI slots rather than failing. Development reloads retain
active worker state. Leases prevent concurrent processing; interrupted jobs resume on authenticated
reconnect within the attempt limit. Manually paused jobs stay paused. Session renewal in any open
app view refreshes the workers, but credentials are not stored in the database: a closed app and
expired token or free-host shutdown can delay completion until reconnect. Retries may incur charges.
Source/inventory or preference changes stop the queue; cancel and review a fresh range to use them.

This uses the **regular Responses API at normal pricing**, not OpenAI's discounted asynchronous
Batch API. Group timing/token averages are equal allocations across requested chapters, not exact
individual latency or billing. The per-request admin ledger avoids counting one group ten times. The
[bulk investigation](docs/translation-plan.md#translation-reliability-and-bulk-investigation)
records the separate economy option and continuity/output risks. The UI is exposed
for WEB source books; the underlying queue also validates stored imported chapters, but a translated
EPUB/TXT reader/export workflow is not added by this feature.

## Translation Styles

Sources contains only URLs; adding a URL does not fetch content. Existing provenance, private
source files, glossary proposals, and prior experiment runs remain in Supabase.

Under **Translation > Style Guide > Examples**, upload UTF-8 `.txt` chapters and select examples for inference. Files
are private, deduplicated by content hash, and persist across reloads. Uploads are limited to 1 MB
and 200,000 characters per file; an inference accepts up to 12 files totaling 48,000 characters.
Oversized selections are rejected, not truncated. These bounds are not a full-corpus analysis.

For downloaded English translations, select that book as context, then open **Downloaded English chapters**,
select chapters, and click **Use as style examples**. This saves private text snapshots with the
source host and chapter title in their names, without calling a model or altering the downloaded
chapters. Then select the examples and confirm **Infer style**. The resulting guide is saved and
selected automatically for this novel's future translations. **Style profile** can select it again
or reuse a saved guide on another book. One English chapter can establish an initial guide, but a
small sample is weak evidence for whole-novel style and cannot prove translation accuracy.

Inference creates a read-only profile with model/prompt metadata, input hashes, token usage,
and exact evidence quotes. It does not overwrite older profiles. Existing saved profiles remain
selectable; manual instruction editing is removed. Uploads work without a model key.

The server-only OpenAI adapter defaults to Luna. Live calls are off by default and require
`OPENAI_API_KEY`, `NOVELIST_ENABLE_LIVE_AI=true`, and a Vite restart. A live run requires explicit
confirmation and incurs OpenAI usage. Never put a model API key in a `VITE_` variable.
No live model request was made during automated development tests; provider calls are mocked,
not quality evaluations. Internal extraction tests remain available
without an Experiments screen.

Local APIs use the Vite plugin; hosted APIs use the standalone Node server.
The [consolidated project plan](docs/translation-plan.md) records the reader and UI decisions,
data model, and complete roadmap. A bounded scraper-code generation, test, and repair harness is
now implemented, along with per-book reference retrieval and single-chapter drafts. Live translation
quality evaluation, whole-book translated exports, large-corpus retrieval and the actual hosted
restore remain pending. Durable jobs and private hosting code are implemented. OpenAI remains the
initial translation provider; Qwen comparisons are experimental.

## Admin and Storage

**Settings > Admin & usage** shows recorded monthly estimates, unknown charges, provider quota
failures, model/request totals and open jobs. The optional monthly alert budget is a warning
threshold, not a provider-enforced spending cap. OpenAI billing is authoritative; the normal model
key does not supply a verified remaining-credit balance here. The ledger covers new translation,
guide, metadata and term-suggestion calls, including retries and token-truncated responses. Older
history and untracked tool/provider activity are not silently included as exact costs.

PostgreSQL already compresses large text/JSON with TOAST/pglz. A local comparison on61 translation
rows used2.61 MB with pglz versus2.83 MB with LZ4, so no extension was needed. New downloaded chapter
files use gzip when it saves at least10%; a30-chapter real-data sample saved57%. Existing files are
unchanged, both formats remain readable, and bounded decompression preserves original SHA-256 checks.

## Scraper Tool Experiment

The plugin-facing `generate_book_scraper` tool accepts captured HTML and URLs, writes a JavaScript
adapter through OpenAI, tests it in a network-disabled Docker container, and allows at most two
repairs. A typed capture helper and application client are included; the actual browser extension
and trusted pairing bridge are now available as a local Chrome/Edge side-panel extension. No
generated code runs in the web page or host Node process.

```sh
npm run scraper:setup
npm run scraper:experiment -- --fixture
RUN_SUPABASE_TESTS=1 npm run test:scraper
```

The fixture experiment uses a scripted generator and real isolated execution, not a live model.
It saved a two-attempt result with two training and three held-out checks passing. Live generation
requires `OPENAI_API_KEY`, `NOVELIST_ENABLE_LIVE_AI=true`, and explicit spend confirmation.
The [scraper experiment guide](docs/scraper-experiment.md) covers the API, plugin boundary, captured
page privacy, local artifacts, budgets, and remaining live-site validation. File details now span
the book content width; metadata editing remains in the main book actions, not beside the synopsis.

## Browser Extension

Build with `npm run build:extension`, then load the project's `dist-extension` folder with
**Load unpacked** on Chrome/Edge's extensions page. Pin **Novelist Page Reader** in the toolbar.
Keep the local Novelist app and Docker running. The extension connects automatically to the configured
localhost app without an approval screen, using a temporary inactive tab that closes after the
handshake. It reuses this browser's library session; the OpenAI key stays on the local server.
Disconnect pauses auto-connect until you choose Connect to Novelist again. Paid actions still require
their separate confirmations.

On a novel page: click the extension icon, review the local capture, choose **Analyze page**,
then **Scan & save chapters**. This opens the contents, expands clear controls, follows contents
pagination and saves the novel's link inventory to Novelist, without model calls or chapter-body
downloads. Search the full list, select **Chapter**, then **Download chapter** to save rendered text
to the paired source. The adjacent tooltip-labeled extraction-test icon tests without saving text.
An index-only extraction cannot pass a chapter test.
There is one Open in Novelist link; analysis settings, references and reports are collapsible.

**Bulk downloads** in the extension offers **Download all** and an inclusive **Download range**
for the current paired source. Both use the full unique chapter list, not the search-filtered subset.
All means all indexed links, up to the existing 20,000-link inventory limit; scan the contents first
and check any partial-list warning. Downloads run sequentially through the source tab, skip already
stored chapter URLs, and show saved/skipped counts. **Pause downloads** keeps completed work;
**Resume downloads** continues from the checkpoint. Model generation/repair pauses for consent on
the current chapter only. Keep the source tab, local app and Docker running. Panel/worker restarts
retain the queue in the browser session; a full browser/extension restart may require starting the
range again, with stored chapters skipped. This is not a durable unattended crawl service.

URLs are normalized and deduplicated in the extension picker, before inventory save requests, and
again during server inventory processing. Ordinary page fragments do not create duplicate chapters;
distinct query parameters and SPA routes remain distinct. Chapter titles are not used as identity,
and different sources keep their own downloaded records.

**Output language** defaults to English; the page's source language is detected automatically and
stored separately. Initial identification returns translated metadata, multiple synopses, cover URLs
and extra fields without an evidence-quote requirement. Results and raw extraction JSON persist in
Supabase's `page_identifications` table and can be downloaded from the extension. Identification uses
`OPENAI_IDENTIFICATION_MODEL=gpt-5-nano` by default; the scraper model remains separately configurable.
**Estimate costs** provides a local token estimate and per-model comparison; completed calls show
cost estimates from reported usage. HTML character counts are not prices.

The [browser extension guide](docs/browser-extension.md) explains installation, the exact workflow,
privacy, API usage and limitations. Run `npm run test:extension` for installed-Chromium checks
with mocked AI and public-page responses, without spending API credits.

The extension also offers a saved analysis-model default with per-run overrides, found/reported
chapter counts and normalized reading order, **Pair version** for translated-edition URLs, and an
optional **Save metadata only** action under Sources & references. Saved
`WEB` entries show metadata, external chapter links and translated versions in the library without
pretending chapter files have been downloaded. The saved-metadata pencil explicitly replaces metadata;
re-adding alone does not overwrite it. Pairing supplies URL context, not the translation text itself.

The scanner uses observed controls for ascending order, expansion and pagination, with at most
40 actions/four minutes and no model planning. Links transfer in batches of 500, bounded at 20,000
links / 1.5 million label-and-URL characters. Partial and no-progress lists are flagged.
Successful navigation controls are saved per site and reused across novels in this library. The
scanner matches normalized labels/roles against currently observed controls, not saved book URLs;
a failed cached action falls back to discovery. No additional model request is needed for reuse.
When the identified contents URL is missing, it follows a visible complete-contents link from the
landing page before expansion. The installed regression covers that two-action path to all 754 links.
The no-model browser check on 101kks book 11508 found 36 initial links and 754 distinct chapter URLs
after the site's expand-all control, collected in two batches. It did not fetch chapter bodies.

**Sources** in the main app lists saved source and edition URLs. The extension's **Your library** tab
offers search, already-linked indicators and local title/alias suggestions. Optional **Compare across
languages** sends bounded metadata and synopses for up to 60 books in one explicitly confirmed model
request. **Pair** attaches the current identified page to a reviewed existing novel without creating
another book or altering reading progress. Matching is advisory; nothing is merged automatically.
Reopening an exact saved source/contents URL recognizes its existing novel without another AI call.
Contents scans save back to that source, and original-source scans update the WEB book's contents list.
Shorter partial scans retain the longer saved inventory. Duplicate WEB source inserts are rejected;
no existing books are merged or removed. Novel Updates has an **Attach catalog to existing novel**
action leading to the reviewed library picker.
Apply the latest local migration with `npx supabase migration up --local`, rebuild the extension,
reload it in Chrome/Edge, and reopen the panel. It reconnects automatically after a server restart.

Novel Updates series pages can be kept as captured **Metadata references** and explicitly included
when analyzing another source page. Aliases, original/English publishers and publication details are
retained for review and matching; saving or pairing records the catalog URL separately from translated
editions. Release/group links are useful navigation metadata, not a chapter list. The browser capture
uses the series-content block to keep reviews and page chrome out of the 80,000-character limit.
The supplied Novel Updates entry was captured successfully at 20,273 characters without a paid model
call. See the [metadata workflow](docs/browser-extension.md#novel-updates-metadata) for instructions.

Chapter extraction tests reuse a saved site scraper before generating another. Passing adapters are
stored per library, exact origin and page type, and rerun in Docker on each new page. A cache hit makes
no OpenAI call, even with live AI off. A failed adapter becomes repair context within the existing
three-call limit. Prior successful local reports can seed the cache; no downloaded-code upload is needed.
Migration `202609100011_site_scrapers.sql` adds the owner-isolated adapter cache.
