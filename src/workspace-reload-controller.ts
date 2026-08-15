/**
 * Standalone watcher + reload controller for one top-level Cordis config file.
 *
 * The controller owns exactly one watcher and accepts only `add`, `change`,
 * and `unlink` events for exactly one absolute target path (the workspace's
 * top-level `cordis.yml`). Event bursts are debounced and reload passes are
 * serialized, so two passes of one controller never overlap. Events that
 * arrive while a pass is running are coalesced into exactly one following
 * pass; the chain repeats that rule, so a controller under continuous edits
 * keeps catching up until one pass completes with no new events.
 *
 * ## Watch anchor
 *
 * By default the controller watches the exact target path (the Block A
 * behavior). The owner may pass `watchAnchor` — an already-existing directory
 * that the watcher is attached to instead — while the controller still only
 * accepts events for the exact target path. This exists because chokidar v4
 * cannot reliably report the later creation of a nested path that did not
 * exist when watching started: its parent-retry bookkeeping only works for
 * the file's own directory, and when `<workspace>/.dsh/` itself is missing
 * the retried watch is handed a `target` that permanently suppresses the
 * config file's `add` event. Anchoring on the canonical workspace root (which
 * always exists — the registry only acquires existing directories) means
 * `.dsh/` and the config file are discovered as ordinary directory additions
 * and reliably reported. The default watch options keep that anchor cheap:
 * `depth: 2` bounds recursion to `.dsh/`'s direct children and the `ignored`
 * predicate excludes every path except `.dsh` and the target file, so the
 * watcher never scans or watches the rest of the project tree.
 *
 * ## Readiness and activation
 *
 * Chokidar attaches its `fs.watch` listeners during the initial scan and
 * emits `ready` when the scan completes. Events before `ready` are delivered
 * to the controller but only mark it dirty — no debounce timer is armed while
 * the status is `starting` — so an owner that must perform its own strict
 * initial read (the registry's initial mount) can `await ready` first, read
 * and mount the current file, and only then call `activate()`. Activation
 * replays the dirty flag: exactly one following pass runs if events arrived
 * before or during the owner's initial read, and the pass itself re-stats the
 * file, so an event that predates the owner's read is recognized as a no-op
 * (the owner already mounted the current content) and does not force a
 * pointless second mount. `ready` rejects when the watcher errors before
 * becoming ready, or when `stop()` is called first, so a strict initial
 * acquire can fail cleanly on watcher startup failure.
 *
 * The controller is deliberately framework-free: it knows nothing about
 * Cordis, the workspace registry, MCP, or presets. The owner supplies the
 * reload callback and optional diagnostic hooks; the watcher factory and the
 * timer are injectable so deterministic tests can drive a fake watcher and
 * fire debounce timers manually. The default factory is chokidar v4's
 * `watch()` with `ignoreInitial: true`. Factories must emit `ready`
 * asynchronously (never synchronously from inside the factory call), because
 * the controller subscribes to watcher events only after the factory returns.
 *
 * Lifecycle: construction immediately creates the watcher (a throwing factory
 * propagates out of the constructor and leaks nothing). `stop()` is async and
 * idempotent: it marks the controller stopped, cancels any pending debounce,
 * closes the watcher, awaits the running pass (which is allowed to finish but
 * never starts a following pass), and only then reports `stopped`.
 *
 * @module dsh-workspace-overlay/workspace-reload-controller
 */
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { watch } from 'chokidar'
import { dirname, isAbsolute, normalize } from 'node:path'

/** Lifecycle status of one reload controller. */
export type WorkspaceReloadStatus =
  /**
   * The watcher was created but has not emitted `ready` yet (or the owner has
   * not called `activate()`). Events only mark the controller dirty; no pass
   * can run and no debounce timer is armed.
   */
  | 'starting'
  /** Watcher active and no work pending. */
  | 'idle'
  /** A debounce timer is armed and waiting out the current event burst. */
  | 'scheduled'
  /** A reload pass is running or a following pass is already queued. */
  | 'reloading'
  /** The last pass rejected and no work is pending; the next event retries. */
  | 'failed'
  /** `stop()` has settled: no events are accepted and nothing is pending. */
  | 'stopped'

/** Read-only debug snapshot of one controller. */
export interface WorkspaceReloadSnapshot {
  /**
   * True from construction until `stop()` settles. The underlying watcher may
   * not have emitted `ready` yet; watching only reflects controller state.
   */
  readonly watching: boolean
  readonly status: WorkspaceReloadStatus
  /** Number of reload passes that resolved without rejecting. */
  readonly successfulReloads: number
}

/**
 * Optional diagnostic reporting hooks. Every hook is best-effort: a throwing
 * reporter is contained and never breaks the controller or the watcher.
 */
export interface WorkspaceReloadDiagnostics {
  /**
   * Report a watcher-level error (including a failed `close()`). The
   * controller keeps running and does not change status. When the error
   * arrives before `ready`, `ready` rejects with it instead.
   */
  onWatcherError?(error: unknown): void
  /**
   * Report a reload pass rejection. The rejection is already contained; the
   * controller stays alive and the next file event retries.
   */
  onReloadError?(error: unknown): void
}

/**
 * The minimal watcher surface the controller drives. Narrower than chokidar's
 * full `FSWatcher` so tests can substitute a fake without pulling chokidar in.
 * Factories must emit `ready` asynchronously, after the controller has
 * subscribed to it.
 */
export interface WorkspaceWatcher {
  on(event: 'add' | 'change' | 'unlink', listener: (path: string) => void): unknown
  on(event: 'ready', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  /** Close the watcher and release its resources; resolves once closed. */
  close(): Promise<void>
}

/**
 * Options the controller passes to its watch factory. The defaults keep the
 * watch scope bounded when the factory is chokidar v4: `depth` caps directory
 * recursion below the watch anchor and `ignored` excludes every path except
 * the `.dsh` directory and the exact target file, so scanning and watching
 * never extend into the rest of the project tree.
 */
export interface WorkspaceWatchOptions {
  /** Do not report files that already exist when watching starts. */
  ignoreInitial: boolean
  /**
   * Maximum directory recursion depth below the watch anchor
   * (0 = the anchor itself). `<anchor>/.dsh/cordis.yml` sits at depth 2.
   */
  depth: number
  /** Exclude paths from scanning and watching; the target is never excluded. */
  ignored: (path: string) => boolean
  /** Normalize editor atomic-write unlink/add pairs (chokidar `atomic`). */
  atomic: boolean
  /** Wait for writes to settle before emitting add/change (chokidar). */
  awaitWriteFinish?: boolean | { stabilityThreshold: number; pollInterval: number }
}

/**
 * Injectable watcher creation. The controller passes the watch anchor (the
 * exact target path when no anchor is configured) and the bounded watch
 * options; the default factory is chokidar's `watch()`. A throwing factory
 * propagates out of the constructor and leaks nothing.
 */
export type WorkspaceWatchFactory = (
  path: string,
  options: WorkspaceWatchOptions,
) => WorkspaceWatcher

/** Minimal timer seam; the default wraps the global `setTimeout`/`clearTimeout`. */
export interface WorkspaceTimer {
  /** Schedule `fn` after `ms` milliseconds; returns an opaque cancel handle. */
  setTimeout(fn: () => void, ms: number): unknown
  /** Cancel a scheduled callback. */
  clearTimeout(handle: unknown): void
}

/** Construction parameters for {@link WorkspaceReloadController}. */
export interface WorkspaceReloadControllerOptions {
  /**
   * Absolute path of the single top-level config file to watch. Only
   * `add`/`change`/`unlink` events for this exact string are accepted.
   */
  path: string
  /**
   * Optional absolute directory the watcher is attached to instead of the
   * target path. Events are still filtered to the exact target path; the
   * anchor exists so a not-yet-existing config file (or a missing `.dsh/`
   * directory) is discovered when it appears. Defaults to `path`.
   */
  watchAnchor?: string
  /**
   * Debounce interval in milliseconds for event bursts. Must be a non-negative
   * finite integer no greater than `MAX_TIMER_DELAY_MS`.
   */
  debounceMs: number
  /** The reload pass. Runs at most once at a time; must never overlap itself. */
  reload: () => Promise<void>
  /** Optional diagnostic reporting hooks. */
  diagnostics?: WorkspaceReloadDiagnostics
  /** Injectable watcher factory, for deterministic tests. */
  watchFactory?: WorkspaceWatchFactory
  /** Injectable timer, for deterministic tests. */
  timer?: WorkspaceTimer
}

/** The default watch factory: chokidar v4 `watch()` on the anchor path. */
const chokidarWatch: WorkspaceWatchFactory = (path, options) => watch(path, options)

/** The default timer seam wrapping the process-global timers. */
const defaultTimer: WorkspaceTimer = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as NodeJS.Timeout),
}

function validatePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('workspace-reload-controller: path must be a non-empty string')
  }
  if (!isAbsolute(path)) {
    throw new TypeError(`workspace-reload-controller: path must be absolute: ${path}`)
  }
}

function validateDebounceMs(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `workspace-reload-controller: debounceMs must be a non-negative integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
}

/**
 * Normalize a path the way chokidar's `anymatch` does before handing it to an
 * `ignored` matcher (sysPath.normalize + forward slashes), so the predicate's
 * exact comparisons stay correct on every platform.
 */
function normalizeWatchPath(path: string): string {
  const normalized = normalize(path).replace(/\\/g, '/')
  // Mirror chokidar's collapse of duplicated separators.
  return normalized.replace(/\/+/g, '/')
}

/**
 * Watches one exact config path and runs serialized, debounced reload passes.
 *
 * Event flow: an accepted `add`/`change`/`unlink` arms (or restarts) the
 * debounce timer and reports `scheduled`; when the timer fires the controller
 * reports `reloading` and appends one pass to an internal chain, so passes
 * never overlap. Events arriving while a pass runs set a dirty flag; when the
 * pass settles, exactly one following pass runs and clears the flag, and any
 * events that arrived during that pass repeat the rule. While the status is
 * `starting` (before `ready`/`activate()`), events only set the dirty flag:
 * the owner's strict initial read happens first and `activate()` replays the
 * flag as exactly one scheduled pass.
 *
 * A rejected pass is contained and reported through
 * {@link WorkspaceReloadDiagnostics.onReloadError}, the status becomes
 * `failed` (until the next event schedules a retry), and the watcher stays
 * active. A watcher `error` event is reported but never terminates the
 * controller; before `ready`, it also rejects `ready` so a strict initial
 * acquire can fail cleanly.
 */
export class WorkspaceReloadController {
  /** The exact watched path; only events for this path are accepted. */
  readonly path: string
  /** The directory the watcher is attached to (the target when no anchor). */
  readonly watchAnchor: string
  /**
   * Resolves when the watcher reports `ready`. Rejects with the watcher error
   * when an `error` event arrives before `ready`, or when `stop()` is called
   * before `ready`. Resolved-or-rejected exactly once.
   */
  readonly ready: Promise<void>

  private readonly debounceMs: number
  private readonly reload: () => Promise<void>
  private readonly diagnostics: WorkspaceReloadDiagnostics
  private readonly watcher: WorkspaceWatcher
  private readonly timer: WorkspaceTimer

  private status: WorkspaceReloadStatus = 'starting'
  private successfulReloads = 0
  /** An event arrived while starting or reloading; one following pass is due. */
  private dirty = false
  private stopped = false
  /** True only after `stop()` has fully settled. */
  private settled = false
  /** True once `activate()` was called; events may then arm the debounce. */
  private activated = false
  /** True once the watcher emitted `ready` (or the readiness failed). */
  private readySettled = false
  private readyFailed = false
  private readonly resolveReady: () => void
  private readonly rejectReady: (error: unknown) => void
  private timerHandle: unknown = undefined
  /** Serializes all passes; `stop()` awaits it to drain controller work. */
  private chain: Promise<void> = Promise.resolve()
  private stopPromise: Promise<void> | undefined

  constructor(options: WorkspaceReloadControllerOptions) {
    validatePath(options.path)
    if (options.watchAnchor !== undefined) validatePath(options.watchAnchor)
    validateDebounceMs(options.debounceMs)
    if (typeof options.reload !== 'function') {
      throw new TypeError('workspace-reload-controller: reload must be a function')
    }
    this.path = options.path
    this.watchAnchor = options.watchAnchor ?? options.path
    this.debounceMs = options.debounceMs
    this.reload = options.reload
    this.diagnostics = options.diagnostics ?? {}
    this.timer = options.timer ?? defaultTimer
    let settleReady!: (error?: unknown) => void
    this.ready = new Promise<void>((resolve, reject) => {
      settleReady = (error?: unknown) => {
        if (error === undefined) resolve()
        else reject(error)
      }
    })
    // Mark the readiness promise handled even when a standalone owner stops
    // without awaiting it; callers that do await `ready` still observe the
    // original rejection, while startup errors never become process-level
    // unhandled rejections.
    void this.ready.catch(() => {})
    this.resolveReady = () => settleReady()
    this.rejectReady = (error) => settleReady(error)
    // The `.dsh` directory, the exact target, and the anchor itself are the
    // only paths ever scanned or watched; everything else under the anchor is
    // excluded, so the watcher never recurses into the project tree. The
    // anchor must be exempt too: chokidar v4 applies `ignored` to the path
    // passed to `watch()` itself, and ignoring it would watch nothing.
    const dshDir = normalizeWatchPath(dirname(this.path))
    const target = normalizeWatchPath(this.path)
    const anchor = normalizeWatchPath(this.watchAnchor)
    const factory = options.watchFactory ?? chokidarWatch
    // A throwing factory propagates out of the constructor. Nothing has been
    // allocated yet (no timer, no listeners, no external watcher), so nothing
    // can leak. The factory must emit `ready` asynchronously — the listeners
    // below are only attached after it returns.
    this.watcher = factory(this.watchAnchor, {
      ignoreInitial: true,
      depth: 2,
      atomic: true,
      ignored: (candidate) => {
        const normalized = normalizeWatchPath(candidate)
        return normalized !== dshDir && normalized !== target && normalized !== anchor
      },
    })
    this.watcher.on('add', (path) => this.handleEvent(path))
    this.watcher.on('change', (path) => this.handleEvent(path))
    this.watcher.on('unlink', (path) => this.handleEvent(path))
    this.watcher.on('ready', () => this.handleReady())
    this.watcher.on('error', (error) => this.handleWatcherError(error))
  }

  /** Read-only debug snapshot of the controller's current state. */
  snapshot(): WorkspaceReloadSnapshot {
    return {
      watching: !this.settled,
      status: this.status,
      successfulReloads: this.successfulReloads,
    }
  }

  /**
   * Begin accepting event-driven passes. Call only after `ready` has settled
   * (the owner's strict initial read runs between `await ready` and this
   * call). Events received before activation only marked the controller
   * dirty; activation replays that flag as exactly one debounced pass, which
   * the owner's reload pass may recognize as a no-op. Idempotent.
   */
  activate(): void {
    if (this.stopped || this.activated) return
    this.activated = true
    if (this.readySettled && !this.readyFailed) this.applyPending()
  }

  /**
   * Stop the controller. Idempotent: every call returns the same settlement.
   *
   * Marks the controller stopped (no further events are accepted), cancels
   * any pending debounce timer, closes the watcher, and awaits the current
   * reload pass (if any), which is allowed to finish but never triggers a
   * following pass. The final snapshot reports `watching: false` and
   * `status: 'stopped'`. If the timer never fired, the reload callback never
   * runs. If `ready` had not settled yet, it rejects with a stop error so no
   * awaiting owner hangs. A failing `close()` is reported as a watcher error;
   * `stop()` still settles.
   */
  stop(): Promise<void> {
    if (this.stopPromise === undefined) {
      this.stopPromise = this.settle()
    }
    return this.stopPromise
  }

  private async settle(): Promise<void> {
    this.stopped = true
    this.dirty = false
    this.clearTimer()
    if (!this.readySettled) {
      this.readySettled = true
      this.readyFailed = true
      this.rejectReady(
        new Error('workspace-reload-controller: stopped before the watcher became ready'),
      )
    }
    try {
      await this.watcher.close()
    } catch (error) {
      // A close failure is reported like any watcher error; stop still
      // settles and the watcher is treated as closed either way.
      this.reportWatcherError(error)
    }
    // The running pass (if any) finishes first; its continuation observes
    // `stopped` and never starts a following pass, so the chain cannot grow.
    try {
      await this.chain
    } catch (error) {
      // Defensive: the pass bodies are fully guarded, so the chain never
      // rejects; if it ever did, report and still settle to `stopped` rather
      // than leaving stop() itself rejected.
      this.reportReloadError(error)
    }
    this.status = 'stopped'
    this.settled = true
  }

  private handleReady(): void {
    if (this.stopped || this.readySettled) return
    this.readySettled = true
    this.resolveReady()
    if (this.activated) this.applyPending()
  }

  /** Replay the pre-activation dirty flag as exactly one scheduled pass. */
  private applyPending(): void {
    if (this.dirty) {
      this.dirty = false
      this.status = 'scheduled'
      this.armDebounce()
      return
    }
    this.status = 'idle'
  }

  private handleEvent(path: string): void {
    if (this.stopped) return
    // Only the exact watched path counts; anything else (other files, other
    // event sources) is ignored.
    if (path !== this.path) return
    if (this.status === 'starting' || this.status === 'reloading') {
      // Starting: the owner's strict initial read has not happened yet, so
      // events only mark the controller dirty and `activate()` replays them.
      // Reloading: a pass is running or queued: coalesce into exactly one
      // following pass.
      this.dirty = true
      return
    }
    this.status = 'scheduled'
    this.armDebounce()
  }

  private handleWatcherError(error: unknown): void {
    if (this.stopped) return
    this.reportWatcherError(error)
    if (!this.readySettled) {
      // A startup failure rejects the readiness gate so a strict initial
      // acquire can fail cleanly; the watcher may keep running, but no pass
      // will ever be scheduled on it.
      this.readySettled = true
      this.readyFailed = true
      this.rejectReady(error)
    }
  }

  /** (Re)arm the debounce timer; each event restarts the quiet window. */
  private armDebounce(): void {
    this.clearTimer()
    const handle = this.timer.setTimeout(() => {
      this.timerHandle = undefined
      // Work is now underway even though the pass body runs on the chain in a
      // microtask; `scheduled` is only for an armed, waiting timer.
      this.status = 'reloading'
      this.enqueuePass()
    }, this.debounceMs)
    this.timerHandle = handle
  }

  private clearTimer(): void {
    if (this.timerHandle !== undefined) {
      this.timer.clearTimeout(this.timerHandle)
      this.timerHandle = undefined
    }
  }

  /**
   * Append one reload pass to the serialization chain. The pass body is fully
   * guarded, so the chain itself never rejects and no unhandled rejection can
   * escape the controller.
   */
  private enqueuePass(): void {
    this.chain = this.chain.then(async () => {
      if (this.stopped) return
      this.status = 'reloading'
      let ok = false
      try {
        await this.reload()
        ok = true
      } catch (error) {
        this.reportReloadError(error)
      }
      // A pass that ran to completion counts even when stop() was requested
      // while it was in flight; stop() only suppresses status changes and the
      // following pass.
      if (ok) this.successfulReloads += 1
      if (this.stopped) return
      if (this.dirty) {
        // Events arrived while this pass ran: run exactly one following pass
        // that applies the same rule to its own events. The status stays
        // `reloading` until the whole episode settles.
        this.dirty = false
        this.enqueuePass()
        return
      }
      this.status = ok ? 'idle' : 'failed'
    })
  }

  private reportWatcherError(error: unknown): void {
    try {
      this.diagnostics.onWatcherError?.(error)
    } catch {
      // Diagnostics are best-effort; a throwing reporter must not break the
      // controller or the watcher loop.
    }
  }

  private reportReloadError(error: unknown): void {
    try {
      this.diagnostics.onReloadError?.(error)
    } catch {
      // As above: the rejection is already contained; reporting is best-effort.
    }
  }
}
