import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, symbols, type Fiber } from '@deepseek-ai/cordis'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import {
  bindScopeParent,
  createScope,
  scopeOf,
  scopeParentOf,
  type Scope,
} from '@deepseek-ai/dsh-scope'
// 0.1.7 renamed the package (`dsh-agent-presets` -> `dsh-agent-preset-registry`)
// and the service class (`AgentPresets` -> `AgentPresetRegistry`); the Cordis
// service name is still `agentPresets`. Two things this suite used to lean on are
// gone: the file roster (`roots` + `seedPreset`), replaced by in-memory
// `PresetDefinition`s handed to `registry.register()`, and `mountPreset`, which
// is no longer re-exported from the package root — the registry's own live
// standing mounts are read back with `livePresetMounts()` instead.
import {
  AgentPresetRegistry,
  livePresetMounts,
  standingMountFor,
  type PresetDefinition,
} from '@deepseek-ai/dsh-agent-preset-registry'
import type { Agent, AgentRegistry, AgentSetup, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  installAgentIntegration,
  type AgentIntegrationHandle,
} from '../src/agent-integration.js'
import {
  FIXTURES,
  fixtureState,
  harness,
  makeWorkspace,
  resetFixtures,
  teardown,
  type Harness,
} from './helpers.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Published by the `isolated` fixture preset behind an entry-local realm. */
    presetIsolatedSvc: { label: string }
  }
}

/**
 * Absolute `file://` URL of one committed fixture plugin. With no roster root to
 * resolve against, a preset row names its plugin the way a host plugin is named.
 */
const fixturePlugin = (file: string): string => pathToFileURL(join(FIXTURES, 'plugins', file)).href

/** A one-row preset definition that seeds the given marker. */
function markerDefinition(id: string, marker: string): PresetDefinition {
  return {
    id,
    plugins: [{ id: 'marker', name: fixturePlugin('contribute.js'), config: { marker } }],
  }
}

/** A one-row preset definition publishing one service behind an isolate realm. */
function isolatedDefinition(id: string, service: string, label: string): PresetDefinition {
  return {
    id,
    plugins: [{
      id: 'svc',
      name: fixturePlugin('global-service.js'),
      isolate: { [service]: true },
      config: { service, label },
    }],
  }
}

/** The agent stand-in: the scope key itself, carrying the session cwd. */
interface StubAgent {
  id: string
  session: { header: { cwd?: string } }
  ctx: Context
  scope: Scope
}

interface StubPublish {
  agent: StubAgent
  dispose(): Promise<void>
}

/**
 * Minimal stand-in for the loop's setupAndPublish contract: mint the agent
 * scope (key = the agent), run setup, invoke the optional commit, and on
 * failure dispose the scope — which unwinds agentCtx effects, exactly like
 * the real factory.
 */
class StubRegistry {
  /** Populated on the shadow receiver by the caller, like the real service. */
  ctx: Context | undefined
  setupCalls = 0
  resumeCwd: string | undefined
  private seq = 0

  async create(options: CreateAgentOptions): Promise<StubPublish> {
    return this.publish(this.ctx!, options.setup, options.meta?.cwd)
  }

  async resume(options: CreateAgentOptions): Promise<StubPublish> {
    return this.publish(this.ctx!, options.setup, this.resumeCwd)
  }

  private async publish(
    ownerCtx: Context,
    setup: AgentSetup | undefined,
    cwd: string | undefined,
  ): Promise<StubPublish> {
    const agent = {
      id: `agent-${++this.seq}`,
      session: { header: { cwd } },
    } as unknown as StubAgent
    const scope = createScope(ownerCtx, agent as unknown as object)
    agent.ctx = scope.ctx.extend({ agent })
    try {
      this.setupCalls += 1
      const commit = await setup?.(agent.ctx, agent as unknown as Agent)
      commit?.commit()
    } catch (error) {
      await scope.dispose()
      throw error
    }
    return { agent, dispose: () => scope.dispose() }
  }
}

/**
 * Emulate the Cordis traceable shadow receiver: a proxy over the target that
 * overlays `ctx` (so `this.ctx` names the caller) while forwarding every other
 * read/write to the target, exactly like the real shadow.
 */
function shadowOf(target: object, ctx: Context): object {
  const props = Object.defineProperty(Object.create(null), 'ctx', {
    value: ctx,
    writable: false,
    enumerable: true,
  })
  return new Proxy(target, {
    get: (t, prop, receiver) =>
      prop in props && prop !== 'constructor'
        ? Reflect.get(props, prop, receiver)
        : Reflect.get(t, prop, receiver),
    set: (t, prop, value, receiver) =>
      prop in props && prop !== 'constructor'
        ? Reflect.set(props, prop, value, receiver)
        : Reflect.set(t, prop, value, receiver),
  })
}

function callAsShadow<T>(target: object, method: string, receiver: object, args: unknown[]): Promise<T> {
  const fn = (target as Record<string, unknown>)[method] as (...args: unknown[]) => unknown
  return fn.call(receiver, ...args) as Promise<T>
}

/** A booted runtime with the real preset registry and the full integration. */
interface IntegrationHost extends Harness {
  /** The official registry behind the `agentPresets` service name. */
  presets: AgentPresetRegistry
  /** The registry's own fiber, torn down last so its mounts go with it. */
  presetFiber: Fiber
  stub: StubRegistry
  integration: AgentIntegrationHandle
}

async function integrationHarness(): Promise<IntegrationHost> {
  const host = await harness()
  await host.ctx.plugin(SessionProjections)
  // The registry injects `loader` and `sessionProjections`, so it composes
  // after both. Its config is a selection policy, not a file roster.
  const presetFiber = await host.ctx.plugin(AgentPresetRegistry, { default: 'standard' })
  const presets = host.ctx.get('agentPresets') as unknown as AgentPresetRegistry
  const stub = new StubRegistry()
  host.ctx.provide('agents', stub as unknown as AgentRegistry)
  const integration = installAgentIntegration(host.ctx)
  return { ...host, presets, presetFiber, stub, integration }
}

/**
 * Declare one preset on the live registry.
 *
 * `register()` eagerly activates the definition, which mounts the registry's own
 * standing composition and runs the fixture row once. That activation is not
 * what these tests observe — they observe the workspace-local generations the
 * decorators compose — so the fixture log is cleared right after declaring.
 *
 * @returns The definition disposer, for tests that need a revision change.
 */
async function declarePreset(definition: PresetDefinition): Promise<() => Promise<void>> {
  const off = await host.presets.register(definition)
  resetFixtures()
  return off
}

/** The setup the official Web factory uses: mount one preset in setup. */
function mountSetup(host: IntegrationHost, presetId: string): AgentSetup {
  return async (agentCtx: Context): Promise<void> => {
    await host.ctx.agentPresets.mount(agentCtx, presetId)
  }
}

let host: IntegrationHost

beforeEach(async () => {
  resetFixtures()
  host = await integrationHarness()
})

afterEach(async () => {
  // The live-mount set is module state spanning every Cordis runtime in the
  // process, so the registry fiber goes down before the harness temp root is
  // removed; otherwise a later test's `revisionOf()` reads a stale mount.
  await host.presetFiber.dispose()
  await teardown(host)
})

describe('the agentPresets mount decorator', () => {
  /** Create one agent through the decorated registry, exactly as Web does. */
  async function createAgent(cwd: string, setup?: AgentSetup): Promise<StubPublish> {
    const sessionId = `s-${host.stub.setupCalls}` as CreateAgentOptions['sessionId']
    return callAsShadow<StubPublish>(host.stub, 'create', shadowOf(host.stub, host.ctx), [
      { sessionId, meta: { cwd }, setup },
    ])
  }

  function recordOf(agent: StubAgent) {
    const record = host.integration.coordinator.recordFor(agent as unknown as object)
    if (!record) throw new Error('agent has no live binding record')
    return record
  }

  it('composes a workspace-local generation under the agent\'s workspace', async () => {
    await declarePreset(markerDefinition('standard', 'standard'))
    const ws = await makeWorkspace(host.root, 'ws')

    const created = await createAgent(ws, mountSetup(host, 'standard'))
    const record = recordOf(created.agent)

    expect(record.preset?.presetId).toBe('standard')
    // The agent's direct parent is the generation key, under the workspace.
    expect(scopeParentOf(created.agent as unknown as object)).toBe(record.preset!.key)
    expect(scopeParentOf(record.preset!.key)).toBe(record.lease.key)
    // The preset row's registrations landed in the generation scope.
    expect(fixtureState().markers).toEqual(['standard'])
    expect(scopeOf(fixtureState().contexts[0]!)).toBe(record.preset!.key)
    expect(host.registry.size).toBe(1)
  })

  it('shares one generation between two agents of the same workspace and preset', async () => {
    await declarePreset(markerDefinition('standard', 'standard'))
    const ws = await makeWorkspace(host.root, 'ws')

    const first = await createAgent(ws, mountSetup(host, 'standard'))
    const second = await createAgent(ws, mountSetup(host, 'standard'))

    const firstGen = recordOf(first.agent).preset!
    const secondGen = recordOf(second.agent).preset!
    expect(secondGen).toBe(firstGen)
    expect(firstGen.joined).toBe(2)
    // One mount for both agents.
    expect(fixtureState().markers).toEqual(['standard'])
    expect(host.registry.size).toBe(1)
  })

  it('keeps generations isolated across workspaces', async () => {
    await declarePreset(markerDefinition('standard', 'standard'))
    const wsA = await makeWorkspace(host.root, 'a')
    const wsB = await makeWorkspace(host.root, 'b')

    const a = await createAgent(wsA, mountSetup(host, 'standard'))
    const b = await createAgent(wsB, mountSetup(host, 'standard'))

    expect(recordOf(a.agent).preset).not.toBe(recordOf(b.agent).preset)
    expect(recordOf(a.agent).preset!.key).not.toBe(recordOf(b.agent).preset!.key)
    expect(host.registry.size).toBe(2)
  })

  it('rejects a mount on an agent with no workspace binding', async () => {
    await declarePreset(markerDefinition('standard', 'standard'))
    const scope = createScope(host.ctx, {})

    await expect(host.ctx.agentPresets.mount(scope.ctx, 'standard'))
      .rejects.toThrow(/no workspace binding/)

    await scope.dispose()
  })

  it('rejects a preset whose plugin cannot be imported before any mount attempt', async () => {
    // The row names a file that does not exist: activation fails and the
    // registry reports the definition broken.
    await declarePreset({
      id: 'ghost',
      plugins: [{ id: 'nope', name: fixturePlugin('does-not-exist.js') }],
    })
    const ws = await makeWorkspace(host.root, 'ws')

    await expect(createAgent(ws, mountSetup(host, 'ghost'))).rejects.toMatchObject({ code: 'agent-preset/invalid' })
    expect(fixtureState().markers).toEqual([])
    expect(host.registry.size).toBe(0)
    expect(host.integration.coordinator.size).toBe(0)
  })

  it('rejects a preset whose row never reaches a usable state', async () => {
    // The row activates but waits forever for a service the composition never
    // supplies. 0.1.7 reports that through the row audit rather than an import
    // failure, so it is a distinct case from the missing file above.
    await declarePreset({
      id: 'stuck',
      plugins: [{ id: 'nm', name: fixturePlugin('needs-missing.js') }],
    })
    const ws = await makeWorkspace(host.root, 'ws')

    await expect(createAgent(ws, mountSetup(host, 'stuck'))).rejects.toMatchObject({ code: 'agent-preset/invalid' })
    // The failed setup unwound the agent scope, releasing lease and join.
    expect(host.registry.size).toBe(0)
    expect(host.integration.coordinator.size).toBe(0)
  })

  it('keeps the workspace-local generation out of the official standing-mount readers', async () => {
    // 0.1.7 keeps the standing-mount set module-private and exposes no way to
    // join it, so the overlay's per-workspace subtree is invisible to
    // `standingMountFor()` / `composedPreset()` / `serviceFor()` — the gap
    // documented at the top of src/workspace-presets.ts. The agent's exact
    // generation stays readable through the coordinator record instead.
    await declarePreset(isolatedDefinition('isolated', 'presetIsolatedSvc', 'ISOLATED'))
    const ws = await makeWorkspace(host.root, 'ws')

    const isolated = await createAgent(ws, mountSetup(host, 'isolated'))

    expect(standingMountFor(isolated.agent.ctx)).toBeUndefined()
    expect(host.ctx.agentPresets.composedPreset(isolated.agent.ctx)).toBeUndefined()
    expect(host.ctx.agentPresets.serviceFor(isolated.agent, 'presetIsolatedSvc')).toBeUndefined()
    // The generation itself is real: mounted, joined, and reachable by record.
    const record = recordOf(isolated.agent)
    expect(record.preset?.presetId).toBe('isolated')
    expect(record.preset?.joined).toBe(1)
    expect(scopeParentOf(isolated.agent as unknown as object)).toBe(record.preset!.key)
  })

  it('answers official serviceFor through the registry standing mount', async () => {
    // Positive control for the gap above: the reader itself works. An agent
    // joined to the registry's OWN standing mount resolves the isolated
    // service the preset published behind an isolate realm.
    await declarePreset(isolatedDefinition('isolated', 'presetIsolatedSvc', 'ISOLATED'))
    const standing = livePresetMounts().find(mount => mount.presetId === 'isolated')!

    const joinedKey = {}
    const joined = createScope(host.ctx, joinedKey)
    bindScopeParent(joinedKey, standing.key!)

    expect(standingMountFor(joined.ctx)?.key).toBe(standing.key)
    expect(host.ctx.agentPresets.serviceFor({ ctx: joined.ctx }, 'presetIsolatedSvc'))
      .toEqual({ label: 'ISOLATED' })

    await joined.dispose()
  })
})

describe('the composeFrom decorator', () => {
  async function createAgent(cwd: string, setup?: AgentSetup): Promise<StubPublish> {
    const sessionId = `s-${host.stub.setupCalls}` as CreateAgentOptions['sessionId']
    return callAsShadow<StubPublish>(host.stub, 'create', shadowOf(host.stub, host.ctx), [
      { sessionId, meta: { cwd }, setup },
    ])
  }

  function recordOf(agent: StubAgent) {
    const record = host.integration.coordinator.recordFor(agent as unknown as object)
    if (!record) throw new Error('agent has no live binding record')
    return record
  }

  it('inherits the parent\'s EXACT generation, synchronously, without I/O', async () => {
    await declarePreset(markerDefinition('standard', 'standard'))
    const ws = await makeWorkspace(host.root, 'ws')
    const parent = await createAgent(ws, mountSetup(host, 'standard'))
    const parentGen = recordOf(parent.agent).preset!

    // The official subagent driver calls composeFrom inside a SYNCHRONOUS
    // setup; the result must be the preset id, not a promise.
    let inherited: unknown
    const child = await createAgent(ws, (childCtx: Context): void => {
      inherited = host.ctx.agentPresets.composeFrom(childCtx, parent.agent.ctx)
    })

    expect(inherited).toBe('standard')
    expect(recordOf(child.agent).preset).toBe(parentGen)
    expect(parentGen.joined).toBe(2)
    expect(scopeParentOf(child.agent as unknown as object)).toBe(parentGen.key)
  })

  it('keeps the child on its own workspace layer when the parent is rosterless', async () => {
    const ws = await makeWorkspace(host.root, 'ws')
    const parent = await createAgent(ws)

    let inherited: unknown
    const child = await createAgent(ws, (childCtx: Context): void => {
      inherited = host.ctx.agentPresets.composeFrom(childCtx, parent.agent.ctx)
    })

    expect(inherited).toBeUndefined()
    expect(recordOf(child.agent).preset).toBeUndefined()
    expect(scopeParentOf(child.agent as unknown as object)).toBe(recordOf(child.agent).lease.key)
  })

  it('rejects a child with no workspace binding', async () => {
    await declarePreset(markerDefinition('standard', 'standard'))
    const ws = await makeWorkspace(host.root, 'ws')
    const parent = await createAgent(ws, mountSetup(host, 'standard'))
    const scope = createScope(host.ctx, {})

    expect(() => host.ctx.agentPresets.composeFrom(scope.ctx, parent.agent.ctx))
      .toThrow(/no workspace binding/)

    await scope.dispose()
  })

  it('rejects a cross-workspace inheritance and rolls the child back', async () => {
    await declarePreset(markerDefinition('standard', 'standard'))
    const wsA = await makeWorkspace(host.root, 'a')
    const wsB = await makeWorkspace(host.root, 'b')
    const parent = await createAgent(wsA, mountSetup(host, 'standard'))

    await expect(createAgent(wsB, (childCtx: Context): void => {
      host.ctx.agentPresets.composeFrom(childCtx, parent.agent.ctx)
    })).rejects.toThrow(/across workspaces/)

    // The child's setup failure released its lease; the parent's workspace
    // and binding stay.
    expect(host.registry.size).toBe(1)
    expect(host.integration.coordinator.size).toBe(1)
  })

  it('rejects a parent composed outside this workspace binding', async () => {
    await declarePreset(markerDefinition('standard', 'standard'))
    const ws = await makeWorkspace(host.root, 'ws')
    // A foreign parent: minted outside the decorated registry and parented to
    // the registry's own standing mount, so an official standing mount exists
    // but no coordinator record does. 0.1.7 no longer exports `mountPreset`,
    // so the standing mount is read back from the live registry rather than
    // built by hand.
    const standing = livePresetMounts().find(mount => mount.presetId === 'standard')!
    const foreignKey = {}
    const foreignScope = createScope(host.ctx, foreignKey)
    bindScopeParent(foreignKey, standing.key!)
    expect(standingMountFor(foreignScope.ctx)?.key).toBe(standing.key)

    let error: unknown
    await createAgent(ws, (childCtx: Context): void => {
      try {
        host.ctx.agentPresets.composeFrom(childCtx, foreignScope.ctx)
      } catch (caught) {
        error = caught
      }
    })
    expect(String(error)).toMatch(/outside this workspace binding/)

    await foreignScope.dispose()
  })
})

describe('the recompose decorator', () => {
  async function createAgent(cwd: string, setup?: AgentSetup): Promise<StubPublish> {
    const sessionId = `s-${host.stub.setupCalls}` as CreateAgentOptions['sessionId']
    return callAsShadow<StubPublish>(host.stub, 'create', shadowOf(host.stub, host.ctx), [
      { sessionId, meta: { cwd }, setup },
    ])
  }

  function recordOf(agent: StubAgent) {
    const record = host.integration.coordinator.recordFor(agent as unknown as object)
    if (!record) throw new Error('agent has no live binding record')
    return record
  }

  it('switches generations with balanced joined counts and reuses same-stamp generations', async () => {
    await declarePreset(markerDefinition('standard', 'std'))
    await declarePreset(markerDefinition('minimal', 'min'))
    const ws = await makeWorkspace(host.root, 'ws')
    const created = await createAgent(ws, mountSetup(host, 'standard'))
    const stdGen = recordOf(created.agent).preset!
    expect(stdGen.joined).toBe(1)

    const result = await host.ctx.agentPresets.recompose(created.agent.ctx, 'minimal')
    expect(result.id).toBe('minimal')

    const minGen = recordOf(created.agent).preset!
    expect(minGen).not.toBe(stdGen)
    expect(minGen.presetId).toBe('minimal')
    expect(stdGen.joined).toBe(0)
    expect(minGen.joined).toBe(1)
    expect(scopeParentOf(created.agent as unknown as object)).toBe(minGen.key)

    // Recomposing back reuses the still-current 'standard' generation.
    await host.ctx.agentPresets.recompose(created.agent.ctx, 'standard')
    expect(recordOf(created.agent).preset).toBe(stdGen)
    expect(stdGen.joined).toBe(1)
    expect(minGen.joined).toBe(0)
  })

  it('rejects an unknown or broken preset and leaves the agent unchanged', async () => {
    await declarePreset(markerDefinition('standard', 'std'))
    await declarePreset({
      id: 'broken',
      plugins: [{ id: 'nm', name: fixturePlugin('needs-missing.js') }],
    })
    const ws = await makeWorkspace(host.root, 'ws')
    const created = await createAgent(ws, mountSetup(host, 'standard'))
    const before = recordOf(created.agent).preset!

    await expect(host.ctx.agentPresets.recompose(created.agent.ctx, 'broken'))
      .rejects.toMatchObject({ code: 'agent-preset/invalid' })
    expect(recordOf(created.agent).preset).toBe(before)
    expect(scopeParentOf(created.agent as unknown as object)).toBe(before.key)
    expect(before.joined).toBe(1)

    // 0.1.7 reports an unknown id as a typed not-found rather than the old
    // free-form "not found" text.
    await expect(host.ctx.agentPresets.recompose(created.agent.ctx, 'missing-id'))
      .rejects.toMatchObject({ code: 'agent-preset/not-found' })
    await expect(host.ctx.agentPresets.recompose(created.agent.ctx, 'missing-id'))
      .rejects.toThrow(/Unknown agent preset/)
    expect(recordOf(created.agent).preset).toBe(before)
  })

  it('disposes the superseded generation once its last agent leaves it', async () => {
    const offV1 = await declarePreset(markerDefinition('standard', 'v1'))
    const ws = await makeWorkspace(host.root, 'ws')
    const first = await createAgent(ws, mountSetup(host, 'standard'))
    const oldGen = recordOf(first.agent).preset!
    const second = await createAgent(ws, mountSetup(host, 'standard'))
    expect(recordOf(second.agent).preset).toBe(oldGen)
    expect(oldGen.joined).toBe(2)

    // 0.1.7's revision identity is the registry's live standing-mount key, so
    // re-registering the definition is the "the composition changed" signal
    // the file's stat stamp used to be: the next ensure() starts a fresh
    // generation while the old one stays joined by the second agent.
    await offV1()
    const offV2 = await declarePreset(markerDefinition('standard', 'v2-longer-marker'))
    const fresh = await host.ctx.agentPresets.recompose(first.agent.ctx, 'standard')
    expect(fresh.id).toBe('standard')
    const newGen = recordOf(first.agent).preset!
    expect(newGen).not.toBe(oldGen)
    expect(oldGen.joined).toBe(1)
    expect(oldGen.disposed).toBe(false)
    expect(newGen.joined).toBe(1)

    // The second agent recomposes onto the new generation: the old one reaches
    // joined zero and is disposed.
    await host.ctx.agentPresets.recompose(second.agent.ctx, 'standard')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(oldGen.joined).toBe(0)
    expect(oldGen.disposed).toBe(true)

    await offV2()
  })
})

describe('agent teardown through the integration', () => {
  async function createAgent(cwd: string, setup?: AgentSetup): Promise<StubPublish> {
    const sessionId = `s-${host.stub.setupCalls}` as CreateAgentOptions['sessionId']
    return callAsShadow<StubPublish>(host.stub, 'create', shadowOf(host.stub, host.ctx), [
      { sessionId, meta: { cwd }, setup },
    ])
  }

  it('releases the join and the workspace lease on agent disposal', async () => {
    await declarePreset(markerDefinition('standard', 'standard'))
    const ws = await makeWorkspace(host.root, 'ws')
    const created = await createAgent(ws, mountSetup(host, 'standard'))
    const gen = host.integration.coordinator.recordFor(created.agent as unknown as object)!.preset!
    expect(gen.joined).toBe(1)
    expect(host.registry.size).toBe(1)

    await created.dispose()

    expect(gen.joined).toBe(0)
    expect(host.integration.coordinator.size).toBe(0)
    expect(host.registry.size).toBe(0)
  })

  it('dispose restores all five wrapped methods in reverse order', async () => {
    await declarePreset(markerDefinition('standard', 'standard'))
    const ws = await makeWorkspace(host.root, 'ws')
    const created = await createAgent(ws, mountSetup(host, 'standard'))
    const rawPresets = (host.ctx.agentPresets as unknown as { [symbols.original]?: unknown })[symbols.original]

    for (const [target, method] of [
      [host.stub, 'create'],
      [host.stub, 'resume'],
      [rawPresets, 'mount'],
      [rawPresets, 'composeFrom'],
      [rawPresets, 'recompose'],
    ] as const) {
      expect(Object.hasOwn(target as object, method)).toBe(true)
    }

    host.integration.dispose()

    for (const [target, method] of [
      [host.stub, 'create'],
      [host.stub, 'resume'],
      [rawPresets, 'mount'],
      [rawPresets, 'composeFrom'],
      [rawPresets, 'recompose'],
    ] as const) {
      expect(Object.hasOwn(target as object, method)).toBe(false)
    }
    // The class prototype methods are reachable again, unwrapped.
    expect(typeof Object.getPrototypeOf(rawPresets).mount).toBe('function')
    expect(typeof Object.getPrototypeOf(rawPresets).composeFrom).toBe('function')
    expect(typeof Object.getPrototypeOf(rawPresets).recompose).toBe('function')

    // A plain agent still runs on its workspace-local generation after the
    // revert (the binding itself is untouched by the method restore).
    expect(scopeParentOf(created.agent as unknown as object)).toBe(
      host.integration.coordinator.recordFor(created.agent as unknown as object)!.preset!.key,
    )
    await created.dispose()
  })
})
