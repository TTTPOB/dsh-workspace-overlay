/**
 * Shared test harness for the ported MCP core specs.
 *
 * Mounts the real ToolRuntime over a bare Cordis context (the same
 * composition the official rc.6 suite uses), captures supervisor log lines,
 * and owns the fixture-server marker file so every spec can prove spawned
 * children started and exited.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Mount SystemPrompt + ToolRuntime so `ctx.tools` can register and execute. */
export async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

/** Capture the supervisor's logger lines by level on one context. */
export function captureLogs(ctx: Context): { warns: string[]; errors: string[]; infos: string[] } {
  const warns: string[] = []
  const errors: string[] = []
  const infos: string[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
  ctx.logger.info = ((message: unknown) => { infos.push(String(message)) }) as typeof ctx.logger.info
  return { warns, errors, infos }
}

export function sleep(ms: number): Promise<void> {
  // Annotated binding: no-invalid-void-type rejects the explicit type argument
  // in call position but accepts the inferred form.
  const gate: PromiseWithResolvers<void> = Promise.withResolvers()
  setTimeout(gate.resolve, ms)
  return gate.promise
}

export const testToolSignal: AbortSignal = new AbortController().signal

let callSeq = 0
export function nextCallId(): CallId {
  return CallId(`mcp-spec-${++callSeq}`)
}

/**
 * Known-answer public names derived from the installed rc.6 bundle at dev
 * time (its `publicToolName` is not exported from `lib`); pinned here so the
 * port's naming contract is checked against the official algorithm.
 */
export const KNOWN_SRV_HASH_NAME = 'mcp__srv__admin_reset_3b185f786768'
export const KNOWN_FIXTURE_HASH_NAME = 'mcp__fixture__admin_reset_2d9bb2dfe9aa'
export const KNOWN_LONG_NAME = 'mcp__srv__aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_3b75b5cc78d8'

/** Parsed fixture-server marker file. */
export interface MarkerLog {
  /** Pids that started a fixture process. */
  starts: number[]
  /** Pids that reported a process exit. */
  exits: number[]
}

/** Create a fresh marker file in a temp dir and return its path. */
export async function makeMarkerFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-marker-'))
  const file = join(dir, 'marker.log')
  await appendFile(file, '')
  return file
}

/** Read and parse a fixture marker file (missing file = empty log). */
export async function readMarkers(file: string): Promise<MarkerLog> {
  let body: string
  try {
    body = await readFile(file, 'utf8')
  } catch {
    body = ''
  }
  const starts: number[] = []
  const exits: number[] = []
  for (const line of body.split('\n')) {
    const [kind, pidText] = line.trim().split(' ')
    const pid = Number(pidText)
    if (kind === 'start' && Number.isInteger(pid)) starts.push(pid)
    if (kind === 'exit' && Number.isInteger(pid)) exits.push(pid)
  }
  return { starts, exits }
}

/** Kill every fixture process still alive according to the marker file. */
export async function killMarkedProcesses(file: string): Promise<void> {
  const { starts, exits } = await readMarkers(file)
  for (const pid of starts) {
    if (exits.includes(pid)) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

/** Remove a marker file's temp directory (best effort). */
export async function removeMarkerFile(file: string): Promise<void> {
  await rm(join(file, '..'), { recursive: true, force: true }).catch(() => {})
}
