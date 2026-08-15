/**
 * Real-filesystem live reload tests for the workspace registry.
 *
 * The registry is booted through the production plugin path (no runtime
 * seams): real chokidar watchers over real temp workspaces, real timers, and
 * the real debounce. Positive observations are bounded with `vi.waitFor` on
 * the observable state (fixture markers, `configured`, `successfulReloads`);
 * the only fixed delays are short settle windows for negative assertions
 * ("nothing reloads after release") and for chokidar to attach its watcher to
 * a directory created after watching started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

const DEBOUNCE_MS = 50

/** A short settle window: long enough for debounce + watcher delivery. */
function settle(ms = 300): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let host: Harness

beforeEach(async () => {
  resetFixtures()
  host = await harness({ reloadDebounceMs: DEBOUNCE_MS })
})

afterEach(async () => {
  await teardown(host)
})

describe('WorkspaceRegistry live reload over the real filesystem', () => {
  it('reloads an existing valid config on change, replacing the composition once', async () => {
    const ws = await makeWorkspace(host.root, 'change')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, markerRow('v1'))
    const lease = await host.registry.acquire(ws)

    expect(fixtureState().markers).toEqual(['v1'])
    expect(host.registry.get(lease.canonical)?.reload?.watching).toBe(true)

    await writeFile(configPath, markerRow('v2'))
    await vi.waitFor(() => {
      expect(fixtureState().markers).toEqual(['v1', 'v2'])
    }, { timeout: 5000 })
    // The old row disposed exactly once; the fresh one is active.
    expect(fixtureState().disposed).toBe(1)
    await vi.waitFor(() => {
      const info = host.registry.get(lease.canonical)!
      expect(info.reload?.successfulReloads).toBe(1)
      expect(info.composition?.active).toBe(true)
    }, { timeout: 5000 })
  })

  it('unlink yields an empty workspace layer and a later add recovers it', async () => {
    const ws = await makeWorkspace(host.root, 'unlink')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, markerRow('before'))
    const lease = await host.registry.acquire(ws)
    expect(fixtureState().markers).toEqual(['before'])

    await rm(configPath)
    await vi.waitFor(() => {
      const info = host.registry.get(lease.canonical)!
      expect(info.configured).toBe(false)
      expect(info.composition).toBeUndefined()
      // The old row's disposal settles inside the same pass.
      expect(fixtureState().disposed).toBe(1)
    }, { timeout: 5000 })

    // The same live lease picks the file back up when it reappears.
    await writeConfig(ws, markerRow('back'))
    await vi.waitFor(() => {
      expect(fixtureState().markers).toEqual(['before', 'back'])
      expect(host.registry.get(lease.canonical)?.configured).toBe(true)
    }, { timeout: 5000 })
    expect(fixtureState().disposed).toBe(1)
  })

  it('mounts when .dsh did not exist at acquire and is created later', async () => {
    const ws = await makeWorkspace(host.root, 'late-dsh')
    // No .dsh directory at all when the watcher starts.
    const lease = await host.registry.acquire(ws)
    expect(lease.configured).toBe(false)
    expect(host.registry.get(lease.canonical)?.reload?.watching).toBe(true)

    await seedPlugins(ws, ['contribute.js'])
    // Write the config twice with a short gap: the first write may land in
    // chokidar's scan→attach window for the freshly created .dsh directory;
    // the second lands after the attach and guarantees an event. Both writes
    // fall inside one debounce window, so exactly one reload pass results.
    await writeConfig(ws, markerRow('appeared'))
    await settle(25)
    await writeConfig(ws, markerRow('appeared'))

    await vi.waitFor(() => {
      expect(fixtureState().markers).toEqual(['appeared'])
    }, { timeout: 5000 })
    await vi.waitFor(() => {
      const info = host.registry.get(lease.canonical)!
      expect(info.configured).toBe(true)
      expect(info.composition?.active).toBe(true)
      expect(info.reload?.successfulReloads).toBe(1)
    }, { timeout: 5000 })
  })

  it('reacts to an editor-style atomic rename over the config file', async () => {
    const ws = await makeWorkspace(host.root, 'atomic')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, markerRow('v1'))
    const lease = await host.registry.acquire(ws)
    expect(fixtureState().markers).toEqual(['v1'])

    // Editor pattern: write a temp file beside the config, then rename it
    // over the config (new inode, unlink+add event pair).
    const tmp = join(ws, '.dsh', 'cordis.yml.tmp')
    await writeFile(tmp, markerRow('atomic'))
    await rename(tmp, configPath)

    await vi.waitFor(() => {
      expect(fixtureState().markers).toEqual(['v1', 'atomic'])
    }, { timeout: 5000 })
    expect(fixtureState().disposed).toBe(1)
    await vi.waitFor(() => {
      expect(host.registry.get(lease.canonical)?.reload?.successfulReloads).toBe(1)
    }, { timeout: 5000 })
  })

  it('ignores the config after the final release: a later write reloads nothing', async () => {
    const ws = await makeWorkspace(host.root, 'released')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, markerRow('kept'))
    const lease = await host.registry.acquire(ws)
    expect(fixtureState().markers).toEqual(['kept'])

    await lease.release()
    expect(host.registry.size).toBe(0)

    await writeFile(configPath, markerRow('after-release'))
    // Negative assertion: settle past debounce + chokidar delivery, then
    // prove nothing was mounted or disposed.
    await settle(400)
    expect(fixtureState().markers).toEqual(['kept'])
    expect(fixtureState().disposed).toBe(1)
  })

  it('reloads two workspaces independently', async () => {
    const a = await makeWorkspace(host.root, 'alpha')
    const b = await makeWorkspace(host.root, 'beta')
    await seedPlugins(a, ['contribute.js'])
    await seedPlugins(b, ['contribute.js'])
    const aConfig = await writeConfig(a, markerRow('a1'))
    await writeConfig(b, markerRow('b1'))
    const leaseA = await host.registry.acquire(a)
    const leaseB = await host.registry.acquire(b)
    expect(fixtureState().markers).toEqual(['a1', 'b1'])

    await writeFile(aConfig, markerRow('a2'))
    await vi.waitFor(() => {
      expect(fixtureState().markers).toEqual(['a1', 'b1', 'a2'])
      expect(host.registry.get(leaseA.canonical)?.reload?.successfulReloads).toBe(1)
    }, { timeout: 5000 })

    // Only A reloaded; B's composition and counter are untouched.
    expect(host.registry.get(leaseB.canonical)?.reload?.successfulReloads).toBe(0)
    expect(host.registry.get(leaseB.canonical)?.composition?.active).toBe(true)
  })

  it('shares one watcher across leases of one workspace: one reload per event', async () => {
    const ws = await makeWorkspace(host.root, 'shared')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, markerRow('v1'))
    const first = await host.registry.acquire(ws)
    const second = await host.registry.acquire(ws)
    expect(first.key).toBe(second.key)
    expect(first.ctx).toBe(second.ctx)

    // One entry -> one controller/watcher; a single file change must produce
    // exactly one reload (the marker is mounted exactly once more).
    await writeFile(configPath, markerRow('v2'))
    await vi.waitFor(() => {
      expect(fixtureState().markers).toEqual(['v1', 'v2'])
      expect(fixtureState().disposed).toBe(1)
      expect(host.registry.get(ws)?.reload?.successfulReloads).toBe(1)
    }, { timeout: 5000 })

    // Releasing one lease keeps the shared watcher alive.
    await first.release()
    expect(host.registry.get(ws)?.reload?.watching).toBe(true)
    await second.release()
    expect(host.registry.size).toBe(0)
  })

  it('trust=false creates no watcher and never imports or reacts to file creation', async () => {
    const untrusted = await harness({ trustWorkspaceConfig: false })
    const ws = await makeWorkspace(untrusted.root, 'untrusted')
    const lease = await untrusted.registry.acquire(ws)

    expect(lease.composition).toBeUndefined()
    expect(untrusted.registry.get(lease.canonical)?.reload).toBeUndefined()

    // Files created after the acquire are neither watched nor imported, and
    // `configured` stays at its creation-time snapshot (no re-stat, no
    // watcher, no reaction).
    await seedPlugins(ws, ['contribute.js'])
    await writeConfig(ws, markerRow('never'))
    await settle(300)
    expect(fixtureState().markers).toEqual([])
    expect(untrusted.registry.get(lease.canonical)?.configured).toBe(false)
    expect(untrusted.registry.get(lease.canonical)?.composition).toBeUndefined()
    await teardown(untrusted)
  })

  it('watch=false mounts once and never reloads on later changes', async () => {
    const nowatch = await harness({ watchWorkspaceConfig: false })
    const ws = await makeWorkspace(nowatch.root, 'nowatch')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, markerRow('static'))
    const lease = await nowatch.registry.acquire(ws)

    expect(fixtureState().markers).toEqual(['static'])
    expect(lease.composition?.active).toBe(true)
    expect(nowatch.registry.get(lease.canonical)?.reload).toBeUndefined()

    // A later change is ignored: no watcher exists to observe it.
    await writeFile(configPath, markerRow('changed'))
    await settle(300)
    expect(fixtureState().markers).toEqual(['static'])
    expect(fixtureState().disposed).toBe(0)
    await teardown(nowatch)
  })

  it('never creates .dsh in the user workspace itself', async () => {
    const ws = await makeWorkspace(host.root, 'lazy')
    const dshDir = join(ws, '.dsh')
    const lease = await host.registry.acquire(ws)
    // The watcher anchors on the already-existing workspace root; the
    // registry must not have created .dsh (or anything else) inside the
    // user's workspace to make watching work.
    await expect(stat(dshDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(lease.configured).toBe(false)
    expect(host.registry.get(lease.canonical)?.reload?.watching).toBe(true)
  })
})
