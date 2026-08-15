/**
 * Standalone watcher + reload controller for one top-level Cordis config file.
 *
 * The controller owns exactly one watcher over exactly one absolute config
 * path (the workspace's top-level `cordis.yml`). It accepts only `add`,
 * `change`, and `unlink` events for that exact path, debounces event bursts,
 * and serializes reload passes so two passes of one controller never overlap.
 * Events that arrive while a pass is running are coalesced into exactly one
 * following pass; the chain repeats that rule, so a controller under
 * continuous edits keeps catching up until one pass completes with no new
 * events.
 *
 * The controller is deliberately framework-free: it knows nothing about
 * Cordis, the workspace registry, MCP, or presets. The owner supplies the
 * reload callback and optional diagnostic hooks; the watcher factory and the
 * timer are injectable so deterministic tests can drive a fake watcher and
 * fire debounce timers manually. The default factory is chokidar v4's
 * `watch()` with `ignoreInitial: true`.
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
import { isAbsolute } from 'node:path'

/** Lifecycle status of one reload controller. */
export type WorkspaceReloadStatus =
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
   * controller keeps running and does not change status.
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
 */
export interface WorkspaceWatcher {
  on(event: 'add' | 'change' | 'unlink', listener: (path: string) => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  /** Close the watcher and release its resources; resolves once closed. */
  close(): Promise<void>
}

/** Options the controller passes to its watch factory. */
export interface WorkspaceWatchOptions {
  /** Do not report files that already exist when watching starts. */
  ignoreInitial: boolean
}

/**
 * Injectable watcher creation. The controller passes the exact watched path
 * and `{ ignoreInitial: true }`; the default factory is chokidar's `watch()`.
 * A throwing factory propagates out of the constructor and leaks nothing.
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

/** The default watch factory: chokidar v4 `watch()` on the exact path. */
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
 * Watches one exact config path and runs serialized, debounced reload passes.
 *
 * Event flow: an accepted `add`/`change`/`unlink` arms (or restarts) the
 * debounce timer and reports `scheduled`; when the timer fires the controller
 * reports `reloading` and appends one pass to an internal chain, so passes
 * never overlap. Events arriving while a pass runs set a dirty flag; when the
 * pass settles, exactly one following pass runs and clears the flag, and any
 * events that arrived during that pass repeat the rule.
 *
 * A rejected pass is contained and reported through
 * {@link WorkspaceReloadDiagnostics.onReloadError}, the status becomes
 * `failed` (until the next event schedules a retry), and the watcher stays
 * active. A watcher `error` event is reported but never terminates the
 * controller.
 */
export class WorkspaceReloadController {
  /** The exact watched path; only events for this path are accepted. */
  readonly path: string

  private readonly debounceMs: number
  private readonly reload: () => Promise<void>
  private readonly diagnostics: WorkspaceReloadDiagnostics
  private readonly watcher: WorkspaceWatcher
  private readonly timer: WorkspaceTimer

  private status: WorkspaceReloadStatus = 'idle'
  private successfulReloads = 0
  /** An event arrived while a pass ran; exactly one following pass is due. */
  private dirty = false
  private stopped = false
  /** True only after `stop()` has fully settled. */
  private settled = false
  private timerHandle: unknown = undefined
  /** Serializes all passes; `stop()` awaits it to drain controller work. */
  private chain: Promise<void> = Promise.resolve()
  private stopPromise: Promise<void> | undefined

  constructor(options: WorkspaceReloadControllerOptions) {
    validatePath(options.path)
    validateDebounceMs(options.debounceMs)
    if (typeof options.reload !== 'function') {
      throw new TypeError('workspace-reload-controller: reload must be a function')
    }
    this.path = options.path
    this.debounceMs = options.debounceMs
    this.reload = options.reload
    this.diagnostics = options.diagnostics ?? {}
    this.timer = options.timer ?? defaultTimer
    const factory = options.watchFactory ?? chokidarWatch
    // A throwing factory propagates out of the constructor. Nothing has been
    // allocated yet (no timer, no listeners, no external watcher), so nothing
    // can leak.
    this.watcher = factory(this.path, { ignoreInitial: true })
    this.watcher.on('add', (path) => this.handleEvent(path))
    this.watcher.on('change', (path) => this.handleEvent(path))
    this.watcher.on('unlink', (path) => this.handleEvent(path))
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
   * Stop the controller. Idempotent: every call returns the same settlement.
   *
   * Marks the controller stopped (no further events are accepted), cancels
   * any pending debounce timer, closes the watcher, and awaits the current
   * reload pass (if any), which is allowed to finish but never triggers a
   * following pass. The final snapshot reports `watching: false` and
   * `status: 'stopped'`. If the timer never fired, the reload callback never
   * runs. A failing `close()` is reported as a watcher error; `stop()` still
   * settles.
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

  private handleEvent(path: string): void {
    if (this.stopped) return
    // Only the exact watched path counts; anything else (other files, other
    // event sources) is ignored.
    if (path !== this.path) return
    if (this.status === 'reloading') {
      // A pass is running or queued: coalesce into exactly one following pass.
      this.dirty = true
      return
    }
    this.status = 'scheduled'
    this.armDebounce()
  }

  private handleWatcherError(error: unknown): void {
    if (this.stopped) return
    this.reportWatcherError(error)
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
