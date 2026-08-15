/**
 * Deterministic Registry integration tests for live workspace reload.
 *
 * The registry is booted with an injected fake watch factory and a manual
 * timer — the plugin loader cannot pass constructor arguments to a class
 * plugin, so the harness constructs the registry directly on a dedicated
 * fiber when runtime seams are supplied. Tests drive file changes by writing
 * to disk (real stat/parse/import/mount) and emit watcher events by hand; no
 * real chokidar watcher is involved, which Block C's real-filesystem specs
 * cover. The fake emits `ready` on a microtask after creation, so the
 * registry's strict readiness gate (`await controller.ready` before the
 * initial stat/mount) resolves like chokidar's async ready would.
 */
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import WorkspaceRegistry, {
  defaultConfig,
  type WorkspaceRegistryConfig,
} from '../src/registry.js'
import { WorkspaceMountError } from '../src/workspace-tree.js'
import type {
  WorkspaceTimer,
  WorkspaceWatcher,
  WorkspaceWatchOptions,
} from '../src/workspace-reload-controller.js'
import {
  fixtureState,
  harness,
  makeWorkspace,
  markerRow,
  resetFixtures,
  seedPlugins,
  teardown,
  writeConfig,
  type Harness,
} from './helpers.js'

type WatchEvent = 'add' | 'change' | 'unlink'

/** A watcher that never touches the filesystem; events are emitted by hand. */
class FakeWatcher implements WorkspaceWatcher {
  private readonly pathListeners = new Map<WatchEvent, Set<(path: string) => void>>()
  private readonly readyListeners = new Set<() => void>()
  private readonly errorListeners = new Set<(error: unknown) => void>()
  closeCalls = 0

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
    return Promise.resolve()
  }
}

/** Records creation arguments and hands out fake watchers. */
class FakeWatchFactory {
  readonly calls: Array<{ path: string; options: WorkspaceWatchOptions }> = []
  readonly watchers: FakeWatcher[] = []
  /** Emit a watcher error instead of ready on creation (startup failure). */
  failReadyWith: Error | undefined
  /** Do not auto-emit ready; the test drives readiness by hand. */
  suppressReady = false

  create = (path: string, options: WorkspaceWatchOptions): FakeWatcher => {
    this.calls.push({ path, options })
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

  setTimeout(fn: () => void, ms: number): unknown {
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

/** Drain microtasks so queued pass bodies (promise chains) run to completion. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

let host: Harness
let factory: FakeWatchFactory
let timer: ManualTimer

beforeEach(async () => {
  resetFixtures()
  factory = new FakeWatchFactory()
  timer = new ManualTimer()
  host = await harness(defaultConfig, { watchFactory: factory.create, timer })
})

afterEach(async () => {
  await teardown(host)
})

/** Wait until the entry's reload pass settles into the given status. */
async function settled(canonical: string, status: 'idle' | 'failed'): Promise<void> {
  await vi.waitFor(() => {
    expect(host.registry.get(canonical)?.reload?.status).toBe(status)
  })
}

describe('WorkspaceRegistry live reload', () => {
  it('mounts a valid initial config strictly and starts exactly one controller', async () => {
    const ws = await makeWorkspace(host.root, 'strict')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, markerRow('initial'))

    const lease = await host.registry.acquire(ws)

    expect(fixtureState().markers).toEqual(['initial'])
    expect(lease.configured).toBe(true)
    expect(lease.composition?.active).toBe(true)
    // Exactly one controller, anchored on the stable workspace root (not the
    // exact config path — a not-yet-existing `.dsh/` must still be
    // discovered), with bounded watch options.
    expect(factory.calls).toHaveLength(1)
    expect(factory.calls[0]!.path).toBe(ws)
    expect(factory.calls[0]!.options).toMatchObject({
      ignoreInitial: true,
      depth: 2,
      atomic: true,
    })
    const ignored = factory.calls[0]!.options.ignored
    // The anchor itself, .dsh, and the config are kept; the rest is excluded.
    expect(ignored(ws)).toBe(false)
    expect(ignored(join(ws, 'package.json'))).toBe(true)
    expect(ignored(configPath)).toBe(false) // the exact config is kept
    expect(host.registry.get(lease.canonical)?.reload).toEqual({
      watching: true,
      status: 'idle',
      successfulReloads: 0,
    })
  })

  it('rejects acquire when the watcher fails to become ready and leaves nothing', async () => {
    const ws = await makeWorkspace(host.root, 'readyfail')
    await seedPlugins(ws, ['contribute.js'])
    await writeConfig(ws, markerRow('never'))
    const boom = new Error('watcher startup failed')
    factory.failReadyWith = boom

    // The strict readiness gate rejects the initial acquire...
    await expect(host.registry.acquire(ws)).rejects.toBe(boom)
    // ...and the cleanup stopped the watcher, cancelled nothing (no timer was
    // ever armed), and cached nothing.
    expect(factory.watchers).toHaveLength(1)
    expect(factory.watcher.closeCalls).toBe(1)
    expect(timer.pendingCount).toBe(0)
    expect(host.registry.size).toBe(0)
    expect(fixtureState().markers).toEqual([])

    // A healthy retry works afterwards (fresh scope and watcher).
    factory.failReadyWith = undefined
    const lease = await host.registry.acquire(ws)
    expect(fixtureState().markers).toEqual(['never'])
    expect(host.registry.get(lease.canonical)?.reload?.status).toBe('idle')
  })

  it('reconciles pre-activation events without double-mounting an unchanged file', async () => {
    const ws = await makeWorkspace(host.root, 'reconcile')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, markerRow('v1'))
    // Hold the watcher in `starting` so an event can arrive before the
    // registry's strict initial stat/mount.
    factory.suppressReady = true
    const acquiring = host.registry.acquire(ws)
    await vi.waitFor(() => {
      expect(factory.watchers).toHaveLength(1)
    })
    factory.watcher.emit('change', configPath)
    factory.watcher.emitReady()

    const lease = await acquiring
    // The strict mount already read the current file; the replayed event
    // becomes exactly one reconcile pass that recognizes the file is
    // unchanged and keeps the live tree — no second dispose+mount.
    timer.fire()
    await settled(lease.canonical, 'idle')
    expect(fixtureState().markers).toEqual(['v1'])
    expect(fixtureState().disposed).toBe(0)
    expect(host.registry.get(lease.canonical)?.reload?.successfulReloads).toBe(1)
    expect(host.registry.get(lease.canonical)?.composition?.active).toBe(true)
  })

  it('rejects an invalid initial config without leaking a watcher or a timer', async () => {
    const ws = await makeWorkspace(host.root, 'broken')
    await seedPlugins(ws, ['contribute.js'])
    await writeConfig(ws, '- id: x\n  name: [unclosed\n')

    await expect(host.registry.acquire(ws)).rejects.toBeInstanceOf(WorkspaceMountError)
    expect(host.registry.size).toBe(0)
    // The watcher was opened (and became ready) before the strict mount
    // rejected; the cleanup stopped it and armed no timer.
    expect(factory.calls).toHaveLength(1)
    expect(factory.watchers).toHaveLength(1)
    expect(factory.watcher.closeCalls).toBe(1)
    expect(timer.pendingCount).toBe(0)
  })

  it('replaces contributions on a change event, disposing the old row exactly once', async () => {
    const ws = await makeWorkspace(host.root, 'replace')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, markerRow('first'))
    const lease = await host.registry.acquire(ws)
    expect(fixtureState().markers).toEqual(['first'])
    expect(fixtureState().disposed).toBe(0)

    await writeFile(configPath, markerRow('second'))
    factory.watcher.emit('change', configPath)
    expect(host.registry.get(lease.canonical)?.reload?.status).toBe('scheduled')
    timer.fire()
    await settled(lease.canonical, 'idle')

    // The old subtree unwound once and the fresh one activated.
    expect(fixtureState().disposed).toBe(1)
    expect(fixtureState().markers).toEqual(['first', 'second'])
    expect(host.registry.get(lease.canonical)?.composition?.active).toBe(true)
    expect(host.registry.get(lease.canonical)?.configured).toBe(true)
    expect(host.registry.get(lease.canonical)?.reload?.successfulReloads).toBe(1)
  })

  it('unwinds old contributions, reports failed, and keeps the lease and scope alive', async () => {
    const ws = await makeWorkspace(host.root, 'break')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, markerRow('good'))
    const lease = await host.registry.acquire(ws)
    expect(fixtureState().markers).toEqual(['good'])

    await writeFile(configPath, '- id: x\n  name: [unclosed\n')
    factory.watcher.emit('change', configPath)
    timer.fire()
    await settled(lease.canonical, 'failed')

    // The old contribution is gone, nothing new is mounted, and the failure
    // is recorded without killing the entry.
    const info = host.registry.get(lease.canonical)!
    expect(fixtureState().disposed).toBe(1)
    expect(info.composition).toBeUndefined()
    expect(info.configured).toBe(true)
    expect(info.reload?.status).toBe('failed')
    expect(info.reload?.successfulReloads).toBe(0)
    // The scope, the scope-root mapping, and the lease all survive.
    expect(host.registry.workspaceForScope(lease.key)).toBe(lease.canonical)
    let scopeDisposed = false
    lease.ctx.effect(() => () => {
      scopeDisposed = true
    })
    await lease.release()
    expect(scopeDisposed).toBe(true)
    expect(host.registry.size).toBe(0)
  })

  it('recovers from a failed reload on the next event', async () => {
    const ws = await makeWorkspace(host.root, 'recover')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, markerRow('first'))
    const lease = await host.registry.acquire(ws)

    await writeFile(configPath, '- id: x\n  name: [unclosed\n')
    factory.watcher.emit('change', configPath)
    timer.fire()
    await settled(lease.canonical, 'failed')

    await writeFile(configPath, markerRow('recovered'))
    factory.watcher.emit('change', configPath)
    expect(host.registry.get(lease.canonical)?.reload?.status).toBe('scheduled')
    timer.fire()
    await settled(lease.canonical, 'idle')

    expect(fixtureState().markers).toContain('recovered')
    expect(host.registry.get(lease.canonical)?.composition?.active).toBe(true)
    expect(host.registry.get(lease.canonical)?.reload?.successfulReloads).toBe(1)
  })

  it('yields an empty workspace layer when the config is removed', async () => {
    const ws = await makeWorkspace(host.root, 'absent')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, markerRow('before'))
    const lease = await host.registry.acquire(ws)

    await rm(configPath)
    factory.watcher.emit('unlink', configPath)
    timer.fire()
    await settled(lease.canonical, 'idle')

    const info = host.registry.get(lease.canonical)!
    expect(fixtureState().disposed).toBe(1)
    expect(info.configured).toBe(false)
    expect(info.composition).toBeUndefined()
    expect(info.reload?.status).toBe('idle')
    expect(info.reload?.successfulReloads).toBe(1)
    // The lease keeps its creation-time snapshot.
    expect(lease.configured).toBe(true)
    expect(lease.composition).toBeUndefined()
  })

  it('mounts when the config appears while the lease is live', async () => {
    const ws = await makeWorkspace(host.root, 'appear')
    const lease = await host.registry.acquire(ws)
    expect(lease.configured).toBe(false)
    expect(lease.composition).toBeUndefined()
    // Even without a config file the trusted, watched entry owns a controller
    // anchored on the workspace root.
    expect(factory.calls).toHaveLength(1)
    expect(factory.calls[0]!.path).toBe(ws)

    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, markerRow('appeared'))
    factory.watcher.emit('add', configPath)
    timer.fire()
    await settled(lease.canonical, 'idle')

    expect(fixtureState().markers).toEqual(['appeared'])
    expect(host.registry.get(lease.canonical)?.configured).toBe(true)
    expect(host.registry.get(lease.canonical)?.composition?.active).toBe(true)
    expect(host.registry.get(lease.canonical)?.reload?.successfulReloads).toBe(1)
  })

  it('shares one watcher and controller across leases of one workspace', async () => {
    const ws = await makeWorkspace(host.root, 'shared')
    await seedPlugins(ws, ['contribute.js'])
    await writeConfig(ws, markerRow('shared'))
    const first = await host.registry.acquire(ws)
    const second = await host.registry.acquire(ws)

    expect(factory.watchers).toHaveLength(1)
    expect(factory.calls).toHaveLength(1)

    await first.release()
    // The entry is still live, so the watcher stays open.
    expect(factory.watcher.closeCalls).toBe(0)
    expect(host.registry.size).toBe(1)

    await second.release()
    expect(factory.watcher.closeCalls).toBe(1)
    expect(host.registry.size).toBe(0)
  })

  it('closes the watcher, cancels the debounce, and ignores events after the final release', async () => {
    const ws = await makeWorkspace(host.root, 'release')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, markerRow('kept'))
    const lease = await host.registry.acquire(ws)
    expect(fixtureState().markers).toEqual(['kept'])

    // A change event arms the debounce; the final release cancels it so the
    // reload callback never runs.
    await writeFile(configPath, markerRow('dropped'))
    factory.watcher.emit('change', configPath)
    expect(timer.pendingCount).toBe(1)
    await lease.release()
    expect(timer.pendingCount).toBe(0)
    expect(factory.watcher.closeCalls).toBe(1)
    expect(host.registry.size).toBe(0)
    expect(host.registry.get(lease.canonical)).toBeUndefined()

    // Events after the release are ignored: nothing is scheduled or mounted.
    factory.watcher.emit('change', configPath)
    timer.fire()
    await tick()
    expect(fixtureState().markers).toEqual(['kept'])
    expect(fixtureState().disposed).toBe(1)
  })

  it('drains a reload pass that lands during the final release without publishing it', async () => {
    const ws = await makeWorkspace(host.root, 'drain')
    await seedPlugins(ws, ['contribute.js', 'slow-contribute.js'])
    const configPath = await writeConfig(ws, markerRow('first'))
    const lease = await host.registry.acquire(ws)
    expect(fixtureState().markers).toEqual(['first'])

    // Swap the file for a slow-mounting row and start a reload pass.
    await writeFile(configPath, [
      '- id: slow',
      '  name: ./plugins/slow-contribute.js',
      '  config:',
      '    marker: second',
      '    delayMs: 300',
      '',
    ].join('\n'))
    factory.watcher.emit('change', configPath)
    timer.fire()
    // The pass is now inside the slow mount (activation started, not
    // finished): the final release marks the entry disposed, stops the
    // controller — which drains the running pass — and only then disposes
    // the scope.
    await vi.waitFor(() => {
      expect(fixtureState().pending).toContain('second')
    })
    await lease.release()

    expect(host.registry.size).toBe(0)
    expect(factory.watcher.closeCalls).toBe(1)
    // The fresh subtree activated, then was unwound immediately instead of
    // being published into the dying entry: exactly two disposer runs — the
    // old row and the discarded fresh row — and no third effect survives.
    expect(fixtureState().markers).toContain('second')
    expect(fixtureState().disposed).toBe(2)
  })

  it('creates no watcher and never imports when trust is disabled', async () => {
    const untrusted = await harness(
      { trustWorkspaceConfig: false },
      { watchFactory: factory.create, timer },
    )
    const ws = await makeWorkspace(untrusted.root, 'untrusted')
    await seedPlugins(ws, ['contribute.js'])
    await writeConfig(ws, markerRow('never'))

    const lease = await untrusted.registry.acquire(ws)

    expect(lease.configured).toBe(true)
    expect(lease.composition).toBeUndefined()
    expect(fixtureState().markers).toEqual([])
    expect(factory.calls).toHaveLength(0)
    expect(untrusted.registry.get(lease.canonical)?.reload).toBeUndefined()
    await teardown(untrusted)
  })

  it('mounts once but creates no watcher when watching is disabled', async () => {
    const nowatch = await harness(
      { trustWorkspaceConfig: true, watchWorkspaceConfig: false, reloadDebounceMs: 150 },
      { watchFactory: factory.create, timer },
    )
    const ws = await makeWorkspace(nowatch.root, 'nowatch')
    await seedPlugins(ws, ['contribute.js'])
    await writeConfig(ws, markerRow('static'))

    const lease = await nowatch.registry.acquire(ws)

    expect(fixtureState().markers).toEqual(['static'])
    expect(lease.composition?.active).toBe(true)
    expect(factory.calls).toHaveLength(0)
    expect(nowatch.registry.get(lease.canonical)?.reload).toBeUndefined()
    await teardown(nowatch)
  })

  it('reloads two workspaces independently', async () => {
    const a = await makeWorkspace(host.root, 'alpha')
    const b = await makeWorkspace(host.root, 'beta')
    await seedPlugins(a, ['contribute.js'])
    await seedPlugins(b, ['contribute.js'])
    const aConfig = await writeConfig(a, markerRow('a1'))
    const bConfig = await writeConfig(b, markerRow('b1'))
    const leaseA = await host.registry.acquire(a)
    const leaseB = await host.registry.acquire(b)
    expect(factory.watchers).toHaveLength(2)
    expect(fixtureState().markers).toEqual(['a1', 'b1'])

    await writeFile(aConfig, markerRow('a2'))
    factory.watchers[0]!.emit('change', aConfig)
    timer.fire()
    await settled(leaseA.canonical, 'idle')

    // Only A reloaded; B keeps its original composition and counter.
    expect(fixtureState().markers).toEqual(['a1', 'b1', 'a2'])
    expect(host.registry.get(leaseA.canonical)?.reload?.successfulReloads).toBe(1)
    expect(host.registry.get(leaseB.canonical)?.reload?.successfulReloads).toBe(0)
    expect(host.registry.get(leaseB.canonical)?.composition?.active).toBe(true)
  })

  it('reports watcher errors without killing the entry and keeps reloading', async () => {
    const ws = await makeWorkspace(host.root, 'warn')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, markerRow('before'))
    const lease = await host.registry.acquire(ws)

    factory.watcher.emitError(new Error('watcher boom'))
    expect(host.registry.get(lease.canonical)?.reload?.status).toBe('idle')

    // The controller keeps working after the watcher error.
    await writeFile(configPath, markerRow('after'))
    factory.watcher.emit('change', configPath)
    timer.fire()
    await settled(lease.canonical, 'idle')
    expect(fixtureState().markers).toContain('after')
    expect(host.registry.get(lease.canonical)?.reload?.successfulReloads).toBe(1)
  })

  it('logs reload failures with workspace identity and never config text', async () => {
    const messages: Array<{ type: string; args: unknown[] }> = []
    const removeExporter = host.ctx.logger.exporter({
      levels: { default: 2 },
      export: (message) => messages.push(message),
    })
    try {
      const ws = await makeWorkspace(host.root, 'logfail')
      await seedPlugins(ws, ['contribute.js'])
      const configPath = await writeConfig(ws, markerRow('good'))
      const lease = await host.registry.acquire(ws)

      const brokenBody = '- id: x\n  name: [unclosed\n'
      await writeFile(configPath, brokenBody)
      factory.watcher.emit('change', configPath)
      timer.fire()
      await settled(lease.canonical, 'failed')

      const warns = messages.filter((message) => message.type === 'warn')
      expect(warns.length).toBeGreaterThan(0)
      const text = warns.map((message) => message.args.join(' ')).join('\n')
      expect(text).toContain(ws)
      expect(text).toContain(configPath)
      // Never dump the config body (or anything else the file held).
      expect(text).not.toContain('unclosed')
      await lease.release()
    } finally {
      removeExporter()
    }
  })

  describe('config schema', () => {
    it('applies the documented defaults', () => {
      expect(WorkspaceRegistry.Config({} as never)).toEqual(defaultConfig)
    })

    it('accepts explicit values', () => {
      expect(WorkspaceRegistry.Config({
        trustWorkspaceConfig: false,
        watchWorkspaceConfig: true,
        reloadDebounceMs: 42,
      } as never)).toEqual({
        trustWorkspaceConfig: false,
        watchWorkspaceConfig: true,
        reloadDebounceMs: 42,
      })
    })

    it.each([
      ['a negative reloadDebounceMs', { reloadDebounceMs: -1 }],
      ['a fractional reloadDebounceMs', { reloadDebounceMs: 0.5 }],
      ['a NaN reloadDebounceMs', { reloadDebounceMs: Number.NaN }],
      ['an infinite reloadDebounceMs', { reloadDebounceMs: Number.POSITIVE_INFINITY }],
      ['an oversized reloadDebounceMs', { reloadDebounceMs: MAX_TIMER_DELAY_MS + 1 }],
    ] as Array<[string, Partial<WorkspaceRegistryConfig>]>)(
      'rejects %s',
      (_label, patch) => {
        expect(() => WorkspaceRegistry.Config(patch as never)).toThrow()
      },
    )
  })
})
