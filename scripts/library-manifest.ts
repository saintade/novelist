import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const tableManifest = z.object({
  count: z.number().int().nonnegative(),
  idsHash: digest,
  rowsHash: digest,
})
export const libraryManifestSchema = z.object({
  version: z.literal(1),
  ownerId: z.string().uuid(),
  capturedAt: z.iso.datetime(),
  tables: z.record(z.string(), tableManifest),
  migrations: z.array(z.string()),
  auth: z.object({
    userId: z.string().uuid(),
    permanent: z.boolean(),
    emailVerified: z.boolean(),
    identityIds: z.array(z.string()),
  }),
  objects: z.array(
    z.object({
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      sha256: digest,
      contentType: z.string(),
    }),
  ),
})

function identifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

export async function createLibraryManifest(
  database: Client,
  storage: SupabaseClient,
  ownerId: string,
) {
  z.string().uuid().parse(ownerId)
  const tables: Record<string, z.infer<typeof tableManifest>> = {}
  const references = new Set<string>()
  const objects: z.infer<typeof libraryManifestSchema>['objects'] = []
  await database.query('begin isolation level repeatable read read only')
  try {
    const owner = await database.query<{
      id: string
      is_anonymous: boolean
      email_confirmed_at: string | null
    }>('select id,is_anonymous,email_confirmed_at from auth.users where id=$1', [ownerId])
    if (!owner.rows[0]) throw new Error('The requested library owner does not exist.')
    const identities = await database.query<{ id: string }>(
      'select id from auth.identities where user_id=$1 order by id',
      [ownerId],
    )
    const migrations = await database.query<{ version: string }>(
      'select version from supabase_migrations.schema_migrations order by version',
    )
    const relations = await database.query<{ name: string; keys: string[] }>(`
      select relation.relname as name,
        array(select attribute.attname::text from pg_index primary_index
          cross join lateral unnest(primary_index.indkey) with ordinality as key_number(number,position)
          join pg_attribute attribute on attribute.attrelid=relation.oid and attribute.attnum=key_number.number
          where primary_index.indrelid=relation.oid and primary_index.indisprimary order by key_number.position) as keys
      from pg_class relation join pg_namespace namespace on namespace.oid=relation.relnamespace
      where namespace.nspname='public' and relation.relkind='r'
        and exists(select 1 from pg_attribute where attrelid=relation.oid and attname='owner_id' and not attisdropped)
      order by relation.relname`)
    for (const table of relations.rows) {
      if (!table.keys.length) throw new Error(`Missing primary key on ${table.name}.`)
      const ids = createHash('sha256')
      const rows = createHash('sha256')
      let count = 0
      await database.query(
        `declare manifest_rows no scroll cursor for select to_jsonb(record)::text as body,jsonb_build_array(${table.keys.map((key) => `record.${identifier(key)}`).join(',')})::text as identity from public.${identifier(table.name)} record where owner_id=$1 order by ${table.keys.map((key) => `record.${identifier(key)}`).join(',')}`,
        [ownerId],
      )
      for (;;) {
        const page = await database.query<{ body: string; identity: string }>(
          'fetch forward 200 from manifest_rows',
        )
        for (const row of page.rows) {
          count += 1
          ids.update(row.identity + '\n')
          rows.update(row.body + '\n')
          for (const [field, value] of Object.entries(JSON.parse(row.body)))
            if (field.endsWith('_path') && typeof value === 'string' && value) references.add(value)
        }
        if (page.rows.length < 200) break
      }
      await database.query('close manifest_rows')
      tables[table.name] = { count, idsHash: ids.digest('hex'), rowsHash: rows.digest('hex') }
    }
    await database.query(
      "declare manifest_objects no scroll cursor for select name,metadata from storage.objects where bucket_id='library' and starts_with(name,$1) order by name",
      [`${ownerId}/`],
    )
    for (;;) {
      const page = await database.query<{
        name: string
        metadata: { size?: number; mimetype?: string } | null
      }>('fetch forward 200 from manifest_objects')
      for (const object of page.rows) {
        const downloaded = await storage.storage.from('library').download(object.name)
        if (downloaded.error || !downloaded.data)
          throw new Error(`Could not read private object ${object.name}.`)
        const bytes = Buffer.from(await downloaded.data.arrayBuffer())
        if (object.metadata?.size !== undefined && Number(object.metadata.size) !== bytes.length)
          throw new Error(
            `Stored size changed for ${object.name}; create a new consistent snapshot.`,
          )
        objects.push({
          path: object.name,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          contentType:
            object.metadata?.mimetype || downloaded.data.type || 'application/octet-stream',
        })
        references.delete(object.name)
      }
      if (page.rows.length < 200) break
    }
    await database.query('close manifest_objects')
    if (references.size)
      throw new Error(
        `${references.size} referenced private files were not present under this owner's Storage prefix.`,
      )
    await database.query('commit')
    return libraryManifestSchema.parse({
      version: 1,
      ownerId,
      capturedAt: new Date().toISOString(),
      tables,
      migrations: migrations.rows.map((row) => row.version),
      auth: {
        userId: owner.rows[0].id,
        permanent: !owner.rows[0].is_anonymous,
        emailVerified: Boolean(owner.rows[0].email_confirmed_at),
        identityIds: identities.rows.map((row) => row.id),
      },
      objects,
    })
  } catch (failure) {
    await database.query('rollback')
    throw failure
  }
}

export function compareLibraryManifests(sourceValue: unknown, targetValue: unknown): string[] {
  const source = libraryManifestSchema.parse(sourceValue)
  const target = libraryManifestSchema.parse(targetValue)
  const differences: string[] = []
  if (source.ownerId !== target.ownerId) differences.push('Library owner changed')
  if (JSON.stringify(source.auth) !== JSON.stringify(target.auth))
    differences.push('Auth identity differs')
  if (JSON.stringify(source.migrations) !== JSON.stringify(target.migrations))
    differences.push('Migration history differs')
  for (const name of new Set([...Object.keys(source.tables), ...Object.keys(target.tables)]))
    if (JSON.stringify(source.tables[name]) !== JSON.stringify(target.tables[name]))
      differences.push(`Table differs: ${name}`)
  const targetObjects = new Map(target.objects.map((object) => [object.path, object]))
  for (const object of source.objects) {
    if (JSON.stringify(object) !== JSON.stringify(targetObjects.get(object.path)))
      differences.push(`Storage object differs: ${object.path}`)
    targetObjects.delete(object.path)
  }
  for (const path of targetObjects.keys()) differences.push(`Unexpected target object: ${path}`)
  return differences
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Read-only library manifest: npm run migration:manifest -- --output .novelist/source-manifest.json\nCompare: npm run migration:manifest -- --compare .novelist/source-manifest.json .novelist/target-manifest.json\nRequired environment: NOVELIST_MANIFEST_DATABASE_URL, NOVELIST_MANIFEST_SUPABASE_URL, NOVELIST_MANIFEST_STORAGE_KEY, NOVELIST_MANIFEST_OWNER_ID. Enter credentials directly in the terminal or an ignored env file. Never use VITE_ variables for administrative credentials.',
    )
    return
  }
  if (args.length === 3 && args[0] === '--compare') {
    const differences = compareLibraryManifests(
      JSON.parse(await readFile(resolve(args[1]), 'utf8')),
      JSON.parse(await readFile(resolve(args[2]), 'utf8')),
    )
    if (differences.length) {
      console.error(differences.join('\n'))
      process.exitCode = 1
    } else console.log('Owner, Auth identity, migrations, rows and Storage byte hashes match.')
    return
  }
  if (args.length !== 2 || args[0] !== '--output') throw new Error('Use --help for manifest usage.')
  const environment = z
    .object({
      NOVELIST_MANIFEST_DATABASE_URL: z.url(),
      NOVELIST_MANIFEST_SUPABASE_URL: z.url(),
      NOVELIST_MANIFEST_STORAGE_KEY: z.string().min(1),
      NOVELIST_MANIFEST_OWNER_ID: z.string().uuid(),
    })
    .safeParse(process.env)
  if (!environment.success)
    throw new Error(
      'Manifest environment is incomplete or invalid. Use --help; do not share credentials in chat.',
    )
  const values = environment.data
  const database = new Client({
    connectionString: values.NOVELIST_MANIFEST_DATABASE_URL,
    application_name: 'novelist-read-only-manifest',
    connectionTimeoutMillis: 15000,
  })
  const storage = createClient(
    values.NOVELIST_MANIFEST_SUPABASE_URL,
    values.NOVELIST_MANIFEST_STORAGE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  )
  try {
    await database.connect()
    const manifest = await createLibraryManifest(
      database,
      storage,
      values.NOVELIST_MANIFEST_OWNER_ID,
    )
    const output = resolve(args[1])
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    await writeFile(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(
      `Wrote ${Object.keys(manifest.tables).length} table fingerprints and ${manifest.objects.length} verified files to ${output}. No library data was changed.`,
    )
  } finally {
    await database.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main().catch(() => {
    console.error(
      'Manifest failed. Check configuration, file permissions, owner identity and Storage availability; no library data was changed. Existing output files are never overwritten.',
    )
    process.exitCode = 1
  })
