/**
 * Canonical per-workspace Cordis scopes for DSH.
 *
 * `WorkspaceRegistry` mints one opaque scope per canonical workspace path.
 * Every consumer of a workspace (sessions, agents) leases the same scope and
 * shares it; the scope is disposed when the last lease is released.
 *
 * The first entry for a workspace reads `<workspace>/.dsh/cordis.yml` and,
 * when the registry trusts workspace configs, mounts it as a workspace
 * composition under the scope before the first lease is handed out. The
 * mount is single-flight with entry creation: concurrent acquires of one
 * workspace share one mount, a failed mount disposes the scope and leaves
 * nothing cached, and a later acquire retries the fixed file. Untrusted
 * workspaces are never read, parsed, or imported — they still get an empty
 * scope so their consumers inherit the host composition unchanged.
 *
 * @module dsh-workspace-overlay
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import z from '@deepseek-ai/schemastery'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  mountWorkspaceTree,
  workspaceConfigPath,
  type MountedWorkspaceTree,
} from './workspace-tree.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Canonical per-workspace Cordis scope registry. */
    workspaceCordis: WorkspaceRegistry
  }
}

export interface WorkspaceRegistryConfig {
  /** Whether `<workspace>/.dsh/cordis.yml` is honored by workspace consumers. */
  trustWorkspaceConfig: boolean
}

export const defaultConfig: WorkspaceRegistryConfig = {
  trustWorkspaceConfig: true,
}

/** The path does not exist. */
export class WorkspaceNotFoundError extends Error {
  constructor(cwd: string) {
    super(`workspace directory does not exist: ${cwd}`)
    this.name = 'WorkspaceNotFoundError'
  }
}

/** The path exists but is not a directory. */
export class WorkspaceNotDirectoryError extends Error {
  constructor(cwd: string) {
    super(`workspace path is not a directory: ${cwd}`)
    this.name = 'WorkspaceNotDirectoryError'
  }
}

/** Read-only debug snapshot of one live workspace composition. */
export interface WorkspaceCompositionInfo {
  /** Absolute path of the mounted config file. */
  readonly path: string
  /** True while the composition subtree is still alive. */
  readonly active: boolean
}

/** Read-only debug snapshot of one live workspace entry. */
export interface WorkspaceInfo {
  /** Canonical (realpath) workspace path. */
  canonical: string
  /** Number of outstanding leases. */
  leases: number
  /** True once the final release ran. */
  disposed: boolean
  trustWorkspaceConfig: boolean
  /** True when `<root>/.dsh/cordis.yml` existed when the entry was created. */
  configured: boolean
  /** The mounted composition, when trust enabled and a config file exists. */
  composition?: WorkspaceCompositionInfo
}

/**
 * One consumer's hold on a workspace scope. The scope lives while at least
 * one lease is outstanding; the final `release()` awaits `scope.dispose()`.
 */
export interface WorkspaceLease {
  /** Opaque scope identity; compare by reference only. */
  readonly key: ScopeKey
  /** Scope-owned context; registrations made through it die with the scope. */
  readonly ctx: Context
  /** Canonical (realpath) workspace path. */
  readonly canonical: string
  readonly trustWorkspaceConfig: boolean
  /** True when `<root>/.dsh/cordis.yml` existed when the entry was created. */
  readonly configured: boolean
  /** The mounted composition, when trust enabled and a config file exists. */
  readonly composition?: WorkspaceCompositionInfo
  /** Release this lease. Idempotent; the final release disposes the scope. */
  release(): Promise<void>
}

/** Internal per-workspace state. */
interface WorkspaceEntry {
  canonical: string
  key: ScopeKey
  scope: Scope
  leases: number
  disposed: boolean
  trustWorkspaceConfig: boolean
  configured: boolean
  /**
   * Present when a trusted config file was mounted. The subtree is owned by
   * the scope: the final release's `scope.dispose()` unwinds it, so no
   * separate composition disposer is needed (kept for status/diagnostics).
   */
  composition?: MountedWorkspaceTree
}

/** Rejects `cwd` unless it is an absolute path to an existing directory. */
async function canonicalize(cwd: string): Promise<string> {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError('workspace cwd must be a non-empty string')
  }
  if (!isAbsolute(cwd)) {
    throw new TypeError(`workspace cwd must be an absolute path: ${cwd}`)
  }
  let canonical: string
  try {
    canonical = await realpath(resolve(cwd))
  } catch (err) {
    if (isEnoent(err)) throw new WorkspaceNotFoundError(cwd)
    throw err
  }
  try {
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new WorkspaceNotDirectoryError(cwd)
  } catch (err) {
    if (err instanceof WorkspaceNotDirectoryError) throw err
    if (isEnoent(err)) throw new WorkspaceNotFoundError(cwd)
    throw err
  }
  return canonical
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/** Whether `path` exists; ENOENT is the only tolerated failure. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (err) {
    if (isEnoent(err)) return false
    throw err
  }
}

class LeaseImpl implements WorkspaceLease {
  private releasing: Promise<void> | undefined
  readonly key: ScopeKey
  readonly ctx: Context
  readonly canonical: string
  readonly trustWorkspaceConfig: boolean
  readonly configured: boolean

  constructor(
    private readonly entry: WorkspaceEntry,
    private readonly releaseEntry: (entry: WorkspaceEntry) => Promise<void>,
  ) {
    this.key = entry.key
    this.ctx = entry.scope.ctx
    this.canonical = entry.canonical
    this.trustWorkspaceConfig = entry.trustWorkspaceConfig
    this.configured = entry.configured
  }

  get composition(): WorkspaceCompositionInfo | undefined {
    const mounted = this.entry.composition
    if (!mounted) return undefined
    return {
      path: workspaceConfigPath(this.entry.canonical),
      active: mounted.fiber.uid !== null,
    }
  }

  release(): Promise<void> {
    return (this.releasing ??= this.releaseEntry(this.entry))
  }
}

export default class WorkspaceRegistry extends Service {
  static Config = z.object({
    trustWorkspaceConfig: z.boolean().default(true),
  }) as z<WorkspaceRegistryConfig>

  /** The loader supplies the host base bare specifiers resolve against. */
  static inject = ['loader']

  private readonly entries = new Map<string, WorkspaceEntry>()
  private readonly inflight = new Map<string, Promise<WorkspaceEntry>>()
  /**
   * Scope identity → canonical workspace root, for consumers that must resolve
   * a workspace scope key back to its root without guessing cwd/process.cwd
   * (the workspace-aware MCP manager). Keyed by the opaque per-generation
   * scope key, so a disposed entry's mapping dies with its scope and a fresh
   * generation mints a fresh key.
   */
  private readonly scopeRoots = new WeakMap<ScopeKey, string>()
  private readonly selfCtx: Context

  constructor(ctx: Context, private readonly config: WorkspaceRegistryConfig = defaultConfig) {
    super(ctx, 'workspaceCordis')
    this.selfCtx = ctx
  }

  /**
   * The canonical root of a live workspace scope key, or undefined when the
   * key is not (or no longer is) a workspace entry's scope. The registry is
   * the only authority on the workspace-root mapping, so consumers never
   * resolve workspace identity from ambient cwd.
   */
  workspaceForScope(key: ScopeKey): string | undefined {
    return this.scopeRoots.get(key)
  }

  /** Number of live workspace entries (debug). */
  get size(): number {
    return this.entries.size
  }

  /** Read-only snapshot of one live entry by canonical path (debug). */
  get(canonical: string): WorkspaceInfo | undefined {
    const entry = this.entries.get(canonical)
    if (!entry) return undefined
    const composition = entry.composition
    return {
      canonical: entry.canonical,
      leases: entry.leases,
      disposed: entry.disposed,
      trustWorkspaceConfig: entry.trustWorkspaceConfig,
      configured: entry.configured,
      ...(composition && {
        composition: {
          path: workspaceConfigPath(entry.canonical),
          active: composition.fiber.uid !== null,
        },
      }),
    }
  }

  /**
   * Acquire the workspace scope for `cwd` (absolute, existing directory;
   * canonicalized via `realpath(resolve(cwd))`). Concurrent acquires share one
   * entry via single-flight; failures leave no cached state and are retryable.
   * The first acquire mounts the workspace composition, so it resolves only
   * once every row is usable.
   */
  async acquire(cwd: string): Promise<WorkspaceLease> {
    const canonical = await canonicalize(cwd)
    for (;;) {
      const entry = await this.entryFor(canonical)
      // The final release of a concurrent lease may have disposed this entry
      // while we awaited creation; retry to mint a fresh one.
      if (entry.disposed) continue
      entry.leases += 1
      return new LeaseImpl(entry, candidate => this.release(candidate))
    }
  }

  private entryFor(canonical: string): Promise<WorkspaceEntry> {
    const existing = this.entries.get(canonical)
    if (existing) return Promise.resolve(existing)
    const inflight = this.inflight.get(canonical)
    if (inflight) return inflight
    const creating = this.createEntry(canonical)
    this.inflight.set(canonical, creating)
    void creating
      .then(
        (entry) => {
          // Publish only after the scope exists; rejections never cache.
          this.entries.set(canonical, entry)
        },
        () => {
          // The rejection is delivered to every acquire() awaiting `creating`;
          // this bookkeeping chain must not become an unhandled rejection.
        },
      )
      .finally(() => {
        this.inflight.delete(canonical)
      })
    return creating
  }

  private async createEntry(canonical: string): Promise<WorkspaceEntry> {
    const key: ScopeKey = {}
    this.scopeRoots.set(key, canonical)
    const scope = createScope(this.selfCtx, key)
    try {
      // Existence is a stat; the file is only read/parsed/imported when trust
      // is enabled, so an untrusted workspace still gets its empty scope.
      const configured = await exists(workspaceConfigPath(canonical))
      const composition = configured && this.config.trustWorkspaceConfig
        ? await mountWorkspaceTree(scope.ctx, canonical)
        : undefined
      return {
        canonical,
        key,
        scope,
        leases: 0,
        disposed: false,
        trustWorkspaceConfig: this.config.trustWorkspaceConfig,
        configured,
        composition,
      }
    } catch (error) {
      // The subtree (if any) is owned by the scope; disposing the scope
      // unwinds it, and a rejected entry is never cached, so the next acquire
      // retries the workspace from a fresh scope.
      this.scopeRoots.delete(key)
      await scope.dispose()
      throw error
    }
  }

  private release(entry: WorkspaceEntry): Promise<void> {
    if (entry.disposed) return Promise.resolve()
    entry.leases -= 1
    if (entry.leases > 0) return Promise.resolve()
    // Final release: remove from the map first, so a failed dispose still
    // leaves the workspace retryable with a fresh scope, then await disposal.
    entry.disposed = true
    this.entries.delete(entry.canonical)
    this.scopeRoots.delete(entry.key)
    return Promise.resolve(entry.scope.dispose()).then(() => undefined)
  }
}
