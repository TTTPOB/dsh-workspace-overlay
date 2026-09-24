/**
 * Workspace-local agent preset generations, driven through a real
 * `AgentPresetRegistry`.
 *
 * 0.1.7 has no file roster. A preset is an in-memory `PresetDefinition`
 * handed to `registry.register()`, and its revision identity is the scope
 * key of the standing mount that registration produces. So the "the
 * composition changed" trigger these tests used to pull by rewriting
 * `agent.cordis.yml` is pulled here by unregistering and re-registering the
 * definition, which mints a fresh standing-mount key.
 *
 * `register()` mounts the definition once in the registry's own scope, so
 * `fixtureState().markers` also carries those registry-side activations.
 * `markersIn()` filters the fixture records down to the scope a test cares
 * about, which keeps every assertion about the workspace-local mount exact.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scopeOf, scopeParentOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import {
  AgentPresetRegistry,
  type AgentPreset,
  type PresetDefinition,
} from '@deepseek-ai/dsh-agent-preset-registry'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WorkspacePresetRegistry } from '../src/workspace-presets.js'
import {
  FIXTURES,
  fixtureState,
  harness,
  makeWorkspace,
  resetFixtures,
  teardown,
  type Harness,
} from './helpers.js'

let host: Harness
let registry: AgentPresetRegistry
let manager: WorkspacePresetRegistry
/** Live definition disposers of the current test, keyed by preset id. */
let declared: Map<string, () => Promise<void>>

beforeEach(async () => {
  resetFixtures()
  host = await harness()
  declared = new Map()
  // The registry injects `sessionProjections`, so it needs the projection
  // seam composed alongside the Loader the workspace harness already brings.
  await host.ctx.plugin(SessionProjections)
  await host.ctx.plugin(AgentPresetRegistry, { default: 'standard', selectedDefault: 'standard' })
  registry = host.ctx.agentPresets
  manager = new WorkspacePresetRegistry()
})

afterEach(async () => {
  // Drop every standing mount before the harness goes away. The mount set is
  // module state shared by the whole process, so a mount left behind would
  // answer `livePresetMounts()` on behalf of the next test's registry too.
  for (const off of declared.values()) await off()
  declared.clear()
  await teardown(host)
})

/** Absolute specifier for one committed fixture plugin. */
function fixturePlugin(file: string): string {
  return pathToFileURL(join(FIXTURES, 'plugins', file)).href
}

/** A one-row plugin list whose single row seeds the given marker. */
function markerRows(marker: string): PresetDefinition['plugins'] {
  return [{ id: 'marker', name: fixturePlugin('contribute.js'), config: { marker } }]
}

/** Register one preset definition and remember how to unregister it. */
async function declarePreset(id: string, plugins: PresetDefinition['plugins']): Promise<void> {
  declared.set(id, await registry.register({ id, plugins }))
}

/** Unregister one preset, disposing its standing mount and its revision key. */
async function forgetPreset(id: string): Promise<void> {
  const off = declared.get(id)
  if (off === undefined) return
  declared.delete(id)
  await off()
}

/**
 * Rewrite a live definition's entry list in place.
 *
 * The registry already cloned the list into its standing mount, so this
 * changes only what a later workspace-local mount reads while the standing
 * mount — and therefore the revision key — stays live. That is the seam the
 * mount-failure paths are exercised through.
 */
function redefine(id: string, plugins: PresetDefinition['plugins'] | undefined): void {
  const holder = registry as unknown as {
    definitions: Map<string, { config: { plugins?: PresetDefinition['plugins'] } }>
  }
  const record = holder.definitions.get(id)
  if (record === undefined) throw new Error(`no definition registered for ${id}`)
  if (plugins === undefined) delete record.config.plugins
  else record.config.plugins = plugins
}

/** The roster row for one registered preset id. */
function presetOf(id: string): AgentPreset {
  return { id }
}

/** Markers the fixture recorded inside one scope, in activation order. */
function markersIn(key: ScopeKey): string[] {
  const { markers, contexts } = fixtureState()
  const found: string[] = []
  contexts.forEach((context, index) => {
    if (scopeOf(context) === key) found.push(markers[index]!)
  })
  return found
}

/** Let the fire-and-forget disposal of a superseded generation settle. */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 10))
}

describe('WorkspacePresetRegistry', () => {
  it('shares one generation for the same workspace and preset, mounted under the workspace scope', async () => {
    await declarePreset('standard', markerRows('shared'))
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)

    const first = await manager.ensure(lease, presetOf('standard'), registry)
    const second = await manager.ensure(lease, presetOf('standard'), registry)

    expect(second).toBe(first)
    expect(second.key).toBe(first.key)
    // The generation scope is a child of the workspace scope.
    expect(scopeParentOf(second.key)).toBe(lease.key)
    // One mount, and the preset row's registrations landed in the generation
    // scope, not the workspace scope.
    expect(markersIn(second.key)).toEqual(['shared'])
    expect(markersIn(lease.key)).toEqual([])
    expect(second.joined).toBe(0)
  })

  it('keeps different workspaces isolated', async () => {
    await declarePreset('standard', markerRows('iso'))
    const a = await makeWorkspace(host.root, 'a')
    const b = await makeWorkspace(host.root, 'b')
    const leaseA = await host.registry.acquire(a)
    const leaseB = await host.registry.acquire(b)

    const genA = await manager.ensure(leaseA, presetOf('standard'), registry)
    const genB = await manager.ensure(leaseB, presetOf('standard'), registry)

    expect(genB).not.toBe(genA)
    expect(genB.key).not.toBe(genA.key)
    expect(scopeParentOf(genA.key)).toBe(leaseA.key)
    expect(scopeParentOf(genB.key)).toBe(leaseB.key)
    // One mount per workspace.
    expect(markersIn(genA.key)).toEqual(['iso'])
    expect(markersIn(genB.key)).toEqual(['iso'])
  })

  it('keeps different presets of one workspace separate', async () => {
    await declarePreset('standard', markerRows('std'))
    await declarePreset('minimal', markerRows('min'))
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)

    const std = await manager.ensure(lease, presetOf('standard'), registry)
    const min = await manager.ensure(lease, presetOf('minimal'), registry)

    expect(min).not.toBe(std)
    expect(markersIn(std.key)).toEqual(['std'])
    expect(markersIn(min.key)).toEqual(['min'])
  })

  it('reuses the same revision and mints a fresh generation on a revision change, disposing the idle superseded one', async () => {
    await declarePreset('standard', markerRows('v1'))
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const first = await manager.ensure(lease, presetOf('standard'), registry)
    first.join()

    // Same revision: the standing-mount key is unchanged, so the generation is.
    expect(await manager.ensure(lease, presetOf('standard'), registry)).toBe(first)

    // A re-registered definition gets a new standing-mount key, which is the
    // 0.1.7 equivalent of the composition file changing size on disk.
    await forgetPreset('standard')
    await declarePreset('standard', markerRows('v2-longer-marker'))
    const second = await manager.ensure(lease, presetOf('standard'), registry)

    expect(second).not.toBe(first)
    expect(second.key).not.toBe(first.key)
    expect(markersIn(second.key)).toEqual(['v2-longer-marker'])

    // The old generation stays while joined, and is disposed on the last leave.
    expect(first.joined).toBe(1)
    expect(first.disposed).toBe(false)
    first.leave()
    await settle()
    expect(first.joined).toBe(0)
    expect(first.disposed).toBe(true)
    expect(second.disposed).toBe(false)

    // The new generation is current: the same revision reuses it.
    const third = await manager.ensure(lease, presetOf('standard'), registry)
    expect(third).toBe(second)
  })

  it('single-flights concurrent ensures for one preset', async () => {
    await declarePreset('standard', markerRows('race'))
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)

    const generations = await Promise.all(
      Array.from({ length: 8 }, () => manager.ensure(lease, presetOf('standard'), registry)),
    )

    expect(new Set(generations.map(gen => gen.key)).size).toBe(1)
    // One mount, one plugin activation.
    expect(markersIn(generations[0]!.key)).toEqual(['race'])
    expect(fixtureState().disposed).toBe(0)
  })

  it('rejects a preset with no live standing mount and retries once one exists', async () => {
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)

    await expect(manager.ensure(lease, presetOf('standard'), registry))
      .rejects.toMatchObject({ code: 'agent-preset/invalid' })
    await expect(manager.ensure(lease, presetOf('standard'), registry))
      .rejects.toThrow(/no live standing mount/)

    // The failure left no cached state: the preset mounts on the first try
    // after the registry gains a standing mount for it.
    await declarePreset('standard', markerRows('later'))
    const generation = await manager.ensure(lease, presetOf('standard'), registry)
    expect(generation.presetId).toBe('standard')
    expect(markersIn(generation.key)).toEqual(['later'])
  })

  it('rejects a definition whose plugin list is not readable and retries after the fix', async () => {
    await declarePreset('standard', markerRows('unreadable'))
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    // The standing mount stays live while the declaration loses its entry
    // list: the revision resolves, the composition does not.
    redefine('standard', undefined)

    await expect(manager.ensure(lease, presetOf('standard'), registry))
      .rejects.toMatchObject({ code: 'agent-preset/invalid' })
    await expect(manager.ensure(lease, presetOf('standard'), registry))
      .rejects.toThrow(/not readable/)

    redefine('standard', markerRows('fixed'))
    const generation = await manager.ensure(lease, presetOf('standard'), registry)
    expect(generation.presetId).toBe('standard')
    expect(markersIn(generation.key)).toEqual(['fixed'])
  })

  it('rejects a composition that fails to mount, disposes its fresh scope, and retries after the fix', async () => {
    await declarePreset('standard', markerRows('ok'))
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    // Point the live definition at a module that cannot be imported. The
    // standing mount is untouched, so the failure comes from this module's
    // own mount rather than from the registry's revision lookup.
    redefine('standard', [
      { id: 'marker', name: fixturePlugin('contribute.js'), config: { marker: 'partial' } },
      { id: 'nope', name: fixturePlugin('does-not-exist.js') },
    ])
    const disposed = fixtureState().disposed

    // The official contract (`AgentPresetRegistry.retain` + `diagnostic`): a
    // preset whose composition will not mount is reported as
    // `agent-preset/invalid` with the diagnostic carried in `reason`, so
    // remote clients classify it as a broken preset rather than an opaque
    // failure. A single captured rejection keeps the dispose-delta below exact.
    const failure = await manager.ensure(lease, presetOf('standard'), registry).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(RemoteError)
    expect((failure as RemoteError).code).toBe('agent-preset/invalid')
    expect((failure as RemoteError).details).toMatchObject({ agentPreset: 'standard' })
    expect((failure as Error).message).toMatch(/failed to mount/)
    // The row that did activate was unwound with the fresh scope, so nothing
    // of the failed generation is left mounted.
    expect(fixtureState().disposed).toBe(disposed + 1)

    redefine('standard', markerRows('rescued'))
    const generation = await manager.ensure(lease, presetOf('standard'), registry)
    expect(generation.presetId).toBe('standard')
    expect(markersIn(generation.key)).toEqual(['rescued'])
  })

  it('rejects a join on a disposed generation', async () => {
    await declarePreset('standard', markerRows('x'))
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const first = await manager.ensure(lease, presetOf('standard'), registry)
    await forgetPreset('standard')
    await declarePreset('standard', markerRows('y-longer'))
    const second = await manager.ensure(lease, presetOf('standard'), registry)
    first.supersede()
    await settle()

    expect(first.disposed).toBe(true)
    expect(() => first.join()).toThrow(/already disposed/)
    expect(second.disposed).toBe(false)
  })

  it('collects the current generation when the workspace scope is disposed', async () => {
    await declarePreset('standard', markerRows('final'))
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const generation = await manager.ensure(lease, presetOf('standard'), registry)
    generation.join()
    expect(generation.disposed).toBe(false)
    const disposed = fixtureState().disposed

    await lease.release()

    // The workspace scope dispose collected the child generation scope: the
    // preset row's effect unwound with it.
    expect(host.registry.size).toBe(0)
    expect(fixtureState().disposed).toBe(disposed + 1)
  })
})
