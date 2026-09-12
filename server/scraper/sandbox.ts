import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { capturedPageSchema, type CapturedPage } from '../../src/lib/scraper/contracts.ts'

export const SANDBOX_IMAGE = 'novelist-scraper:1'
export const SANDBOX_TIMEOUT_MS = 5000

function docker(argumentsList: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      argumentsList,
      {
        encoding: 'utf8',
        timeout: SANDBOX_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 512_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const exceeded = error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          reject(
            new Error(
              exceeded
                ? 'Scraper exceeded its time or output limit.'
                : `Scraper container failed: ${stderr.slice(0, 1800) || 'Docker is unavailable.'}`,
            ),
          )
        } else resolve(stdout)
      },
    )
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(input)
  })
}

export async function sandboxImageId(): Promise<string> {
  try {
    return (await docker(['image', 'inspect', SANDBOX_IMAGE, '--format', '{{.Id}}'])).trim()
  } catch {
    throw new Error(
      'The scraper sandbox is unavailable. Start Docker and run npm run scraper:setup.',
    )
  }
}

export async function runAdapter(code: string, page: CapturedPage): Promise<unknown> {
  capturedPageSchema.parse(page)
  if (!code.trim() || code.length > 24_000)
    throw new Error('Scraper code must contain 1-24,000 characters.')
  const name = `novelist-scraper-${randomUUID()}`
  try {
    const stdout = await docker(
      [
        'run',
        '--rm',
        '--pull=never',
        '--name',
        name,
        '--label',
        'novelist.scraper=true',
        '--interactive',
        '--network=none',
        '--read-only',
        '--user=1000:1000',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges=true',
        '--pids-limit=32',
        '--cpus=0.5',
        '--memory=192m',
        '--memory-swap=192m',
        '--ipc=none',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,nodev,size=4m',
        '--ulimit',
        'nofile=128:128',
        SANDBOX_IMAGE,
      ],
      JSON.stringify({ code, page }),
    )
    try {
      return JSON.parse(stdout) as unknown
    } catch {
      throw new Error('Scraper must return exactly one JSON result without console output.')
    }
  } finally {
    await docker(['rm', '--force', name]).catch(() => undefined)
  }
}
