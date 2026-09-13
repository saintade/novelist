import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'

async function secret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Use an interactive terminal for hidden password entry.')
  const hidden = new Writable({ write(_chunk, _encoding, done) { done() } })
  const input = createInterface({ input: process.stdin, output: hidden, terminal: true })
  process.stdout.write(prompt)
  try {
    return await new Promise<string>((resolve, reject) => {
      input.once('SIGINT', () => reject(new Error('Password entry cancelled.')))
      input.question('', resolve)
    })
  } finally {
    input.close()
    process.stdout.write('\n')
  }
}

async function main() {
  const { values } = parseArgs({ options: { 'project-ref': { type: 'string' }, owner: { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) {
    console.log('npm run account:password -- --project-ref PROJECT --owner UUID\nEnter and confirm a password directly at the hidden terminal prompts. No password is accepted as a command argument, written to disk, or printed. The linked project and verified permanent account are checked before updating. Uses the signed-in Supabase CLI.')
    return
  }
  const project = z.string().regex(/^[a-z]{20}$/).parse(values['project-ref'])
  const owner = z.string().uuid().parse(values.owner)
  if ((await readFile('supabase/.temp/project-ref', 'utf8')).trim() !== project) throw new Error('The project must match the linked hosted library.')
  const keys = JSON.parse(execFileSync('npx', ['supabase', 'projects', 'api-keys', '--project-ref', project, '--output', 'json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })) as { name: string; api_key: string }[]
  const adminKey = keys.find(key => key.name === 'service_role')?.api_key
  const publicKey = keys.find(key => key.name === 'anon')?.api_key
  if (!adminKey || !publicKey) throw new Error('The CLI could not obtain the required project keys.')
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const admin = createClient(`https://${project}.supabase.co`, adminKey, options)
  const account = await admin.auth.admin.getUserById(owner)
  if (account.error || !account.data.user?.email_confirmed_at || account.data.user.is_anonymous || !account.data.user.email)
    throw new Error('The selected hosted account must be permanent and email-verified.')
  console.log(`Hosted account: ${account.data.user.email}. Local accounts and library data are unchanged.`)
  let password = await secret('New hosted-library password (hidden, minimum 8 characters): ')
  let confirmation = await secret('Confirm password (hidden): ')
  if (password.length < 8 || password !== confirmation) throw new Error('Passwords must match and contain at least 8 characters. Nothing was changed.')
  const verifier = createClient(`https://${project}.supabase.co`, publicKey, options)
  let changed = false
  try {
    const updated = await admin.auth.admin.updateUserById(owner, { password })
    if (updated.error || updated.data.user?.id !== owner) throw new Error('Hosted Auth rejected the password update.')
    changed = true
    const login = await verifier.auth.signInWithPassword({ email: account.data.user.email, password })
    if (login.error || login.data.user?.id !== owner) throw new Error('Password was updated, but the login verification failed.')
    const access = await verifier.rpc('library_access_status')
    if (access.error || access.data?.restricted !== true || access.data?.allowed !== true)
      throw new Error('Password was updated, but library access could not be verified.')
    console.log('Password set and sign-in verified for the existing library owner. Use Email + Use password in the app; no email link or code is needed.')
  } catch {
    throw new Error(changed ? 'Password was updated, but its sign-in/access check did not complete. Try the app using password sign-in.' : 'Password update failed. The existing account was not replaced.')
  } finally {
    password = ''
    confirmation = ''
    await verifier.auth.signOut({ scope: 'local' }).catch(() => undefined)
  }
}

void main().catch(failure => {
  const message = failure instanceof Error && !('output' in failure) && !('issues' in failure) ? failure.message : 'Password setup could not complete. Check CLI sign-in and command arguments.'
  console.error(message)
  process.exitCode = 1
})