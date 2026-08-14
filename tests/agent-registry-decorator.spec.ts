import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope, scopeOf, type Scope } from '@deepseek-ai/dsh-scope'
import type {
  AgentRegistry,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installAgentRegistryDecorators } from '../src/agent-registry-decorator.js'
import { AgentBindingCoordinator } from '../src/coordinator.js'
import { harness, teardown, type Harness } from './helpers.js'

/** The agent stand-in: the scope key itself, carrying the session cwd. */
interface StubAgent {
  id: string
  session: { header: { cwd?: string } }
  ctx: Context
  scope: Scope
}

interface StubPublish {
  agent: StubAgent
  /** The caller context the registry saw as `this.ctx` (the owner). */
  ownerCtx: Context
  dispose(): Promise<void>
}

/**
 * Minimal stand-in for the loop's setupAndPublish contract: mint the agent
 * scope (key = the agent), run setup, invoke the optional commit, and only on
 * failure dispose the scope — which unwinds agentCtx effects, exactly like
 * the real factory.
 */
class StubRegistry {
  /** Populated on the shadow receiver by the caller, like the real service. */
  ctx: Context | undefined
  setupCalls = 0
  resumeCwd: string | undefined
  /** Runs right after the agent scope is minted, before setup. */
  beforeSetup: ((agent: StubAgent) => void) | undefined
  /** When true, setup receives a plain context with no scope tag. */
  unscoped = false
  private seq = 0

  async create(options: CreateAgentOptions): Promise<StubPublish> {
    // Mirrors the real AgentRegistry: `this.ctx` is the shadow receiver's
    // context, i.e. the caller's owner context.
    return this.publish(this.ctx!, options.setup, options.meta?.cwd)
  }

  async resume(options: ResumeAgentOptions): Promise<StubPublish> {
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
    let scope: Scope | undefined
    if (this.unscoped) {
      agent.ctx = new Context()
    } else {
      scope = createScope(ownerCtx, agent as unknown as object)
      agent.ctx = scope.ctx.extend({ agent })
      this.beforeSetup?.(agent)
    }
    try {
      this.setupCalls += 1
      const commit = await setup?.(agent.ctx)
      commit?.commit()
    } catch (error) {
      await scope?.dispose()
      throw error
    }
    return { agent, ownerCtx, dispose: () => scope!.dispose() }
  }
}

/** Records every commit invocation on a shared log. */
class RecordingCoordinator extends AgentBindingCoordinator {
  constructor(private readonly log: string[]) {
    super()
  }

  override commit(agentKey: object): void {
    this.log.push('coordinator')
    super.commit(agentKey)
  }
}

let host: Harness
let root: string

beforeEach(async () => {
  host = await harness()
  root = await mkdtemp(join(tmpdir(), 'dsh-ws-decorator-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await teardown(host)
})

describe('installAgentRegistryDecorators', () => {
  function setup(log: string[] = []): {
    stub: StubRegistry
    coordinator: RecordingCoordinator
    callerCtx: Context
    dispose: () => void
  } {
    const stub = new StubRegistry()
    const coordinator = new RecordingCoordinator(log)
    const handle = installAgentRegistryDecorators(
      stub as unknown as AgentRegistry,
      coordinator,
      host.registry,
    )
    return { stub, coordinator, callerCtx: new Context(), dispose: () => handle.dispose() }
  }

  /**
   * Emulate the Cordis traceable shadow receiver: a proxy over the target
   * that overlays `ctx` (so `this.ctx` names the caller) while forwarding
   * every other read/write to the target — private fields and helpers stay
   * reachable, exactly like the real shadow.
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

  /** Invoke the installed method through a shadow receiver, as consumers do. */
  function callAsShadow<T>(target: object, method: string, receiver: object, args: unknown[]): Promise<T> {
    const fn = (target as Record<string, unknown>)[method] as (...args: unknown[]) => unknown
    return fn.call(receiver, ...args) as Promise<T>
  }

  it('rewrites create setup, preserves the traceable shadow this, and holds the lease until scope dispose', async () => {
    const ws = join(root, 'ws')
    await mkdir(ws)
    const { stub, coordinator, callerCtx, dispose } = setup()
    const seen: { key?: object } = {}
    const callerSetup = (agentCtx: Context): void => {
      seen.key = scopeOf(agentCtx)
    }

    const result = await callAsShadow<StubPublish>(stub, 'create', shadowOf(stub, callerCtx), [
      {
        sessionId: 's1' as CreateAgentOptions['sessionId'],
        meta: { cwd: ws },
        setup: callerSetup,
      },
    ])

    // The shadow receiver flowed through the installed wrapper into the
    // original: the registry saw the caller's context as its owner.
    expect(result.ownerCtx).toBe(callerCtx)
    expect(stub.setupCalls).toBe(1)
    // The scope key is the agent itself; the setup read its session cwd.
    expect(seen.key === result.agent).toBe(true)
    expect(coordinator.recordFor(result.agent)?.lease.canonical).toBe(await realpath(ws))

    // Success: the lease outlives publish and is only released on scope dispose.
    expect(host.registry.size).toBe(1)
    await result.dispose()
    expect(host.registry.size).toBe(0)
    expect(coordinator.size).toBe(0)
    dispose()
  })

  it('rewrites resume setup the same way', async () => {
    const ws = join(root, 'ws')
    await mkdir(ws)
    const { stub, coordinator, callerCtx, dispose } = setup()
    stub.resumeCwd = ws
    const seen: { key?: object } = {}
    const callerSetup = (agentCtx: Context): void => {
      seen.key = scopeOf(agentCtx)
    }

    const result = await callAsShadow<StubPublish>(stub, 'resume', shadowOf(stub, callerCtx), [
      { resumeSessionId: 's1' as ResumeAgentOptions['resumeSessionId'], setup: callerSetup },
    ])

    expect(result.ownerCtx).toBe(callerCtx)
    expect(seen.key).toBe(result.agent)
    expect(host.registry.size).toBe(1)
    await result.dispose()
    expect(host.registry.size).toBe(0)
    dispose()
  })

  it('rejects an unscoped setup context', async () => {
    const ws = join(root, 'ws')
    await mkdir(ws)
    const { stub, dispose } = setup()
    stub.unscoped = true

    await expect(
      callAsShadow(stub, 'create', shadowOf(stub, new Context()), [
        {
          sessionId: 's1' as CreateAgentOptions['sessionId'],
          meta: { cwd: ws },
          setup: (): void => {},
        },
      ]),
    ).rejects.toThrow(/unscoped/)
    expect(host.registry.size).toBe(0)
    dispose()
  })

  it('rejects a missing or relative cwd without falling back to process.cwd', async () => {
    const { stub, dispose } = setup()
    await expect(
      callAsShadow(stub, 'create', shadowOf(stub, new Context()), [
        { sessionId: 's1' as CreateAgentOptions['sessionId'], meta: {}, setup: undefined },
      ]),
    ).rejects.toThrow(/cwd/)
    await expect(
      callAsShadow(stub, 'create', shadowOf(stub, new Context()), [
        {
          sessionId: 's2' as CreateAgentOptions['sessionId'],
          meta: { cwd: 'relative/path' },
          setup: undefined,
        },
      ]),
    ).rejects.toThrow(/cwd/)
    expect(host.registry.size).toBe(0)
    dispose()
  })

  it('rejects when the workspace acquire fails (missing directory)', async () => {
    const { stub, dispose } = setup()
    await expect(
      callAsShadow(stub, 'create', shadowOf(stub, new Context()), [
        {
          sessionId: 's1' as CreateAgentOptions['sessionId'],
          meta: { cwd: join(root, 'nope') },
          setup: undefined,
        },
      ]),
    ).rejects.toThrow(/does not exist/)
    expect(host.registry.size).toBe(0)
    dispose()
  })

  it('releases the acquired lease manually when the bind fails', async () => {
    const ws = join(root, 'ws')
    await mkdir(ws)
    const { stub, callerCtx, dispose } = setup()
    // Simulate the official agentPresets provider having bound the key first:
    // the coordinator bind then fails and must release the fresh lease.
    stub.beforeSetup = (agent) => {
      bindScopeParent(agent as unknown as object, {})
    }

    await expect(
      callAsShadow(stub, 'create', shadowOf(stub, callerCtx), [
        {
          sessionId: 's1' as CreateAgentOptions['sessionId'],
          meta: { cwd: ws },
          setup: undefined,
        },
      ]),
    ).rejects.toThrow()
    expect(host.registry.size).toBe(0)
    dispose()
  })

  it('releases exactly once when the caller setup throws', async () => {
    const ws = join(root, 'ws')
    await mkdir(ws)
    const { stub, callerCtx, dispose } = setup()
    const callerSetup = (): never => {
      throw new Error('caller setup boom')
    }

    await expect(
      callAsShadow(stub, 'create', shadowOf(stub, callerCtx), [
        {
          sessionId: 's1' as CreateAgentOptions['sessionId'],
          meta: { cwd: ws },
          setup: callerSetup,
        },
      ]),
    ).rejects.toThrow('caller setup boom')
    // The agent scope unwound, the effect disposer released the lease, and no
    // entry survives for a double release to hit.
    expect(host.registry.size).toBe(0)
    expect(host.registry.get(ws)).toBeUndefined()
    dispose()
  })

  it('releases once when the caller commit throws', async () => {
    const ws = join(root, 'ws')
    await mkdir(ws)
    const { stub, callerCtx, dispose } = setup()
    const callerSetup = (): { commit: () => never } => ({
      commit: () => {
        throw new Error('caller commit boom')
      },
    })

    await expect(
      callAsShadow(stub, 'create', shadowOf(stub, callerCtx), [
        {
          sessionId: 's1' as CreateAgentOptions['sessionId'],
          meta: { cwd: ws },
          setup: callerSetup,
        },
      ]),
    ).rejects.toThrow('caller commit boom')
    expect(host.registry.size).toBe(0)
    dispose()
  })

  it('runs the caller commit first, then the coordinator assertion', async () => {
    const ws = join(root, 'ws')
    await mkdir(ws)
    const log: string[] = []
    const { stub, coordinator, callerCtx, dispose } = setup(log)
    const callerSetup = (): { commit: () => void } => ({
      commit: () => log.push('caller'),
    })

    const result = await callAsShadow<StubPublish>(stub, 'create', shadowOf(stub, callerCtx), [
      {
        sessionId: 's1' as CreateAgentOptions['sessionId'],
        meta: { cwd: ws },
        setup: callerSetup,
      },
    ])

    expect(log).toEqual(['caller', 'coordinator'])
    expect(coordinator.recordFor(result.agent)).toBeDefined()
    await result.dispose()
    dispose()
  })

  it('returns a commit even without a caller setup', async () => {
    const ws = join(root, 'ws')
    await mkdir(ws)
    const { stub, dispose } = setup()

    const result = await callAsShadow<StubPublish>(stub, 'create', shadowOf(stub, new Context()), [
      { sessionId: 's1' as CreateAgentOptions['sessionId'], meta: { cwd: ws } },
    ])

    expect(host.registry.size).toBe(1)
    await result.dispose()
    expect(host.registry.size).toBe(0)
    dispose()
  })

  it('reverts create/resume to the pre-install methods on dispose', async () => {
    const ws = join(root, 'ws')
    await mkdir(ws)
    const { stub, dispose } = setup()

    expect(Object.hasOwn(stub, 'create')).toBe(true)
    expect(Object.hasOwn(stub, 'resume')).toBe(true)
    dispose()
    expect(Object.hasOwn(stub, 'create')).toBe(false)
    expect(Object.hasOwn(stub, 'resume')).toBe(false)

    // The prototype methods still work, unwrapped.
    const result = await callAsShadow<StubPublish>(stub, 'create', shadowOf(stub, new Context()), [
      {
        sessionId: 's1' as CreateAgentOptions['sessionId'],
        meta: { cwd: ws },
        setup: (): void => {},
      },
    ])
    expect(result.agent).toBeDefined()
    expect(host.registry.size).toBe(0)
    await result.dispose()
  })
})
