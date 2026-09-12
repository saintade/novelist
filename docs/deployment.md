# Private Hosted Novelist

Status: Supabase CLI is authenticated and linked to `klkjphqfzzbcecksdwtw`. All54 application
migrations through202609110042 are deployed to the initially empty hosted PostgreSQL17 project in
us-east-1. Table RLS and the private bucket were verified after deployment. A permanent hosted owner
was provisioned with the preserved UUID and chosen email, without a password or verified-email flag.
Email verification, application-data/file transfer, GitHub push and Render deployment remain pending.
See [note.txt](../note.txt) for exact settings and current enrollment instructions.

A private local rehearsal backup contains a readable PostgreSQL archive,30 owner-table fingerprints
and874 SHA-256-verified files. It is not the final consistent cutover snapshot. Local Auth and the
running library on port5173 were not switched, stopped or reset. Port5174 is a separate hosted-account
verification preview with AI disabled; the library remains gated until owner activation.

## Recommended Architecture

- Supabase Cloud: PostgreSQL, Auth and the existing private `library` bucket.
- A Node web service on Render Free: serve the built React app and the
  authenticated translation/guide/term APIs under one HTTPS origin. The service must allow
  requests longer than two minutes or use a durable job worker before launch.
- Mac ingestion: keep the extension and its localhost bridge/Docker scraper on the Mac. Point
  that local app at hosted Supabase and sign into the same account as the phone. Source captures
  and downloads then appear in the phone library without a second database to synchronize.
- Phone: hosted library/reader, saved translations and reading positions from Supabase; new
  translations and term suggestions through the hosted Node API. Browser scraping stays on Mac.

An alternative is a private VPS with Node and Docker plus hosted Supabase, but it introduces
server maintenance that is unnecessary for a reader-first phone deployment.

## Implemented Preparation

- `npm start` runs `server/index.ts` directly under Node24. It serves only `dist`, supports nested
   reader routes, applies security headers and exposes `/health`. Source files and extension bridge
   routes are not served. The API checks the exact configured HTTPS Host and Origin.
- Hosted operations validate a permanent Supabase user and `NOVELIST_ALLOWED_USER_ID`, then use
   that user's JWT with RLS. The app server needs no Supabase secret/service-role key.
- Private sign-in supports passwords, built-in email links and optional email OTP for existing accounts, not public registration.
   An activated database owner restriction is required before the library mounts. Refresh retains
   the reader; sign-out/account changes clear access. Hosted mode never silently seeds a new library.
- Localhost with local Supabase keeps anonymous development. Remote Supabase or a non-localhost app
   requires private sign-in. Use `VITE_AUTH_MODE=private` explicitly in hosted and Mac ingestion builds.
- Settings > Library account supports email linking and password setup. For this deployment, the
   hosted owner was provisioned separately with the exact source UUID, leaving local anonymous Auth
   untouched. Its email must still be verified before owner restriction activation and password setup.
- Migration033 adds inactive-local restrictive policies and an administrator-only activation RPC;
   later new tables also carry the restriction. Production startup refuses an unrestricted database.
- Durable regular/grouped workers support automatic retries, separate reader jobs, paused intent,
   phase leases and guarded commits. Shutdown drains active requests/workers for up to240seconds.
   Ordinary Vite reloads retain worker state; a server interruption can recover on authenticated
   reconnect within3 total chapter attempts. Quota/access/source errors and exhausted attempts stop.
- `render.yaml` selects a single Free service and manual deploys. It does not create Supabase,
   run migrations or copy data. Confirm region and quotas before provisioning. Free Render sleeps
   after15idle minutes and can restart at any time, so it is not an always-on unattended scheduler.

Keep the extension bridge localhost-only. Preserve migration history: some older migrations
materialize source books, so blindly replaying migrations over restored data can mutate it.

## Production Configuration

Build: `npm ci --include=dev && npm run build`. Start: `npm start`. Set `NODE_ENV=production`,
`VITE_AUTH_MODE=private`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
`NOVELIST_ALLOWED_USER_ID` and `NOVELIST_PUBLIC_ORIGIN`. The origin must be exact HTTPS with no
path. Render supplies `PORT`. Rebuild when `VITE_` variables change. Never use a secret/service-role
key as the browser key. Keep live AI off until access and restore checks pass; then configure the
server-only OpenAI key and `NOVELIST_ENABLE_LIVE_AI=true`. Model usage is billed separately.

On the migrated hosted database only, as administrator:

```sql
select public.configure_private_library('28fd9dab-36c4-46b4-a96a-53583f44ff50'::uuid);
select public.library_access_status();
```

The owner must already be permanent and email-verified. `restricted` must be true; `allowed: false`
is normal for an administrator without a user JWT. Configure that same UUID on the server. Do not
activate this on the local development database. Re-run activation after future table migrations.

## Only Your Account

- The permanent hosted owner uses the actual Chrome library's UUID. Verify the chosen email before
   activation and password setup; do not mark it verified administratively. The shared VS Code
   browser's anonymous test library must not be selected for migration.
- Hosted public and anonymous sign-ups are disabled, and minimum password length is12. Local
   development Auth is unchanged. Hosted changes used an isolated minimal config under `.novelist`;
   never push the local development config to the linked production project without reviewing its diff.
- Supabase Free with the default email provider rejected custom email-template changes. Use its
   built-in sign-in links; the app supplies an exact callback origin and handles PKCE verification.
   Custom code-only templates require custom SMTP or a paid plan. The code-entry fallback is still
   available if an email includes a code. Hosted OTP expiry is15minutes; actual delivery/verification
   remains to be tested by the owner. No account email was sent by the assistant's automated tests.
- Temporary Site URL and redirect are `http://127.0.0.1:5174`. Replace Site URL with the final Render
   HTTPS origin and add the intended Mac ingestion callback before launch. Open the verification email
   in the same browser that requested it. Rotate the exposed secret key before uploading private data.
- Retain all existing owner RLS, composite owner foreign keys, private bucket policies and
   security-invoker functions. Activate the shipped restrictive owner allowlist policy on all
  application tables and private Storage objects as defense in depth. Test it with a second
  authenticated account as well as an unauthenticated client.
- Keep the service-role key and OpenAI key server-side. The browser's publishable key is not a
  secret or an authorization boundary. No service-role key goes in `VITE_` configuration or the
  extension. The hosted API should continue using the user's JWT for RLS-bound database work.
- Use HTTPS, exact redirect/origin allowlists, secure Auth settings and optional MFA. A private
  access proxy can hide even the sign-in screen, but must cover API routes too; it does not
  replace Supabase RLS or protect the database's separate API endpoint on its own.

## Preserve the Local Library

Do not run a reset or switch `.env.local` to an empty hosted database before completing these
steps. Do not delete the local volumes or any local Auth owner.

1. Choose the hosted project/region, app host and HTTPS domain. Prefer a fresh rehearsal project
   with the same PostgreSQL major version. Verify required extensions and Auth/Storage schema
   compatibility instead of restoring managed schemas over incompatible service versions.
2. Record the actual owner UUID and a migration manifest: every table's row count and stable-ID
   hash, all source inventories, original/translated progress, folders, glossary decisions,
   guide/translation versions, per-book model preferences, and every referenced Storage path,
   byte length and SHA-256. Search indexes are derivable but can be preserved if compatible.
3. Back up roles/application schema/data, required Auth users and identities, and
   `supabase_migrations` history with the Supabase CLI/PostgreSQL tools. Custom Auth/Storage
   policies need separate attention. A SQL backup contains Storage metadata, not the file bytes.
4. Copy every referenced object in the private `library` bucket separately, retaining the exact
   bucket/path and content type. Paginate listings beyond 1,000 entries. Verify byte hashes at
   the destination; do not overwrite a different target object silently. Record failures and
   resume by verified manifest entry. Administrative copy tools need server-only credentials.
5. Rehearse the restore with the existing Auth UUID preserved. Restore compatible Auth data and
   application data in the reviewed order; avoid running data-transformation triggers a second
   time. Test recovery of the permanent identity with a new hosted login. Old local JWTs are not
   portable hosted credentials even when their user ID is preserved.
   For this deployment, the email identity was provisioned through Auth instead of copying the
   anonymous Auth record. Account type, confirmation state and email identity IDs will differ by
   design; verify those changes separately while preserving all application rows and object paths.
6. Compare the manifest and validate all chapter downloads, translation versions, guide coverage,
   glossary selections, folders and progress. Open representative original/translated chapters
   on the phone and confirm the exact chapter, language, version and scroll position.
7. Test denial: anonymous caller, wrong authenticated user, forged book/source IDs, cross-origin
   AI calls, public Storage access and direct RPC calls must not expose or modify the library.
8. For final cutover only, pause user downloads/translations, take a consistent final snapshot
   and copy/verify the delta. Run the manifest comparison again before switching clients. No
   active downloads have been stopped as part of this investigation.
9. Switch hosted frontend/API and Mac ingestion to the same hosted project. Keep local backups
   and the original volumes until restore and rollback have been demonstrated. New production
   writes should have one authoritative database, not unsynchronized local/cloud copies.

## Read-Only Manifest

Use `npm run migration:manifest -- --help`. Provide `NOVELIST_MANIFEST_DATABASE_URL`,
`NOVELIST_MANIFEST_SUPABASE_URL`, `NOVELIST_MANIFEST_STORAGE_KEY` and `NOVELIST_MANIFEST_OWNER_ID`
directly in the terminal environment or ignored env files, never in chat or `VITE_` configuration.
Use a direct/session-mode PostgreSQL connection with verified TLS for cloud targets.

```sh
npm run migration:manifest -- --output .novelist/source-manifest.json
npm run migration:manifest -- --output .novelist/target-manifest.json
npm run migration:manifest -- --compare .novelist/source-manifest.json .novelist/target-manifest.json
```

Capture with the respective source/target environments. The tool takes a repeatable-read, read-only
SQL snapshot, fingerprints owner-scoped rows in primary-key order, records Auth/migration IDs and
hashes every actual private file under the owner's prefix. Missing references fail; private output
files are never overwritten. The tool does not restore Auth, copy data or move Storage bytes.
SQL and Storage cannot be snapshotted atomically together: compare in an approved quiet window
before test reads/logins change rows. Policies, password hashes and managed versions need separate
restore checks. A matching manifest alone is not a migration certification.

## Deployment Checks

- Production frontend loads directly at nested reader URLs with SPA fallback.
- All secrets stay out of the built assets, logs and browser requests.
- Translation errors remain actionable; incomplete output never publishes a partial chapter.
- Native startup/shutdown, retry limits, lease recovery, real permanent owner/outsider API checks
   and restrictive table/Storage denial pass locally. Recheck them on the actual host. Retries are
   user-authorized at job start and may incur another charge if a completed provider response was
   lost before commit. Completed database results are retained and skipped, not regenerated.
- Admin & usage shows recorded requests, quota errors and optional monthly alert thresholds.
   These are not remaining provider credit or hard spending caps. New translation/guide/metadata/term
   calls are tracked; historical and untracked activity require OpenAI's authoritative billing view.
- Private Storage download and upload, RLS RPCs, owner allowlisting, account recovery and phone
  login are tested against the hosted rehearsal project, not assumed from local tests.
- Configure hosted database backups and a separate object-storage backup. Database backups alone
  are not a full library backup.
- Confirm actual host/Supabase plan quotas and current prices before provisioning. Storage,
  egress, backups and an always-on Node process are separate from model charges.

## Inputs Still Needed for Live Deployment

Owner email verification, key-rotation confirmation, GitHub authorization, the app-host account/domain
and a reviewed data-transfer method. The Supabase project is linked and its schema is deployed.
Managed PostgreSQL does not grant this connection `SET session_replication_role`; do not assume a
superuser-style restore will work or bypass data-transformation triggers without a tested procedure.
Secrets should be entered directly into the terminal or hosting dashboards, not pasted into chat.
The production API/auth code is implemented. Verified account access, rehearsed data/file restoration
and physical-phone access remain launch gates.

## Official References

- [Supabase backup/restore and separate Storage migration](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [Convert an anonymous user to a permanent user](https://supabase.com/docs/guides/auth/auth-anonymous#convert-an-anonymous-user-to-a-permanent-user)
- [Disable new and anonymous sign-ups](https://supabase.com/docs/guides/auth/general-configuration)

Reviewed 2026-09-11. Managed Auth/Storage migration details must be checked again against the
actual target's versions before executing a restore.
