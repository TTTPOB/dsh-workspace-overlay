/**
 * Canonical per-workspace Cordis scopes for DSH.
 *
 * `WorkspaceRegistry` mints one opaque scope per canonical workspace path.
 * Every consumer of a workspace (sessions, agents) leases the same scope and
 * shares it; the scope is disposed when the last lease is released.
 *
 * @module dsh-workspace-overlay
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import z from '@deepseek-ai/schemastery'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Canonical per-workspace scope registry (provider: dsh-workspace-overlay). */
    workspaceRegistry: WorkspaceRegistry
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

/** Read-only debug snapshot of one live workspace entry. */
export interface WorkspaceInfo {
  /** Canonical (realpath) workspace path. */
  canonical: string
  /** Number of outstanding leases. */
  leases: number
  /** True once the final release ran. */
  disposed: boolean
  trustWorkspaceConfig: boolean
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

class LeaseImpl implements WorkspaceLease {
  private releasing: Promise<void> | undefined
  readonly key: ScopeKey
  readonly ctx: Context
  readonly canonical: string
  readonly trustWorkspaceConfig: boolean

  constructor(
    private readonly entry: WorkspaceEntry,
    private readonly releaseEntry: (entry: WorkspaceEntry) => Promise<void>,
  ) {
    this.key = entry.key
    this.ctx = entry.scope.ctx
    this.canonical = entry.canonical
    this.trustWorkspaceConfig = entry.trustWorkspaceConfig
  }

  release(): Promise<void> {
    return (this.releasing ??= this.releaseEntry(this.entry))
  }
}

export default class WorkspaceRegistry extends Service {
  static Config = z.object({
    trustWorkspaceConfig: z.boolean().default(true),
  }) as z<WorkspaceRegistryConfig>

  private readonly entries = new Map<string, WorkspaceEntry>()
  private readonly inflight = new Map<string, Promise<WorkspaceEntry>>()
  private readonly selfCtx: Context

  constructor(ctx: Context, private readonly config: WorkspaceRegistryConfig = defaultConfig) {
    super(ctx, 'workspaceRegistry')
    this.selfCtx = ctx
  }

  /** Number of live workspace entries (debug). */
  get size(): number {
    return this.entries.size
  }

  /** Read-only snapshot of one live entry by canonical path (debug). */
  get(canonical: string): WorkspaceInfo | undefined {
    const entry = this.entries.get(canonical)
    if (!entry) return undefined
    return {
      canonical: entry.canonical,
      leases: entry.leases,
      disposed: entry.disposed,
      trustWorkspaceConfig: entry.trustWorkspaceConfig,
    }
  }

  /**
   * Acquire the workspace scope for `cwd` (absolute, existing directory;
   * canonicalized via `realpath(resolve(cwd))`). Concurrent acquires share one
   * entry via single-flight; failures leave no cached state and are retryable.
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
      .then((entry) => {
        // Publish only after the scope exists; rejections never cache.
        this.entries.set(canonical, entry)
      })
      .finally(() => {
        this.inflight.delete(canonical)
      })
    return creating
  }

  private async createEntry(canonical: string): Promise<WorkspaceEntry> {
    const key: ScopeKey = {}
    const scope = createScope(this.selfCtx, key)
    return {
      canonical,
      key,
      scope,
      leases: 0,
      disposed: false,
      trustWorkspaceConfig: this.config.trustWorkspaceConfig,
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
    return Promise.resolve(entry.scope.dispose()).then(() => undefined)
  }
}
