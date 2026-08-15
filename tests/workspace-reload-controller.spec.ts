/**
 * Deterministic unit tests for `WorkspaceReloadController`.
 *
 * No real watcher and no file I/O: the watch factory is a fake that records
 * its creation arguments and lets tests emit `add`/`change`/`unlink`/
 * `ready`/`error` events by hand, and the timer is a manual fake whose
 * callbacks tests fire explicitly. Reload passes are deferred promises the
 * tests resolve/reject, so timing is fully controlled. The fake emits
 * `ready` on a microtask after creation (mirroring chokidar's async ready),
 * and `activate()` is called once ready settles, so the common helper yields
 * a fully activated controller; tests that need the pre-ready or
 * pre-activation state use the raw constructor helper.
 */
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WorkspaceReloadController,
  type WorkspaceReloadControllerOptions,
  type WorkspaceReloadDiagnostics,
  type WorkspaceReloadSnapshot,
  type WorkspaceTimer,
  type WorkspaceWatcher,
  type WorkspaceWatchOptions,
} from '../src/workspace-reload-controller.js'

type WatchEvent = 'add' | 'change' | 'unlink'

/** The single config path every controller watches in these tests. */
const CONFIG_PATH = '/workspaces/demo/.dsh/cordis.yml'

/** A watcher that never touches the filesystem; events are emitted by hand. */
class FakeWatcher implements WorkspaceWatcher {
  private readonly pathListeners = new Map<WatchEvent, Set<(path: string) => void>>()
  private readonly readyListeners = new Set<() => void>()
  private readonly errorListeners = new Set<(error: unknown) => void>()
  closeCalls = 0
  failCloseWith: Error | undefined

  on(event: WatchEvent, listener: (path: string) => void): unknown
  on(event: 'ready', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  on(event: WatchEvent | 'ready' | 'error', listener: ((path: string) => void) | (() => void) | ((error: unknown) => void)): unknown {
    if (event === 'error') {
      this.errorListeners.add(listener as (error: unknown) => void)
      return this
    }
    if (event === 'ready') {
      this.readyListeners.add(listener as () => void)
      return this
    }
    let set = this.pathListeners.get(event)
    if (!set) {
      set = new Set()
      this.pathListeners.set(event, set)
    }
    set.add(listener as (path: string) => void)
    return this
  }

  emit(event: WatchEvent, path: string): void {
    for (const listener of this.pathListeners.get(event) ?? []) listener(path)
  }

  emitReady(): void {
    for (const listener of this.readyListeners) listener()
  }

  emitError(error: unknown): void {
    for (const listener of this.errorListeners) listener(error)
  }

  close(): Promise<void> {
    this.closeCalls += 1
    if (this.failCloseWith !== undefined) return Promise.reject(this.failCloseWith)
    return Promise.resolve()
  }
}

/** Records creation arguments and hands out fake watchers. */
class FakeWatchFactory {
  readonly calls: Array<{ path: string; options: WorkspaceWatchOptions }> = []
  readonly watchers: FakeWatcher[] = []
  failWith: Error | undefined
  /** Emit a watcher error instead of ready on creation (startup failure). */
  failReadyWith: Error | undefined
  /** Do not auto-emit ready; the test drives readiness by hand. */
  suppressReady = false

  create = (path: string, options: WorkspaceWatchOptions): FakeWatcher => {
    this.calls.push({ path, options })
    if (this.failWith !== undefined) throw this.failWith
    const watcher = new FakeWatcher()
    this.watchers.push(watcher)
    if (!this.suppressReady) {
      // Ready arrives asynchronously, after the controller subscribed.
      queueMicrotask(() => {
        if (this.failReadyWith !== undefined) watcher.emitError(this.failReadyWith)
        else watcher.emitReady()
      })
    }
    return watcher
  }

  get watcher(): FakeWatcher {
    const watcher = this.watchers.at(-1)
    if (!watcher) throw new Error('fake factory created no watcher')
    return watcher
  }
}

/** Timers never run on their own; tests fire pending callbacks explicitly. */
class ManualTimer implements WorkspaceTimer {
  private nextHandle = 1
  private readonly pending = new Map<number, () => void>()
  readonly scheduledMs: number[] = []

  setTimeout(fn: () => void, ms: number): unknown {
    this.scheduledMs.push(ms)
    const handle = this.nextHandle++
    this.pending.set(handle, fn)
    return handle
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number)
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /** Run every pending callback (insertion order) and clear the queue. */
  fire(): void {
    const callbacks = [...this.pending.values()]
    this.pending.clear()
    for (const callback of callbacks) callback()
  }
}

/** A reload pass whose settlement the test controls. */
interface DeferredReload {
  calls: number
  resolvers: Array<() => void>
  rejectors: Array<(error: unknown) => void>
  fn: () => Promise<void>
}

function deferredReload(): DeferredReload {
  const state: DeferredReload = {
    calls: 0,
    resolvers: [],
    rejectors: [],
    fn: () => {
      state.calls += 1
      return new Promise<void>((resolve, reject) => {
        state.resolvers.push(resolve)
        state.rejectors.push(reject)
      })
    },
  }
  return state
}

/** Drain microtasks so queued pass bodies (promise chains) run to completion. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

let factory: FakeWatchFactory
let timer: ManualTimer
let reload: ReturnType<typeof vi.fn>
let diagnostics: WorkspaceReloadDiagnostics
let controllers: WorkspaceReloadController[]

/** Create a controller WITHOUT awaiting ready or activating it. */
function createRawController(
  overrides: Partial<WorkspaceReloadControllerOptions> = {},
): WorkspaceReloadController {
  const controller = new WorkspaceReloadController({
    path: CONFIG_PATH,
    debounceMs: 150,
    reload,
    diagnostics,
    watchFactory: factory.create,
    timer,
    ...overrides,
  })
  controllers.push(controller)
  return controller
}

/** Create a controller, await its readiness, and activate it. */
async function createController(
  overrides: Partial<WorkspaceReloadControllerOptions> = {},
): Promise<WorkspaceReloadController> {
  const controller = createRawController(overrides)
  await controller.ready
  controller.activate()
  return controller
}

beforeEach(() => {
  factory = new FakeWatchFactory()
  timer = new ManualTimer()
  reload = vi.fn(async () => {})
  diagnostics = {}
  controllers = []
})

afterEach(async () => {
  // Stop every controller created in the test; stop() is idempotent, so
  // already-stopped controllers settle immediately.
  await Promise.all(controllers.map((controller) => controller.stop()))
})

describe('WorkspaceReloadController', () => {
  describe('construction', () => {
    it('creates one watcher for the exact path with bounded options and starts starting', () => {
      const controller = createRawController()

      expect(factory.calls).toHaveLength(1)
      expect(factory.calls[0]!.path).toBe(CONFIG_PATH)
      expect(factory.calls[0]!.options).toMatchObject({
        ignoreInitial: true,
        depth: 2,
        atomic: true,
      })
      expect(typeof factory.calls[0]!.options.ignored).toBe('function')
      expect(factory.watchers).toHaveLength(1)
      // Before the watcher reports ready the controller is `starting`; the
      // fake emits ready on a microtask.
      expect(controller.snapshot()).toEqual({
        watching: true,
        status: 'starting',
        successfulReloads: 0,
      } satisfies WorkspaceReloadSnapshot)
    })

    it('transitions to idle once ready settles and activate() runs', async () => {
      const controller = await createController()

      expect(controller.snapshot()).toEqual({
        watching: true,
        status: 'idle',
        successfulReloads: 0,
      } satisfies WorkspaceReloadSnapshot)
    })

    it('watches a configured anchor while still filtering events to the exact target', async () => {
      const controller = await createController({ watchAnchor: '/workspaces/demo' })

      expect(factory.calls[0]!.path).toBe('/workspaces/demo')
      // Events for the exact target are accepted; anything else under the
      // anchor (and any other config path) is ignored.
      factory.watcher.emit('change', CONFIG_PATH)
      factory.watcher.emit('change', '/workspaces/demo/src/main.ts')
      factory.watcher.emit('change', '/workspaces/demo/.dsh/agent.cordis.yml')
      factory.watcher.emit('change', '/workspaces/other/.dsh/cordis.yml')
      expect(timer.pendingCount).toBe(1)
      expect(controller.snapshot().status).toBe('scheduled')
    })

    it('scopes the ignored predicate to .dsh, the anchor, and the exact target', async () => {
      await createController({ watchAnchor: '/workspaces/demo' })
      const ignored = factory.calls[0]!.options.ignored

      // The watch anchor, the .dsh directory, and the config file are kept.
      expect(ignored('/workspaces/demo')).toBe(false)
      expect(ignored('/workspaces/demo/.dsh')).toBe(false)
      expect(ignored(CONFIG_PATH)).toBe(false)
      // Everything else is excluded from scanning and watching: other project
      // files, .dsh contents other than the config, and other workspaces.
      expect(ignored('/workspaces/demo/package.json')).toBe(true)
      expect(ignored('/workspaces/demo/src')).toBe(true)
      expect(ignored('/workspaces/demo/.dsh/plugins')).toBe(true)
      expect(ignored('/workspaces/demo/.dsh/agent.cordis.yml')).toBe(true)
      expect(ignored('/workspaces/other/.dsh/cordis.yml')).toBe(true)
    })

    it('accepts a zero debounce window', async () => {
      const controller = await createController({ debounceMs: 0 })
      factory.watcher.emit('change', CONFIG_PATH)
      expect(controller.snapshot().status).toBe('scheduled')
    })

    it.each([
      ['a non-string path', { path: 42 }],
      ['an empty path', { path: '' }],
      ['a relative path', { path: 'relative/.dsh/cordis.yml' }],
      ['a relative watchAnchor', { watchAnchor: 'relative/root' }],
      ['a negative debounceMs', { debounceMs: -1 }],
      ['a fractional debounceMs', { debounceMs: 0.5 }],
      ['a NaN debounceMs', { debounceMs: Number.NaN }],
      ['an infinite debounceMs', { debounceMs: Number.POSITIVE_INFINITY }],
      ['an oversized debounceMs', { debounceMs: MAX_TIMER_DELAY_MS + 1 }],
    ] as Array<[string, Record<string, unknown>]>)(
      'rejects %s before touching the factory',
      (_label, overrides) => {
        expect(() => {
          // The overrides deliberately violate the option types; the cast
          // marks this as the invalid-input path it is.
          new WorkspaceReloadController({
            path: CONFIG_PATH,
            debounceMs: 150,
            reload,
            watchFactory: factory.create,
            timer,
            ...overrides,
          } as unknown as WorkspaceReloadControllerOptions)
        }).toThrow(TypeError)
        expect(factory.calls).toHaveLength(0)
        expect(timer.pendingCount).toBe(0)
      },
    )

    it('rejects a missing reload callback', () => {
      expect(() => {
        new WorkspaceReloadController({
          path: CONFIG_PATH,
          debounceMs: 150,
          reload: undefined as never,
          watchFactory: factory.create,
          timer,
        })
      }).toThrow(TypeError)
      expect(factory.calls).toHaveLength(0)
    })

    it('propagates a throwing watch factory without leaking anything', () => {
      const boom = new Error('watch creation failed')
      factory.failWith = boom

      expect(() => createRawController()).toThrow(boom)
      // No watcher was handed out and no timer was armed: nothing to stop.
      expect(factory.watchers).toHaveLength(0)
      expect(timer.pendingCount).toBe(0)
    })
  })

  describe('event acceptance', () => {
    it.each(['add', 'change', 'unlink'] as const)(
      'schedules exactly one reload after %s',
      async (event) => {
        const controller = await createController()

        factory.watcher.emit(event, CONFIG_PATH)
        expect(controller.snapshot().status).toBe('scheduled')
        expect(reload).not.toHaveBeenCalled()

        timer.fire()
        expect(controller.snapshot().status).toBe('reloading')
        await tick()
        expect(reload).toHaveBeenCalledTimes(1)
        expect(controller.snapshot()).toEqual({
          watching: true,
          status: 'idle',
          successfulReloads: 1,
        })
      },
    )

    it('ignores events for other paths', async () => {
      const controller = await createController()

      for (const event of ['add', 'change', 'unlink'] as const) {
        factory.watcher.emit(event, '/workspaces/demo/.dsh/agent.cordis.yml')
        factory.watcher.emit(event, '/workspaces/other/.dsh/cordis.yml')
      }

      expect(timer.pendingCount).toBe(0)
      expect(reload).not.toHaveBeenCalled()
      expect(controller.snapshot()).toEqual({
        watching: true,
        status: 'idle',
        successfulReloads: 0,
      })
    })

    it('ignores events after stop', async () => {
      const controller = await createController()
      await controller.stop()

      factory.watcher.emit('change', CONFIG_PATH)
      await tick()
      expect(reload).not.toHaveBeenCalled()
      expect(controller.snapshot().status).toBe('stopped')
    })
  })

  describe('readiness and activation', () => {
    it('never arms the debounce while starting: pre-ready events only mark dirty', async () => {
      factory.suppressReady = true
      const controller = createRawController()

      factory.watcher.emit('change', CONFIG_PATH)
      factory.watcher.emit('unlink', CONFIG_PATH)
      expect(controller.snapshot().status).toBe('starting')
      expect(timer.pendingCount).toBe(0)
      expect(reload).not.toHaveBeenCalled()

      factory.watcher.emitReady()
      await controller.ready
      controller.activate()
      // The replayed dirty flag becomes exactly one scheduled pass.
      expect(controller.snapshot().status).toBe('scheduled')
      expect(timer.pendingCount).toBe(1)
      timer.fire()
      await tick()
      expect(reload).toHaveBeenCalledTimes(1)
    })

    it('rejects ready on a watcher error before ready and stays stoppable', async () => {
      const boom = new Error('watcher startup failed')
      factory.failReadyWith = boom
      const onWatcherError = vi.fn()
      const controller = createRawController({ diagnostics: { onWatcherError } })

      await expect(controller.ready).rejects.toBe(boom)
      expect(onWatcherError).toHaveBeenCalledWith(boom)
      // No pass is ever scheduled on a failed watcher.
      factory.watcher.emit('change', CONFIG_PATH)
      expect(timer.pendingCount).toBe(0)
      await controller.stop()
      expect(controller.snapshot().status).toBe('stopped')
    })

    it('rejects ready when stopped before the watcher became ready', async () => {
      factory.suppressReady = true
      const controller = createRawController()

      const stopping = controller.stop()
      await expect(controller.ready).rejects.toThrow(/stopped before the watcher became ready/)
      await stopping
      expect(controller.snapshot()).toEqual({
        watching: false,
        status: 'stopped',
        successfulReloads: 0,
      })
      expect(factory.watcher.closeCalls).toBe(1)
      // Events after stop are ignored even once ready would have arrived.
      factory.watcher.emitReady()
      factory.watcher.emit('change', CONFIG_PATH)
      await tick()
      expect(reload).not.toHaveBeenCalled()
    })

    it('keeps the dirty flag across a late ready when activate ran first', async () => {
      factory.suppressReady = true
      const controller = createRawController()
      factory.watcher.emit('change', CONFIG_PATH)
      controller.activate()
      expect(controller.snapshot().status).toBe('starting')

      factory.watcher.emitReady()
      await controller.ready
      await tick()
      expect(controller.snapshot().status).toBe('scheduled')
      timer.fire()
      await tick()
      expect(reload).toHaveBeenCalledTimes(1)
      expect(controller.snapshot().status).toBe('idle')
    })

    it('activate is idempotent and never double-arms the debounce', async () => {
      const controller = await createController()
      controller.activate()
      controller.activate()
      expect(controller.snapshot().status).toBe('idle')
      expect(timer.pendingCount).toBe(0)

      factory.watcher.emit('change', CONFIG_PATH)
      expect(timer.pendingCount).toBe(1)
      controller.activate()
      expect(timer.pendingCount).toBe(1)
    })
  })

  describe('debounce and serialization', () => {
    it('coalesces a burst of events into one pass, restarting the timer each time', async () => {
      const controller = await createController()

      for (let i = 0; i < 5; i++) {
        factory.watcher.emit('change', CONFIG_PATH)
      }

      // Every event re-armed the single debounce timer.
      expect(timer.scheduledMs).toEqual([150, 150, 150, 150, 150])
      expect(timer.pendingCount).toBe(1)
      timer.fire()
      await tick()
      expect(reload).toHaveBeenCalledTimes(1)
      expect(controller.snapshot().successfulReloads).toBe(1)
    })

    it('never runs passes concurrently', async () => {
      let running = 0
      let peak = 0
      const resolvers: Array<() => void> = []
      const runPass = vi.fn(() => {
        running += 1
        peak = Math.max(peak, running)
        return new Promise<void>((resolve) => {
          resolvers.push(() => {
            running -= 1
            resolve()
          })
        })
      })
      const controller = await createController({ reload: runPass })

      factory.watcher.emit('change', CONFIG_PATH)
      timer.fire()
      await tick()
      expect(runPass).toHaveBeenCalledTimes(1)

      // Events during the pass never arm a second timer.
      for (let i = 0; i < 3; i++) factory.watcher.emit('change', CONFIG_PATH)
      expect(timer.pendingCount).toBe(0)
      timer.fire()
      await tick()
      expect(runPass).toHaveBeenCalledTimes(1)

      resolvers[0]!()
      await tick()
      expect(runPass).toHaveBeenCalledTimes(2)
      expect(peak).toBe(1)

      resolvers[1]!()
      await tick()
      expect(peak).toBe(1)
      expect(controller.snapshot().status).toBe('idle')
    })
  })

  describe('events during a reload', () => {
    it('runs exactly one following pass and settles idle', async () => {
      const pass = deferredReload()
      const controller = await createController({ reload: pass.fn })

      factory.watcher.emit('change', CONFIG_PATH)
      timer.fire()
      await tick()
      expect(pass.calls).toBe(1)

      // Events while the pass runs coalesce into one following pass.
      factory.watcher.emit('change', CONFIG_PATH)
      factory.watcher.emit('unlink', CONFIG_PATH)
      pass.resolvers[0]!()
      await tick()
      expect(pass.calls).toBe(2)
      expect(controller.snapshot().status).toBe('reloading')

      pass.resolvers[1]!()
      await tick()
      expect(pass.calls).toBe(2)
      expect(controller.snapshot()).toEqual({
        watching: true,
        status: 'idle',
        successfulReloads: 2,
      })
    })

    it('merges events arriving during the following pass into one further pass', async () => {
      const pass = deferredReload()
      const controller = await createController({ reload: pass.fn })

      factory.watcher.emit('change', CONFIG_PATH)
      timer.fire()
      await tick()
      factory.watcher.emit('change', CONFIG_PATH)
      pass.resolvers[0]!()
      await tick()
      expect(pass.calls).toBe(2)

      // Events during the following pass produce one more pass, not one each.
      factory.watcher.emit('change', CONFIG_PATH)
      factory.watcher.emit('add', CONFIG_PATH)
      pass.resolvers[1]!()
      await tick()
      expect(pass.calls).toBe(3)

      pass.resolvers[2]!()
      await tick()
      expect(pass.calls).toBe(3)
      expect(controller.snapshot().status).toBe('idle')
      expect(controller.snapshot().successfulReloads).toBe(3)
    })
  })

  describe('failures', () => {
    it('contains and reports a reload rejection, then retries on the next event', async () => {
      const boom = new Error('mount failed')
      let shouldFail = true
      const onReloadError = vi.fn()
      const runPass = vi.fn(async () => {
        if (shouldFail) throw boom
      })
      const controller = await createController({
        reload: runPass,
        diagnostics: { onReloadError },
      })

      factory.watcher.emit('change', CONFIG_PATH)
      timer.fire()
      await tick()
      expect(onReloadError).toHaveBeenCalledTimes(1)
      expect(onReloadError).toHaveBeenCalledWith(boom)
      expect(controller.snapshot()).toEqual({
        watching: true,
        status: 'failed',
        successfulReloads: 0,
      })

      // A later event retries; the failure state is left behind.
      shouldFail = false
      factory.watcher.emit('change', CONFIG_PATH)
      expect(controller.snapshot().status).toBe('scheduled')
      timer.fire()
      await tick()
      expect(runPass).toHaveBeenCalledTimes(2)
      expect(controller.snapshot()).toEqual({
        watching: true,
        status: 'idle',
        successfulReloads: 1,
      })
    })

    it('runs the following pass after a failed pass when events arrived during it', async () => {
      const pass = deferredReload()
      const onReloadError = vi.fn()
      const controller = await createController({ reload: pass.fn, diagnostics: { onReloadError } })

      factory.watcher.emit('change', CONFIG_PATH)
      timer.fire()
      await tick()
      factory.watcher.emit('change', CONFIG_PATH)
      pass.rejectors[0]!(new Error('boom'))
      await tick()

      expect(onReloadError).toHaveBeenCalledTimes(1)
      expect(pass.calls).toBe(2)
      expect(controller.snapshot().status).toBe('reloading')

      pass.resolvers[1]!()
      await tick()
      expect(controller.snapshot().status).toBe('idle')
      expect(controller.snapshot().successfulReloads).toBe(1)
    })

    it('reports watcher errors after ready without terminating', async () => {
      const onWatcherError = vi.fn()
      const controller = await createController({ diagnostics: { onWatcherError } })
      const boom = new Error('watcher failed')

      factory.watcher.emitError(boom)
      expect(onWatcherError).toHaveBeenCalledWith(boom)
      // Ready already settled: the error must not reject it or stop work.
      await expect(controller.ready).resolves.toBeUndefined()

      // The controller stays fully functional afterwards.
      factory.watcher.emit('change', CONFIG_PATH)
      timer.fire()
      await tick()
      expect(reload).toHaveBeenCalledTimes(1)
      expect(controller.snapshot().status).toBe('idle')
    })
  })

  describe('stop', () => {
    it('cancels a pending debounce so the reload callback never runs', async () => {
      const controller = await createController()
      factory.watcher.emit('change', CONFIG_PATH)
      expect(controller.snapshot().status).toBe('scheduled')

      await controller.stop()
      expect(reload).not.toHaveBeenCalled()
      expect(timer.pendingCount).toBe(0)
      expect(controller.snapshot()).toEqual({
        watching: false,
        status: 'stopped',
        successfulReloads: 0,
      })
      expect(factory.watcher.closeCalls).toBe(1)
    })

    it('awaits a running pass but never runs the following pass', async () => {
      const pass = deferredReload()
      const controller = await createController({ reload: pass.fn })

      factory.watcher.emit('change', CONFIG_PATH)
      timer.fire()
      await tick()
      expect(pass.calls).toBe(1)

      factory.watcher.emit('change', CONFIG_PATH)
      let settled = false
      const stopping = controller.stop().then(() => {
        settled = true
      })
      await tick()
      expect(settled).toBe(false)

      // The running callback completes; the dirty following pass is dropped.
      pass.resolvers[0]!()
      await stopping
      expect(pass.calls).toBe(1)
      expect(controller.snapshot()).toEqual({
        watching: false,
        status: 'stopped',
        successfulReloads: 1,
      })
    })

    it('is idempotent and closes the watcher once', async () => {
      const controller = await createController()
      const first = controller.stop()
      const second = controller.stop()
      expect(second).toBe(first)
      await Promise.all([first, second, controller.stop()])
      expect(factory.watcher.closeCalls).toBe(1)
      expect(controller.snapshot().status).toBe('stopped')
    })

    it('reports a failing close and still settles to stopped', async () => {
      const onWatcherError = vi.fn()
      const controller = await createController({ diagnostics: { onWatcherError } })
      const boom = new Error('close failed')
      factory.watcher.failCloseWith = boom

      await controller.stop()
      expect(onWatcherError).toHaveBeenCalledWith(boom)
      expect(controller.snapshot()).toEqual({
        watching: false,
        status: 'stopped',
        successfulReloads: 0,
      })
    })
  })

  describe('snapshot', () => {
    it('tracks status transitions and successful reloads across the lifecycle', async () => {
      const pass = deferredReload()
      const onReloadError = vi.fn()
      const controller = await createController({ reload: pass.fn, diagnostics: { onReloadError } })
      const snap = () => controller.snapshot()

      expect(snap()).toEqual({ watching: true, status: 'idle', successfulReloads: 0 })

      // idle -> scheduled -> reloading -> idle (success).
      factory.watcher.emit('change', CONFIG_PATH)
      expect(snap().status).toBe('scheduled')
      timer.fire()
      expect(snap().status).toBe('reloading')
      await tick()
      pass.resolvers[0]!()
      await tick()
      expect(snap()).toEqual({ watching: true, status: 'idle', successfulReloads: 1 })

      // reloading -> failed (rejection with no pending events stays failed).
      factory.watcher.emit('change', CONFIG_PATH)
      timer.fire()
      await tick()
      pass.rejectors[1]!(new Error('boom'))
      await tick()
      expect(onReloadError).toHaveBeenCalledTimes(1)
      expect(snap()).toEqual({ watching: true, status: 'failed', successfulReloads: 1 })

      // failed -> scheduled -> reloading -> idle (retry succeeds).
      factory.watcher.emit('change', CONFIG_PATH)
      expect(snap().status).toBe('scheduled')
      timer.fire()
      await tick()
      pass.resolvers[2]!()
      await tick()
      expect(snap()).toEqual({ watching: true, status: 'idle', successfulReloads: 2 })

      // -> stopped (watching flips to false only once stop settles).
      await controller.stop()
      expect(snap()).toEqual({ watching: false, status: 'stopped', successfulReloads: 2 })
    })
  })
})
