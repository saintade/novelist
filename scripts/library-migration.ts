import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { parseArgs, parseEnv } from 'node:util'
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'
import { createClient } from '@supabase/supabase-js'
import pLimit from 'p-limit'
import { z } from 'zod'
import { compareLibraryManifests, createLibraryManifest, libraryManifestSchema } from './library-manifest.ts'

type Manifest = z.infer<typeof libraryManifestSchema>
type MigrationTable = {
  name: string
  columns: string[]
  keys: string[]
  parents: string[]
  definition: unknown
}

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`
const fingerprint = (values: string[]) => createHash('sha256').update(values.map(value => value + '\n').join('')).digest('hex')
const fileHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

export async function readMigrationTables(database: Client): Promise<MigrationTable[]> {
  const result = await database.query<MigrationTable>(`
    select relation.relname as name,
      array(select attribute.attname::text from pg_attribute attribute
        where attribute.attrelid=relation.oid and attribute.attnum>0 and not attribute.attisdropped and attribute.attgenerated=''
        order by attribute.attnum) as columns,
      array(select attribute.attname::text from pg_index primary_index
        cross join lateral unnest(primary_index.indkey) with ordinality as key_number(number,position)
        join pg_attribute attribute on attribute.attrelid=relation.oid and attribute.attnum=key_number.number
        where primary_index.indrelid=relation.oid and primary_index.indisprimary order by key_number.position) as keys,
      array(select distinct parent.relname::text from pg_constraint constraint_row
        join pg_class parent on parent.oid=constraint_row.confrelid
        where constraint_row.conrelid=relation.oid and constraint_row.contype='f'
          and parent.relnamespace=relation.relnamespace and parent.oid<>relation.oid order by parent.relname::text) as parents,
      (select jsonb_agg(jsonb_build_array(attribute.attname,format_type(attribute.atttypid,attribute.atttypmod),
          attribute.attnotnull,attribute.attgenerated,attribute.attidentity,pg_get_expr(default_value.adbin,default_value.adrelid)) order by attribute.attnum)
        from pg_attribute attribute left join pg_attrdef default_value on default_value.adrelid=relation.oid and default_value.adnum=attribute.attnum
        where attribute.attrelid=relation.oid and attribute.attnum>0 and not attribute.attisdropped) as definition
    from pg_class relation join pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='public' and relation.relkind='r'
      and exists(select 1 from pg_attribute where attrelid=relation.oid and attname='owner_id' and not attisdropped)
    order by relation.relname`)
  const ordered: MigrationTable[] = []
  const pending = new Map(result.rows.map(table => [table.name, table]))
  while (pending.size) {
    const next = [...pending.values()].find(table => table.parents.every(parent => ordered.some(candidate => candidate.name === parent)))
    if (!next || !next.keys.length) throw new Error('The application schema has an unsupported dependency or primary key.')
    ordered.push(next)
    pending.delete(next.name)
  }
  return ordered
}

export async function restoreLibraryRows(database: Client, tables: MigrationTable[], manifest: Manifest, rows: Map<string, string[]>) {
  libraryManifestSchema.parse(manifest)
  if (JSON.stringify([...rows.keys()].sort()) !== JSON.stringify(tables.map(table => table.name).sort()) ||
      JSON.stringify(Object.keys(manifest.tables).sort()) !== JSON.stringify([...rows.keys()].sort()))
    throw new Error('Snapshot tables do not match the destination schema.')
  for (const table of tables) {
    const values = rows.get(table.name)!
    if (values.length !== manifest.tables[table.name].count || fingerprint(values) !== manifest.tables[table.name].rowsHash ||
        values.some(value => JSON.parse(value).owner_id !== manifest.ownerId))
      throw new Error(`Snapshot integrity failed for ${table.name}.`)
  }
  await database.query('savepoint novelist_owner_restore')
  await database.query("set local lock_timeout = '5s'")
  await database.query(`lock table ${tables.map(table => `public.${identifier(table.name)}`).join(',')} in share row exclusive mode`)
  for (const table of tables) {
    const existing = await database.query(`select 1 from public.${identifier(table.name)} where owner_id=$1 limit 1`, [manifest.ownerId])
    if (existing.rowCount) throw new Error(`Destination ${table.name} already contains owner data. Nothing will be overwritten.`)
    const disabled = await database.query("select 1 from pg_trigger where tgrelid=$1::regclass and not tgisinternal and tgenabled<>'O' limit 1", [`public.${identifier(table.name)}`])
    if (disabled.rowCount) throw new Error(`Destination ${table.name} has nonstandard trigger settings.`)
  }
  for (const table of tables) await database.query(`alter table public.${identifier(table.name)} disable trigger user`)
  for (const table of tables) {
    const values = rows.get(table.name)!
    const columns = table.columns.map(identifier).join(',')
    for (let offset = 0; offset < values.length; offset += 100) {
      await database.query(
        `insert into public.${identifier(table.name)} (${columns}) overriding system value select ${columns} from jsonb_populate_recordset(null::public.${identifier(table.name)},$1::jsonb)`,
        [`[${values.slice(offset, offset + 100).join(',')}]`],
      )
    }
  }
  for (const table of tables) await database.query(`alter table public.${identifier(table.name)} enable trigger user`)
  for (const table of tables) {
    const restored = await database.query<{ body: string; identity: string }>(
      `select to_jsonb(record)::text as body,jsonb_build_array(${table.keys.map(key => `record.${identifier(key)}`).join(',')})::text as identity from public.${identifier(table.name)} record where owner_id=$1 order by ${table.keys.map(identifier).join(',')}`,
      [manifest.ownerId],
    )
    const expected = manifest.tables[table.name]
    if (restored.rowCount !== expected.count || fingerprint(restored.rows.map(row => row.body)) !== expected.rowsHash ||
        fingerprint(restored.rows.map(row => row.identity)) !== expected.idsHash)
      throw new Error(`Restored row fingerprints do not match for ${table.name}.`)
  }
  await database.query('release savepoint novelist_owner_restore')
}

function cli(args: string[]) {
  return execFileSync('npx', ['supabase', ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

let stage = 'configuration'

async function main() {
  const { values } = parseArgs({ options: {
    'project-ref': { type: 'string' }, owner: { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('node --experimental-strip-types scripts/library-migration.ts --project-ref PROJECT --owner UUID [--apply]\nWithout --apply: capture a private backup and rehearse the SQL restore with rollback. With --apply: copy and verify private files, restore the empty owner library atomically, and verify the destination. Uses the signed-in Supabase CLI; credentials are never written or printed. Local data and Auth are not changed.')
    return
  }
  const project = z.string().regex(/^[a-z]{20}$/).parse(values['project-ref'])
  const owner = z.string().uuid().parse(values.owner)
  if ((await readFile('supabase/.temp/project-ref', 'utf8')).trim() !== project)
    throw new Error('The destination must match the linked project.')
  const local = JSON.parse(cli(['status', '--output', 'json']))
  if (new URL(local.DB_URL).hostname !== '127.0.0.1' || new URL(local.API_URL).hostname !== '127.0.0.1')
    throw new Error('The source must be the local Supabase project.')
  const certificateResponse = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt')
  if (!certificateResponse.ok) throw new Error('The official database CA certificate is unavailable.')
  const certificate = await certificateResponse.text()
  if (!new X509Certificate(certificate).ca) throw new Error('Invalid database CA certificate.')
  const connection = parseEnv(cli(['db', 'dump', '--linked', '--dry-run', '--data-only', '--schema', 'public']))
  if (!connection.PGHOST?.endsWith('.supabase.com') && !connection.PGHOST?.endsWith('.supabase.co'))
    throw new Error('Unexpected destination database host.')
  if (!connection.PGUSER || !connection.PGPASSWORD) throw new Error('CLI database credentials are unavailable.')
  const keys = JSON.parse(cli(['projects', 'api-keys', '--project-ref', project, '--output', 'json'])) as { name: string; api_key: string }[]
  const targetKey = keys.find(key => key.name === 'service_role')?.api_key
  if (!targetKey) throw new Error('The destination administrative Storage key is unavailable.')
  const source = new Client({ connectionString: local.DB_URL, application_name: 'novelist-migration-source', connectionTimeoutMillis: 15000 })
  const target = new Client({ host: connection.PGHOST, port: Number(connection.PGPORT || 5432), user: connection.PGUSER,
    password: connection.PGPASSWORD, database: connection.PGDATABASE || 'postgres', ssl: { ca: certificate, rejectUnauthorized: true },
    application_name: 'novelist-migration-target', connectionTimeoutMillis: 15000 })
  const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const sourceStorage = createClient(local.API_URL, local.SERVICE_ROLE_KEY, clientOptions)
  const targetStorage = createClient(`https://${project}.supabase.co`, targetKey, clientOptions)
  try {
    stage = 'preflight'
    await source.connect()
    await target.connect()
    await target.query('set role postgres')
    await source.query("set timezone = 'UTC'")
    await target.query("set timezone = 'UTC'")
    const account = await target.query('select id,is_anonymous,email_confirmed_at is not null as verified from auth.users where id=$1', [owner])
    if (!account.rows[0]?.verified || account.rows[0].is_anonymous) throw new Error('The destination owner must have a verified permanent account.')
    const access = await target.query('select user_id from novelist_private.access_owner where singleton')
    if (access.rows[0]?.user_id !== owner) throw new Error('The destination library must be restricted to the exact migrating owner.')
    const bucket = await target.query('select public from storage.buckets where id=$1', ['library'])
    if (bucket.rows[0]?.public !== false) throw new Error('The destination library bucket must be private.')
    const active = await source.query("select 1 from public.translation_batches where owner_id=$1 and (state in ('running','pending','pausing','cancelling') or lease_expires_at>now()) limit 1", [owner])
    if (active.rowCount) throw new Error('Pause local translation work and finish active requests before migration.')
    const tables = await readMigrationTables(source)
    if (JSON.stringify(tables) !== JSON.stringify(await readMigrationTables(target))) throw new Error('Source and destination application schemas differ.')
    for (const table of tables)
      if ((await target.query(`select 1 from public.${identifier(table.name)} limit 1`)).rowCount)
        throw new Error('This first transfer requires an empty destination application schema.')
    stage = 'source-snapshot'
    const rows = new Map<string, string[]>()
    const objects = new Map<string, Buffer>()
    const manifest = await createLibraryManifest(source, sourceStorage, owner, {
      rows: async (table, values) => { rows.set(table, [...(rows.get(table) ?? []), ...values]) },
      object: async (path, bytes) => { objects.set(path, bytes); if (objects.size % 100 === 0) console.log(`Captured ${objects.size} private files.`) },
    })
    const migrations = (await target.query<{ version: string }>('select version from supabase_migrations.schema_migrations order by version')).rows.map(row => row.version)
    if (JSON.stringify(manifest.migrations) !== JSON.stringify(migrations)) throw new Error('Migration histories do not match.')
    const directory = resolve(`.novelist/backups/hosted-transfer-${new Date().toISOString().replaceAll(':', '-')}`)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(resolve(directory, 'source-snapshot.json'), JSON.stringify({ manifest, tables, rows: Object.fromEntries(rows) }), { flag: 'wx', mode: 0o600 })
    for (const [path, bytes] of objects) {
      const output = resolve(directory, 'objects', path)
      if (!path.startsWith(`${owner}/`) || !output.startsWith(resolve(directory, 'objects', owner) + sep)) throw new Error('Unexpected source Storage path.')
      await mkdir(dirname(output), { recursive: true, mode: 0o700 })
      await writeFile(output, bytes, { flag: 'wx', mode: 0o600 })
    }
    console.log(`Private snapshot: ${directory}; ${tables.length} tables and ${objects.size} files.`)
    if (values.apply) {
      stage = 'private-file-copy'
      const listed = await target.query<{ name: string }>('select name from storage.objects where bucket_id=$1', ['library'])
      const existing = new Set(listed.rows.map(row => row.name))
      if ([...existing].some(path => !objects.has(path))) throw new Error('Unexpected destination files require review; none will be overwritten.')
      const slots = pLimit(3)
      let verified = 0
      let copyFailed = false
      const transfers = await Promise.allSettled(manifest.objects.map(object => slots(async () => {
        if (copyFailed) return
        try {
          if (!existing.has(object.path)) {
            const uploaded = await targetStorage.storage.from('library').upload(object.path, objects.get(object.path)!, { contentType: object.contentType, upsert: false })
            if (uploaded.error) throw new Error('A private object upload failed. Existing files were not overwritten.')
          }
          const downloaded = await targetStorage.storage.from('library').download(object.path)
          if (downloaded.error || !downloaded.data) throw new Error('A destination object could not be verified.')
          const bytes = Buffer.from(await downloaded.data.arrayBuffer())
          if (bytes.length !== object.bytes || fileHash(bytes) !== object.sha256) throw new Error('Destination object bytes do not match the snapshot.')
          verified += 1
          if (verified % 100 === 0 || verified === manifest.objects.length) console.log(`Verified ${verified}/${manifest.objects.length} hosted private files.`)
        } catch (failure) {
          copyFailed = true
          throw failure
        }
      })))
      const failure = transfers.find(transfer => transfer.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    }
    stage = 'source-consistency'
    const current = await createLibraryManifest(source, sourceStorage, owner)
    if (compareLibraryManifests(manifest, current).length) throw new Error('The local library changed during transfer. Keep it idle and create a fresh snapshot.')
    stage = values.apply ? 'atomic-row-restore' : 'rollback-rehearsal'
    await target.query('begin')
    await restoreLibraryRows(target, tables, manifest, rows)
    await target.query(values.apply ? 'commit' : 'rollback')
    if (!values.apply) {
      console.log('Restore rehearsal passed with exact row hashes and active foreign keys. All destination row changes were rolled back; no hosted files were uploaded.')
      return
    }
    stage = 'destination-verification'
    let verifiedFiles = 0
    const restored = await createLibraryManifest(target, targetStorage, owner, {
      object: async () => { verifiedFiles += 1; if (verifiedFiles % 100 === 0) console.log(`Rechecked ${verifiedFiles} destination files.`) },
    })
    const differences = compareLibraryManifests(manifest, restored).filter(difference => difference !== 'Auth identity differs')
    if (differences.length || !restored.auth.permanent || !restored.auth.emailVerified || restored.auth.userId !== manifest.auth.userId)
      throw new Error('Destination verification did not match; the original local library remains intact.')
    await writeFile(resolve(directory, 'target-manifest.json'), JSON.stringify(restored, null, 2), { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ migrated: true, ownerId: owner, tables: tables.length, books: restored.tables.books.count,
      chapterTranslations: rows.get('book_translation_previews')!.filter(row => JSON.parse(row).kind === 'chapter').length, privateFiles: restored.objects.length,
      rowsAndFileHashesMatch: true, localLibraryUnchanged: true, backupDirectory: directory }, null, 2))
  } finally {
    await target.query('rollback').catch(() => undefined)
    await target.end().catch(() => undefined)
    await source.end().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main().catch(failure => {
    console.error(JSON.stringify({ message: 'Library migration stopped. Local data was not removed; existing destination data was not overwritten.', stage,
      code: typeof failure?.code === 'string' && /^[A-Z0-9_]+$/.test(failure.code) ? failure.code : undefined }))
    process.exitCode = 1
  })