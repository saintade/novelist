# Novelist

A personal reading library built with React, TypeScript, Vite, and local Supabase.
This first version focuses on importing books and reading comfortably on desktop and phones.
It is not a public book-discovery website.

## Run Locally

Requires Node.js 22.12+ and Docker Desktop running. The Supabase CLI is a project dependency.

```sh
npm install
npm run db:start
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
- Phone-sized touch targets, safe-area spacing, compact toolbar, and settings sheet.
- Three real public-domain sample EPUBs with [source attribution](public/books/SOURCES.md).

## Storage and Privacy

There is no sign-in screen. Supabase silently creates an anonymous authenticated session so
row-level policies can isolate the library. Retain that browser session to access its books.
Clearing browser data or using another browser creates a different library; cross-device access
will require linking the anonymous session to a durable account later.

Postgres stores books, chapter metadata, reading progress, bookmarks, and sample-import state.
The private `library` bucket stores originals, covers, and one JSON object per chapter.
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
    Reader.tsx          Reading workflow and chapter view
    ui.tsx              Shared accessible UI primitives
  pages/                Library, book details, bookmarks, reader routes
  lib/
    books.ts            EPUB/TXT normalization and content sanitization
    library/            Supabase repository, sample import, presentation helpers
    reader/             Chapter rendering, reader settings, recovery checkpoints
    supabase/           Client and generated database types
    preferences.ts      Browser preference persistence
    format.ts           Display formatting
  styles/               Global tokens, library, and reader styles
supabase/migrations/    SQL schema and access policies
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
serialized updates, deletion, and denial of cross-session access. Browser tests use isolated
sessions and remove their own books afterward. They cover reading, reloads, bookmarks, themes,
search, a 105-chapter import, failed-save recovery, and phone overflow. Run them locally.
Screenshots and failure traces are written to the ignored `test-results` directory.

Run `npm run db:types` after schema changes and `npm run format` to format the frontend.
The XML-parser override patches the old transitive dependency used by epub.js.

## Deployment and Limits

Deploy with an SPA fallback to `index.html`, HTTPS, and a reachable hosted Supabase URL/public
key. Apply the migrations and configure Auth for the deployment. Link the anonymous library
to a recoverable identity before relying on it across devices. `127.0.0.1` on a phone points
to that phone, not this development machine. Phone layouts are browser-emulation tested,
not tested on physical devices.

Imports support unencrypted reflowable EPUBs and plain text, up to 50 MB per file. Complex
fixed layouts, DRM, PDF, and cross-chapter EPUB footnote navigation are not supported.
Imported HTML is sanitized; remote embedded images and scripts are not executed. This is a
personal-use prototype, not an untrusted public-upload service.

Translation jobs, scraper generation, source alignment, glossaries, and translation-quality
evaluations remain future work. Translation will start with OpenAI; open-weight Qwen comparisons
stay experimental. No model API calls or API spending are enabled in this build.
