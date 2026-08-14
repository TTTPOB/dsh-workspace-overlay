import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import { PresetMountError, type AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspacePresetRegistry, type PresetGeneration } from '../src/workspace-presets.js'
import {
  fixtureState,
  harness,
  makeWorkspace,
  markerPreset,
  resetFixtures,
  seedPreset,
  teardown,
  type Harness,
} from './helpers.js'

let host: Harness
let presetsRoot: string
let manager: WorkspacePresetRegistry

beforeEach(async () => {
  resetFixtures()
  host = await harness()
  presetsRoot = await mkdtemp(join(tmpdir(), 'dsh-ws-manager-'))
  manager = new WorkspacePresetRegistry()
})

afterEach(async () => {
  await rm(presetsRoot, { recursive: true, force: true })
  await teardown(host)
})

/** The preset object backing one seeded preset directory. */
function presetOf(id: string): AgentPreset {
  return { id, trust: 'system', path: join(presetsRoot, id, 'agent.cordis.yml') }
}

describe('WorkspacePresetRegistry', () => {
  it('shares one generation for the same workspace and preset, mounted under the workspace scope', async () => {
    await seedPreset(presetsRoot, 'standard', markerPreset('shared'))
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)

    const first = await manager.ensure(lease, presetOf('standard'))
    const second = await manager.ensure(lease, presetOf('standard'))

    expect(second).toBe(first)
    expect(second.key).toBe(first.key)
    // The generation scope is a child of the workspace scope.
    expect(scopeParentOf(second.key)).toBe(lease.key)
    // One mount, and the preset row's registrations landed in the generation
    // scope, not the workspace scope.
    expect(fixtureState().markers).toEqual(['shared'])
    expect(scopeOf(fixtureState().contexts[0]!)).toBe(second.key)
    expect(second.joined).toBe(0)
  })

  it('keeps different workspaces isolated', async () => {
    await seedPreset(presetsRoot, 'standard', markerPreset('iso'))
    const a = await makeWorkspace(host.root, 'a')
    const b = await makeWorkspace(host.root, 'b')
    const leaseA = await host.registry.acquire(a)
    const leaseB = await host.registry.acquire(b)

    const genA = await manager.ensure(leaseA, presetOf('standard'))
    const genB = await manager.ensure(leaseB, presetOf('standard'))

    expect(genB).not.toBe(genA)
    expect(genB.key).not.toBe(genA.key)
    expect(scopeParentOf(genA.key)).toBe(leaseA.key)
    expect(scopeParentOf(genB.key)).toBe(leaseB.key)
    // One mount per workspace.
    expect(fixtureState().markers).toEqual(['iso', 'iso'])
  })

  it('keeps different presets of one workspace separate', async () => {
    await seedPreset(presetsRoot, 'standard', markerPreset('std'))
    await seedPreset(presetsRoot, 'minimal', markerPreset('min'))
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)

    const std = await manager.ensure(lease, presetOf('standard'))
    const min = await manager.ensure(lease, presetOf('minimal'))

    expect(min).not.toBe(std)
    expect(fixtureState().markers).toEqual(['std', 'min'])
  })

  it('reuses the same stamp and mints a fresh generation on stamp change, disposing the idle superseded one', async () => {
    await seedPreset(presetsRoot, 'standard', markerPreset('v1'))
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const first = await manager.ensure(lease, presetOf('standard'))
    first.join()

    // A visible file change (different size) starts a new generation.
    const path = join(presetsRoot, 'standard', 'agent.cordis.yml')
    await writeFile(path, markerPreset('v2-longer-marker'))
    const second = await manager.ensure(lease, presetOf('standard'))

    expect(second).not.toBe(first)
    expect(second.key).not.toBe(first.key)
    expect(fixtureState().markers).toEqual(['v1', 'v2-longer-marker'])

    // The old generation stays while joined, and is disposed on the last leave.
    expect(first.joined).toBe(1)
    expect(first.disposed).toBe(false)
    first.leave()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(first.joined).toBe(0)
    expect(first.disposed).toBe(true)
    expect(second.disposed).toBe(false)

    // The new generation is current: same stamp reuses it.
    const third = await manager.ensure(lease, presetOf('standard'))
    expect(third).toBe(second)
  })

  it('single-flights concurrent ensures for one preset', async () => {
    await seedPreset(presetsRoot, 'standard', markerPreset('race'))
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)

    const generations = await Promise.all(
      Array.from({ length: 8 }, () => manager.ensure(lease, presetOf('standard'))),
    )

    expect(new Set(generations.map(gen => gen.key)).size).toBe(1)
    // One mount, one plugin activation.
    expect(fixtureState().markers).toEqual(['race'])
    expect(fixtureState().disposed).toBe(0)
  })

  it('rejects an unreadable composition and retries after the file exists', async () => {
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)

    await expect(manager.ensure(lease, presetOf('standard'))).rejects.toBeInstanceOf(PresetMountError)
    await expect(manager.ensure(lease, presetOf('standard'))).rejects.toThrow(/unreadable/)

    // Failure left no cached state: the fixed file mounts on retry.
    await seedPreset(presetsRoot, 'standard', markerPreset('fixed'))
    const generation = await manager.ensure(lease, presetOf('standard'))
    expect(generation.presetId).toBe('standard')
    expect(fixtureState().markers).toEqual(['fixed'])
  })

  it('rejects an unusable composition, disposes its scope, and retries after the fix', async () => {
    await seedPreset(presetsRoot, 'standard', '- id: nope\n  name: ./plugins/does-not-exist.js\n')
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)

    await expect(manager.ensure(lease, presetOf('standard'))).rejects.toBeInstanceOf(PresetMountError)
    expect(fixtureState().markers).toEqual([])

    await writeFile(join(presetsRoot, 'standard', 'agent.cordis.yml'), markerPreset('rescued'))
    const generation = await manager.ensure(lease, presetOf('standard'))
    expect(generation.presetId).toBe('standard')
    expect(fixtureState().markers).toEqual(['rescued'])
  })

  it('rejects a join on a disposed generation', async () => {
    await seedPreset(presetsRoot, 'standard', markerPreset('x'))
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const first = await manager.ensure(lease, presetOf('standard'))
    await writeFile(join(presetsRoot, 'standard', 'agent.cordis.yml'), markerPreset('y-longer'))
    const second = await manager.ensure(lease, presetOf('standard'))
    first.supersede()
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(first.disposed).toBe(true)
    expect(() => first.join()).toThrow(/already disposed/)
    expect(second.disposed).toBe(false)
  })

  it('collects the current generation when the workspace scope is disposed', async () => {
    await seedPreset(presetsRoot, 'standard', markerPreset('final'))
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const generation = await manager.ensure(lease, presetOf('standard'))
    generation.join()
    expect(generation.disposed).toBe(false)

    await lease.release()

    // The workspace scope dispose collected the child generation scope: the
    // preset row's effect unwound with it.
    expect(host.registry.size).toBe(0)
    expect(fixtureState().disposed).toBe(1)
  })
})
