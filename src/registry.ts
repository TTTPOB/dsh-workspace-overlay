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
 * When watching is enabled (trusted and `watchWorkspaceConfig`), every live
 * entry owns exactly one `WorkspaceReloadController` over its exact top-level
 * config path. The controller's watcher is anchored on the canonical
 * workspace root — an existing directory, so a config file that appears later
 * (even when `.dsh/` did not exist at acquire time) is observed — and the
 * registry awaits the watcher's `ready` BEFORE its strict initial stat and
 * mount, closing the gap between the initial read and the watcher: a change
 * that lands before the strict read is simply part of it, and one that lands
 * while it runs is replayed by the controller's activation as exactly one
 * reconcile pass, which re-stats the file and skips the mount when nothing
 * observably changed. A watcher that fails to become ready rejects the
 * initial acquire and leaves nothing cached. A file event afterwards
 * debounces into a serialized reload pass that disposes the current
 * composition subtree, re-stats the file, and mounts a fresh subtree — or
 * publishes an empty workspace layer when the file is gone. A failed live
 * reload leaves the scope and leases alive and retries on the next event;
 * only the initial mount is strict. The final lease release stops the
 * controller (cancelling the debounce, closing the watcher, and draining a
 * running pass) before the scope goes down.
 *
 * @module dsh-workspace-overlay
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import z from '@deepseek-ai/schemastery'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  mountWorkspaceTree,
  workspaceConfigPath,
  type MountedWorkspaceTree,
} from './workspace-tree.js'
import {
  WorkspaceReloadController,
  type WorkspaceReloadSnapshot,
  type WorkspaceTimer,
  type WorkspaceWatchFactory,
} from './workspace-reload-controller.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Canonical per-workspace Cordis scope registry. */
    workspaceCordis: WorkspaceRegistry
  }
}

export interface WorkspaceRegistryConfig {
  /** Whether `<workspace>/.dsh/cordis.yml` is honored by workspace consumers. */
  trustWorkspaceConfig: boolean
  /**
   * Whether live file events on `<workspace>/.dsh/cordis.yml` reload the
   * composition. No effect when trust is disabled.
   */
  watchWorkspaceConfig: boolean
  /**
   * Debounce window in milliseconds for config file event bursts; a
   * non-negative finite integer no greater than `MAX_TIMER_DELAY_MS`.
   */
  reloadDebounceMs: number
}

export const defaultConfig: WorkspaceRegistryConfig = {
  trustWorkspaceConfig: true,
  watchWorkspaceConfig: true,
  reloadDebounceMs: 150,
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

/** Read-only live snapshot of one entry's reload controller. */
export type WorkspaceReloadInfo = WorkspaceReloadSnapshot

/** Read-only debug snapshot of one live workspace entry. */
export interface WorkspaceInfo {
  /** Canonical (realpath) workspace path. */
  canonical: string
  /** Number of outstanding leases. */
  leases: number
  /** True once the final release ran. */
  disposed: boolean
  trustWorkspaceConfig: boolean
  /** True when `<root>/.dsh/cordis.yml` currently exists (live state). */
  configured: boolean
  /** The mounted composition, when trust enabled and a config file exists. */
  composition?: WorkspaceCompositionInfo
  /** Live reload controller snapshot, when watching is enabled. */
  reload?: WorkspaceReloadInfo
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
  /**
   * True when `<root>/.dsh/cordis.yml` existed when this lease was created.
   * A creation-time snapshot: the live state is read through
   * `workspaceCordis.get(canonical)`.
   */
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
  /** Live state: true while `<root>/.dsh/cordis.yml` exists. */
  configured: boolean
  /**
   * The currently mounted composition subtree. Live: a reload pass disposes
   * the old subtree, clears the field, and publishes the fresh one only when
   * the entry is still live. Owned by the scope as a fallback — the final
   * release's `scope.dispose()` unwinds whatever subtree is still mounted.
   */
  composition?: MountedWorkspaceTree
  /**
   * The stat of the config file the currently mounted composition was built
   * from (mtime/size/inode), when a composition is mounted. A reload pass
   * compares the current stat against it to recognize events that predate the
   * mount or were no-ops, so a reconcile pass never forces a pointless second
   * dispose+mount (and MCP restart) for a file that did not observably change.
   */
  mountedStat?: { mtimeMs: number; size: number; ino?: number }
  /**
   * The entry's reload controller, when trusted and watching is enabled. Owns
   * the watcher, the debounce timer, and the serialized reload passes; the
   * final release stops it before the scope goes down.
   */
  controller?: WorkspaceReloadController
}

/**
 * Constructor-only seams for deterministic tests.
 *
 * The plugin loader cannot pass constructor arguments to a class plugin, so a
 * production registration always gets the real chokidar factory and global
 * timers; tests that need deterministic watcher/timer control construct the
 * registry directly (or through a wrapper plugin) with these options.
 */
export interface WorkspaceRegistryRuntime {
  /** Injectable watcher factory for every entry's reload controller. */
  watchFactory?: WorkspaceWatchFactory
  /** Injectable timer for every entry's reload controller. */
  timer?: WorkspaceTimer
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

/** The stat of `path`, or undefined when it does not exist. */
async function statOrUndefined(path: string): Promise<{ mtimeMs: number; size: number; ino?: number } | undefined> {
  try {
    const info = await stat(path)
    return { mtimeMs: info.mtimeMs, size: info.size, ino: info.ino }
  } catch (err) {
    if (isEnoent(err)) return undefined
    throw err
  }
}

/**
 * Whether two stats describe the same file content for reload purposes:
 * same mtime, same size, and the same inode. An editor's atomic
 * rename-replace mints a new inode (and a rewrite changes the mtime), so a
 * genuinely saved file never compares equal; only events that predate the
 * current mount or did not touch the file (a no-op touch with preserved
 * times) compare equal.
 */
function sameFileStat(
  left: { mtimeMs: number; size: number; ino?: number },
  right: { mtimeMs: number; size: number; ino?: number },
): boolean {
  return left.mtimeMs === right.mtimeMs && left.size === right.size && left.ino === right.ino
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
    // Snapshot at lease creation; `entry.configured` mutates with live
    // reloads and is only readable through `get(canonical)`.
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
    watchWorkspaceConfig: z.boolean().default(true),
    reloadDebounceMs: z.natural().max(MAX_TIMER_DELAY_MS).default(defaultConfig.reloadDebounceMs),
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

  constructor(
    ctx: Context,
    private readonly config: WorkspaceRegistryConfig = defaultConfig,
    private readonly runtime: WorkspaceRegistryRuntime = {},
  ) {
    super(ctx, 'workspaceCordis')
    this.selfCtx = ctx
    // Fiber unload (provider HMR, host teardown) must not leave watchers,
    // timers, or compositions behind: dispose every live entry exactly like
    // the final lease release would, so a registry that is replaced or torn
    // down while leases are still outstanding still converges.
    ctx.effect(() => () => this.teardownAllEntries())
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
      // Live state, unlike a lease's creation-time snapshot.
      configured: entry.configured,
      ...(composition && {
        composition: {
          path: workspaceConfigPath(entry.canonical),
          active: composition.fiber.uid !== null,
        },
      }),
      ...(entry.controller && { reload: entry.controller.snapshot() }),
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
    const trust = this.config.trustWorkspaceConfig
    const entry: WorkspaceEntry = {
      canonical,
      key,
      scope,
      leases: 0,
      disposed: false,
      trustWorkspaceConfig: trust,
      configured: false,
      composition: undefined,
      mountedStat: undefined,
      controller: undefined,
    }
    let controller: WorkspaceReloadController | undefined
    try {
      if (trust && this.config.watchWorkspaceConfig) {
        // Exactly one controller per trusted, watched entry — whether or not
        // the config file exists right now. The watcher is anchored on the
        // canonical workspace root (an existing directory), not on the exact
        // config path: chokidar v4 cannot reliably report a nested path that
        // appears after watching started, and `.dsh/` itself may not exist
        // yet. The controller still accepts only exact config path events.
        controller = new WorkspaceReloadController({
          path: workspaceConfigPath(canonical),
          watchAnchor: canonical,
          debounceMs: this.config.reloadDebounceMs,
          reload: () => this.reloadEntry(entry),
          diagnostics: {
            onWatcherError: (error) => this.reportWatcherError(entry, error),
            onReloadError: (error) => this.reportReloadError(entry, error),
          },
          watchFactory: this.runtime.watchFactory,
          timer: this.runtime.timer,
        })
        entry.controller = controller
        // Strict readiness gate: the initial stat/mount below runs only after
        // the watcher is ready, so a change made between that read and the
        // watcher can never be lost — anything before the read is part of the
        // mount, and anything during it is replayed as a reconcile pass. A
        // watcher that errors during startup rejects the acquire; nothing is
        // published and nothing leaks.
        await controller.ready
      }
      // Existence is a stat; the file is only read/parsed/imported when trust
      // is enabled, so an untrusted workspace still gets its empty scope.
      const configPath = workspaceConfigPath(canonical)
      const configStat = await statOrUndefined(configPath)
      const configured = configStat !== undefined
      const composition = configured && trust
        ? await mountWorkspaceTree(scope.ctx, canonical)
        : undefined
      entry.configured = configured
      entry.composition = composition
      // The stat this mount was decided on; a later reconcile pass compares
      // against it to skip no-op passes instead of double-mounting.
      if (composition !== undefined) entry.mountedStat = configStat
      // The strict mount is committed; event-driven reloads may begin. Events
      // that arrived before or during the mount were only dirtied, and
      // activation replays them as exactly one pass, which re-stats the file
      // and skips when nothing observably changed.
      controller?.activate()
      return entry
    } catch (error) {
      // The rejected entry is never cached. Dispose whatever the entry
      // allocated — a created controller (stop it, cancelling debounce and
      // closing the watcher) and the scope (which unwinds any mounted
      // subtree) — so a failed acquire leaks nothing and the next acquire
      // retries the workspace from a fresh scope.
      if (controller !== undefined) {
        try {
          await controller.stop()
        } catch {
          // The acquire rejection below is the actionable error; a failing
          // stop must not mask it or leave the catch path itself rejected.
        }
      }
      this.scopeRoots.delete(key)
      await scope.dispose()
      throw error
    }
  }

  /**
   * One reload pass for a live entry: re-stat the top-level config, dispose
   * the current composition subtree when the file observably changed, and
   * mount a fresh tree — or publish an empty workspace layer when the file is
   * gone.
   *
   * The pass is serialized by the entry's controller and never outlives the
   * entry: the final release stops accepting events, cancels the debounce,
   * and drains the running pass before the scope is disposed, and the pass
   * itself re-checks `entry.disposed` at every await boundary, so a release
   * that lands mid-pass never publishes a composition into a dead entry — a
   * mount that completed after disposal is unwound immediately instead.
   *
   * The pass is also the reconcile seam for the watcher readiness gap: the
   * initial strict mount happens after the watcher's `ready`, and events that
   * arrived before or during it are replayed as one pass here. Because the
   * file is re-statted first and compared against the stat the current
   * composition was built from, such a pass recognizes that the file did not
   * observably change and keeps the live tree — no pointless second
   * dispose+mount (and no pointless MCP restart) for an event that predates
   * the mount.
   *
   * A failed mount/audit leaves the composition field empty and rejects, so
   * the controller records the failure and the next file event retries; the
   * scope, leases, and Agents all stay live.
   */
  private async reloadEntry(entry: WorkspaceEntry): Promise<void> {
    if (entry.disposed) return
    const path = workspaceConfigPath(entry.canonical)
    const configStat = await statOrUndefined(path)
    if (entry.disposed) return
    if (configStat === undefined) {
      // The file is gone: publish the empty workspace layer. The old subtree
      // goes down first and is fully quiescent before anything new mounts;
      // the field is cleared before the awaited disposal so no observer can
      // see a dead composition as live.
      const current = entry.composition
      entry.composition = undefined
      entry.mountedStat = undefined
      entry.configured = false
      if (current !== undefined) await current.dispose()
      return
    }
    if (
      entry.composition !== undefined
      && entry.mountedStat !== undefined
      && sameFileStat(configStat, entry.mountedStat)
    ) {
      // The event(s) that led here predate the current mount or were no-ops:
      // the file is indistinguishable from what the live composition was
      // built from (same mtime, size, and inode), so disposing and remounting
      // would only restart the workspace capabilities for nothing.
      entry.configured = true
      return
    }
    // The old subtree goes down first and is fully quiescent before anything
    // new mounts; the field is cleared before the awaited disposal so no
    // observer can see a dead composition as live.
    const current = entry.composition
    entry.composition = undefined
    entry.mountedStat = undefined
    entry.configured = true
    if (current !== undefined) await current.dispose()
    if (entry.disposed) return
    const mounted = await mountWorkspaceTree(entry.scope.ctx, entry.canonical)
    if (entry.disposed) {
      // The final release landed while the subtree mounted: unwind the fresh
      // tree immediately instead of publishing it into the dying entry.
      await mounted.dispose()
      return
    }
    entry.composition = mounted
    // The stat this mount was decided on; the next pass compares against it.
    entry.mountedStat = configStat
  }

  /**
   * Stop one entry's reload controller and dispose its workspace scope. Both
   * teardown steps always run, even when the other one fails; failures are
   * aggregated (or rethrown singly) so the caller sees every problem.
   */
  private async disposeEntry(entry: WorkspaceEntry): Promise<void> {
    const failures: unknown[] = []
    try {
      await entry.controller?.stop()
    } catch (error) {
      failures.push(error)
    }
    try {
      await entry.scope.dispose()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'workspace-cordis: failed to stop the reload controller and dispose the workspace scope',
      )
    }
  }

  /** Dispose every live entry on fiber unload (provider HMR, teardown). */
  private async teardownAllEntries(): Promise<void> {
    const failures: unknown[] = []
    for (const entry of [...this.entries.values()]) {
      if (entry.disposed) continue
      // Mark first, mirroring the final release, so a reload pass racing the
      // unload never publishes into a dying entry.
      entry.disposed = true
      this.entries.delete(entry.canonical)
      this.scopeRoots.delete(entry.key)
      try {
        await this.disposeEntry(entry)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `workspace-cordis: failed to dispose ${failures.length} workspace entr(ies) on fiber teardown`,
      )
    }
  }

  /**
   * The reportable text of an error for diagnostics.
   *
   * Aggregates are flattened one line per cause so a multi-row loader failure
   * names every row; the fallbacks keep hostile values readable. Only error
   * messages are used — never config text, environment values, or headers —
   * because these lines are written to the log.
   */
  private static flattenError(error: unknown): string {
    if (error instanceof AggregateError) {
      return [error.message, ...error.errors.map(cause => `- ${WorkspaceRegistry.flattenError(cause)}`)].join('\n')
    }
    if (error instanceof Error) return error.message
    return String(error)
  }

  /** Log a watcher-level error with the workspace identity, never the config. */
  private reportWatcherError(entry: WorkspaceEntry, error: unknown): void {
    this.selfCtx.logger.warn(
      `workspace-cordis: watcher for workspace ${entry.canonical} (${workspaceConfigPath(entry.canonical)}) reported an error: ${WorkspaceRegistry.flattenError(error)}`,
    )
  }

  /** Log a failed live reload with the workspace identity, never the config. */
  private reportReloadError(entry: WorkspaceEntry, error: unknown): void {
    this.selfCtx.logger.warn(
      `workspace-cordis: reload of workspace ${entry.canonical} config (${workspaceConfigPath(entry.canonical)}) failed: ${WorkspaceRegistry.flattenError(error)}`,
    )
  }

  private release(entry: WorkspaceEntry): Promise<void> {
    if (entry.disposed) return Promise.resolve()
    entry.leases -= 1
    if (entry.leases > 0) return Promise.resolve()
    // Final release: mark disposed and remove from the maps first, so a
    // failed teardown still leaves the workspace retryable with a fresh scope
    // and no reload pass can publish into the dying entry; then stop the
    // reload controller — cancelling any pending debounce, closing the
    // watcher, and draining a running reload pass — before the scope (and
    // whatever subtree is still mounted) goes down. A failing stop or scope
    // disposal never skips the other side.
    entry.disposed = true
    this.entries.delete(entry.canonical)
    this.scopeRoots.delete(entry.key)
    return this.disposeEntry(entry)
  }
}
