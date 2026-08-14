/**
 * Shared test harness for dsh-workspace-overlay.
 *
 * Boots a real Loader composition (the registry's `loader` inject requires
 * one) plus the workspace registry over a throwaway temp root, and seeds
 * workspace directories and `.dsh` compositions for the mount tests.
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WorkspaceRegistry, {
  defaultConfig,
  type WorkspaceRegistryConfig,
} from '../src/registry.js'

/** A fully booted registry runtime over one temp root. */
export interface Harness {
  ctx: Context
  registry: WorkspaceRegistry
  fiber: Fiber
  /** Temp root; `root/host` is the host base bare specifiers resolve from. */
  root: string
}

/**
 * Boot a Loader + workspace registry composition.
 * @param config - registry config, defaulting to `defaultConfig`.
 * @returns the booted runtime.
 */
export async function harness(
  config: WorkspaceRegistryConfig = defaultConfig,
): Promise<Harness> {
  const ctx = new Context()
  const root = await mkdtemp(join(tmpdir(), 'dsh-ws-overlay-'))
  ctx.baseUrl = pathToFileURL(join(root, 'host')).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const fiber = await ctx.plugin(WorkspaceRegistry, config)
  return { ctx, registry: ctx.workspaceCordis, fiber, root }
}

/** Tear a booted runtime down: dispose the composition and the temp root. */
export async function teardown(harnessed: Harness): Promise<void> {
  await rm(harnessed.root, { recursive: true, force: true })
  await harnessed.fiber.dispose()
}

/** The directory of this repository's committed test fixtures. */
export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** Create one workspace directory under `root`. */
export async function makeWorkspace(root: string, name: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Copy fixture plugin files into `<workspace>/.dsh/plugins/`. */
export async function seedPlugins(workspace: string, plugins: string[]): Promise<void> {
  const dir = join(workspace, '.dsh', 'plugins')
  await mkdir(dir, { recursive: true })
  for (const plugin of plugins) {
    await cp(join(FIXTURES, 'plugins', plugin), join(dir, plugin))
  }
}

/** Write `<workspace>/.dsh/cordis.yml` and return its absolute path. */
export async function writeConfig(workspace: string, body: string): Promise<string> {
  const path = join(workspace, '.dsh', 'cordis.yml')
  await mkdir(join(workspace, '.dsh'), { recursive: true })
  await writeFile(path, body)
  return path
}

/** A one-row composition whose single row seeds the given marker. */
export function markerRow(marker: string): string {
  return [
    '- id: marker',
    '  name: ./plugins/contribute.js',
    '  config:',
    `    marker: ${marker}`,
    '',
  ].join('\n')
}

/**
 * The observable state the fixture plugins publish.
 *
 * State crosses through globalThis because the Loader imports fixture modules
 * through Node's internal ESM loader, whose module registry is separate from
 * the test runner's — only process-global state is shared.
 */
export interface FixtureState {
  markers: string[]
  contexts: Context[]
  disposed: number
}

/** Reset the fixture state for one test. */
export function resetFixtures(): void {
  ;(globalThis as unknown as { __WS_FIXTURE__?: FixtureState }).__WS_FIXTURE__ = {
    markers: [],
    contexts: [],
    disposed: 0,
  }
  delete (globalThis as unknown as { __WS_SELF_DISPOSED__?: unknown }).__WS_SELF_DISPOSED__
}

/** Read the fixture state, throwing when a test forgot to reset it. */
export function fixtureState(): FixtureState {
  const state = (globalThis as unknown as { __WS_FIXTURE__?: FixtureState }).__WS_FIXTURE__
  if (!state) throw new Error('fixture state missing — resetFixtures() must run in beforeEach')
  return state
}

/** The self-dispose fixture's settlement promise, or undefined when unseeded. */
export function selfDisposed(): Promise<unknown> | undefined {
  return (globalThis as unknown as { __WS_SELF_DISPOSED__?: Promise<unknown> }).__WS_SELF_DISPOSED__
}
