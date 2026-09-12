import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, symbols } from '@deepseek-ai/cordis'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import {
  bindScopeParent,
  createScope,
  scopeOf,
  scopeParentOf,
  type Scope,
} from '@deepseek-ai/dsh-scope'
import {
  mountPreset,
  standingMountFor,
  AgentPresets,
  type AgentPreset,
  type Config as RosterConfig,
} from '@deepseek-ai/dsh-agent-presets'
import type { Agent, AgentRegistry, AgentSetup, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installAgentIntegration,
  type AgentIntegrationHandle,
} from '../src/agent-integration.js'
import {
  fixtureState,
  harness,
  isolatedPreset,
  makeWorkspace,
  markerPreset,
  resetFixtures,
  seedPreset,
  teardown,
  type Harness,
} from './helpers.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Published by the `isolated` fixture preset behind an entry-local realm. */
    presetIsolatedSvc: { label: string }
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

/** A booted runtime with the real preset roster and the full integration. */
interface IntegrationHost extends Harness {
  presetsRoot: string
  stub: StubRegistry
  integration: AgentIntegrationHandle
}

async function integrationHarness(): Promise<IntegrationHost> {
  const host = await harness()
  const presetsRoot = await mkdtemp(join(tmpdir(), 'dsh-ws-decorator-'))
  const roster: RosterConfig = {
    default: 'standard',
    roots: [{ path: presetsRoot, trust: 'system' }],
    includeUserRoot: false,
    includeShippedRoot: false,
  }
  await host.ctx.plugin(SessionProjections)
  await host.ctx.plugin(AgentPresets, roster)
  const stub = new StubRegistry()
  host.ctx.provide('agents', stub as unknown as AgentRegistry)
  const integration = installAgentIntegration(host.ctx)
  return { ...host, presetsRoot, stub, integration }
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
  await rm(host.presetsRoot, { recursive: true, force: true })
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

  it('composes a workspace-local generation and the official readers hit it', async () => {
    await seedPreset(host.presetsRoot, 'standard', markerPreset('standard'))
    const ws = await makeWorkspace(host.root, 'ws')

    const created = await createAgent(ws, mountSetup(host, 'standard'))
    const record = recordOf(created.agent)

    expect(record.preset?.presetId).toBe('standard')
    // The agent's direct parent is the generation key, under the workspace.
    expect(scopeParentOf(created.agent as unknown as object)).toBe(record.preset!.key)
    expect(scopeParentOf(record.preset!.key)).toBe(record.lease.key)
    // Official readers resolve the generation through the standing registry.
    const standing = standingMountFor(created.agent.ctx)
    expect(standing?.presetId).toBe('standard')
    expect(standing?.key).toBe(record.preset!.key)
    expect(host.ctx.agentPresets.composedPreset(created.agent.ctx)).toBe('standard')
    // The preset row's registrations landed in the generation scope.
    expect(fixtureState().markers).toEqual(['standard'])
    expect(scopeOf(fixtureState().contexts[0]!)).toBe(record.preset!.key)
    expect(host.registry.size).toBe(1)
  })

  it('shares one generation between two agents of the same workspace and preset', async () => {
    await seedPreset(host.presetsRoot, 'standard', markerPreset('standard'))
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
    await seedPreset(host.presetsRoot, 'standard', markerPreset('standard'))
    const wsA = await makeWorkspace(host.root, 'a')
    const wsB = await makeWorkspace(host.root, 'b')

    const a = await createAgent(wsA, mountSetup(host, 'standard'))
    const b = await createAgent(wsB, mountSetup(host, 'standard'))

    expect(recordOf(a.agent).preset).not.toBe(recordOf(b.agent).preset)
    expect(recordOf(a.agent).preset!.key).not.toBe(recordOf(b.agent).preset!.key)
    expect(host.registry.size).toBe(2)
  })

  it('rejects a mount on an agent with no workspace binding', async () => {
    await seedPreset(host.presetsRoot, 'standard', markerPreset('standard'))
    const scope = createScope(host.ctx, {})

    await expect(host.ctx.agentPresets.mount(scope.ctx, 'standard'))
      .rejects.toThrow(/no workspace binding/)

    await scope.dispose()
  })

  it('rejects a discovery-broken preset before any mount attempt', async () => {
    // Unparsable composition: discovery reports the preset broken.
    await seedPreset(host.presetsRoot, 'ghost', '- id: x\n  name: [unclosed\n')
    const ws = await makeWorkspace(host.root, 'ws')

    await expect(createAgent(ws, mountSetup(host, 'ghost'))).rejects.toMatchObject({ code: 'agent-preset/invalid' })
    expect(fixtureState().markers).toEqual([])
    expect(host.registry.size).toBe(0)
    expect(host.integration.coordinator.size).toBe(0)
  })

  it('rejects an unusable mount and leaves the agent unpublished', async () => {
    await seedPreset(host.presetsRoot, 'broken', '- id: nope\n  name: ./plugins/does-not-exist.js\n')
    const ws = await makeWorkspace(host.root, 'ws')

    await expect(createAgent(ws, mountSetup(host, 'broken'))).rejects.toMatchObject({ code: 'agent-preset/invalid' })
    // The failed setup unwound the agent scope, releasing lease and join.
    expect(host.registry.size).toBe(0)
    expect(host.integration.coordinator.size).toBe(0)
  })

  it('answers official serviceFor with the workspace-local generation', async () => {
    await seedPreset(host.presetsRoot, 'isolated', isolatedPreset('presetIsolatedSvc', 'ISOLATED'))
    const ws = await makeWorkspace(host.root, 'ws')

    const isolated = await createAgent(ws, mountSetup(host, 'isolated'))
    expect(host.ctx.agentPresets.serviceFor(isolated.agent, 'presetIsolatedSvc'))
      .toEqual({ label: 'ISOLATED' })

    // Another agent on a different preset cannot reach into this generation.
    await seedPreset(host.presetsRoot, 'standard', markerPreset('standard'))
    const standard = await createAgent(ws, mountSetup(host, 'standard'))
    expect(host.ctx.agentPresets.serviceFor(standard.agent, 'presetIsolatedSvc')).toBeUndefined()
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
    await seedPreset(host.presetsRoot, 'standard', markerPreset('standard'))
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
    await seedPreset(host.presetsRoot, 'standard', markerPreset('standard'))
    const ws = await makeWorkspace(host.root, 'ws')
    const parent = await createAgent(ws, mountSetup(host, 'standard'))
    const scope = createScope(host.ctx, {})

    expect(() => host.ctx.agentPresets.composeFrom(scope.ctx, parent.agent.ctx))
      .toThrow(/no workspace binding/)

    await scope.dispose()
  })

  it('rejects a cross-workspace inheritance and rolls the child back', async () => {
    await seedPreset(host.presetsRoot, 'standard', markerPreset('standard'))
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
    await seedPreset(host.presetsRoot, 'standard', markerPreset('standard'))
    const ws = await makeWorkspace(host.root, 'ws')
    // A foreign parent: minted outside the decorated registry, mounted through
    // the official mountPreset into its own standing scope, and parented to it
    // — so an official standing mount exists but no coordinator record does.
    const preset: AgentPreset = {
      id: 'standard',
      trust: 'system',
      path: join(host.presetsRoot, 'standard', 'agent.cordis.yml'),
    }
    const standingKey = {}
    const standingScope = createScope(host.ctx, standingKey)
    await mountPreset(standingScope.ctx, preset)
    const foreignKey = {}
    const foreignScope = createScope(host.ctx, foreignKey)
    bindScopeParent(foreignKey, standingKey)
    expect(standingMountFor(foreignScope.ctx)?.key).toBe(standingKey)

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
    await standingScope.dispose()
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
    await seedPreset(host.presetsRoot, 'standard', markerPreset('std'))
    await seedPreset(host.presetsRoot, 'minimal', markerPreset('min'))
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
    await seedPreset(host.presetsRoot, 'standard', markerPreset('std'))
    await seedPreset(host.presetsRoot, 'broken', '- id: nope\n  name: ./plugins/does-not-exist.js\n')
    const ws = await makeWorkspace(host.root, 'ws')
    const created = await createAgent(ws, mountSetup(host, 'standard'))
    const before = recordOf(created.agent).preset!

    await expect(host.ctx.agentPresets.recompose(created.agent.ctx, 'broken'))
      .rejects.toMatchObject({ code: 'agent-preset/invalid' })
    expect(recordOf(created.agent).preset).toBe(before)
    expect(scopeParentOf(created.agent as unknown as object)).toBe(before.key)
    expect(before.joined).toBe(1)

    await expect(host.ctx.agentPresets.recompose(created.agent.ctx, 'missing-id'))
      .rejects.toThrow(/not found/)
    expect(recordOf(created.agent).preset).toBe(before)
  })

  it('disposes the superseded generation once its last agent leaves it', async () => {
    await seedPreset(host.presetsRoot, 'standard', markerPreset('v1'))
    const ws = await makeWorkspace(host.root, 'ws')
    const first = await createAgent(ws, mountSetup(host, 'standard'))
    const oldGen = recordOf(first.agent).preset!
    const second = await createAgent(ws, mountSetup(host, 'standard'))
    expect(recordOf(second.agent).preset).toBe(oldGen)
    expect(oldGen.joined).toBe(2)

    // A visible file change starts a new generation; the old one is superseded
    // and still joined by the second agent, so it must not be disposed yet.
    const path = join(host.presetsRoot, 'standard', 'agent.cordis.yml')
    await writeFile(path, markerPreset('v2-longer-marker'))
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
    await seedPreset(host.presetsRoot, 'standard', markerPreset('standard'))
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
    await seedPreset(host.presetsRoot, 'standard', markerPreset('standard'))
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
