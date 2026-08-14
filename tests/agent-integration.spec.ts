import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentRegistry, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { installAgentIntegration } from '../src/agent-integration.js'
import { harness, teardown, type Harness } from './helpers.js'

/** Bare record-only stand-in for the agents service. */
class MinimalRegistry {
  calls: string[] = []
  lastOptions: CreateAgentOptions | undefined

  async create(options: CreateAgentOptions): Promise<unknown> {
    this.calls.push('create')
    this.lastOptions = options
    return {}
  }

  async resume(): Promise<unknown> {
    this.calls.push('resume')
    return {}
  }
}

/** Bare stand-in for the official preset roster, carrying the wrapped methods. */
class StubAgentPresets {
  mountCalls = 0

  async mount(): Promise<unknown> {
    this.mountCalls += 1
    return {}
  }

  composeFrom(): string | undefined {
    return undefined
  }

  async recompose(): Promise<unknown> {
    return {}
  }
}

let host: Harness

beforeEach(async () => {
  host = await harness()
})

afterEach(async () => {
  await teardown(host)
})

describe('installAgentIntegration', () => {
  it('installs the decorators on ctx.agents and ctx.agentPresets and reverts all five methods on dispose', async () => {
    const stub = new MinimalRegistry()
    const presets = new StubAgentPresets()
    host.ctx.provide('agents', stub as unknown as AgentRegistry)
    host.ctx.provide('agentPresets', presets as unknown as AgentPresets)

    const integration = installAgentIntegration(host.ctx)

    expect(integration.coordinator.size).toBe(0)
    expect(Object.hasOwn(stub, 'create')).toBe(true)
    expect(Object.hasOwn(stub, 'resume')).toBe(true)
    expect(Object.hasOwn(presets, 'mount')).toBe(true)
    expect(Object.hasOwn(presets, 'composeFrom')).toBe(true)
    expect(Object.hasOwn(presets, 'recompose')).toBe(true)

    // Called through a shadow receiver (a proxy over the target with `ctx`
    // overlaid), exactly as a consumer would: the original still receives
    // options, but with the setup rewritten into the combined transaction.
    const props = Object.defineProperty(Object.create(null), 'ctx', {
      value: host.ctx,
      writable: false,
      enumerable: true,
    })
    const receiver = new Proxy(stub, {
      get: (t, prop, r) =>
        prop in props && prop !== 'constructor' ? Reflect.get(props, prop, r) : Reflect.get(t, prop, r),
      set: (t, prop, value, r) =>
        prop in props && prop !== 'constructor' ? Reflect.set(props, prop, value, r) : Reflect.set(t, prop, value, r),
    })
    const options: CreateAgentOptions = {
      sessionId: 's1' as CreateAgentOptions['sessionId'],
      meta: { cwd: '/definitely/missing' },
    }
    await expect(
      (stub.create as (o: CreateAgentOptions) => Promise<unknown>).call(receiver, options),
    ).resolves.toEqual({})
    expect(stub.calls).toEqual(['create'])
    expect(stub.lastOptions?.sessionId).toBe(options.sessionId)
    expect(stub.lastOptions?.meta?.cwd).toBe('/definitely/missing')
    // The caller's setup was replaced by the combined setup.
    expect(typeof stub.lastOptions?.setup).toBe('function')
    expect(integration.coordinator.size).toBe(0)

    integration.dispose()
    expect(Object.hasOwn(stub, 'create')).toBe(false)
    expect(Object.hasOwn(stub, 'resume')).toBe(false)
    expect(Object.hasOwn(presets, 'mount')).toBe(false)
    expect(Object.hasOwn(presets, 'composeFrom')).toBe(false)
    expect(Object.hasOwn(presets, 'recompose')).toBe(false)
  })

  it('installs the wrappers on the provider-owned target behind ctx.get', async () => {
    const stub = new MinimalRegistry()
    const presets = new StubAgentPresets()
    host.ctx.provide('agents', stub as unknown as AgentRegistry)
    host.ctx.provide('agentPresets', presets as unknown as AgentPresets)

    const integration = installAgentIntegration(host.ctx)
    // A plain provide()d service has no tracker, so ctx.get returns the raw
    // provider-owned instance the wrappers were installed on.
    expect(host.ctx.get('agentPresets')).toBe(presets)
    expect(Object.hasOwn(host.ctx.get('agentPresets') as object, 'mount')).toBe(true)

    integration.dispose()
  })

  it('fails loudly when a required service is missing', () => {
    expect(() => installAgentIntegration(new Context())).toThrow(/agents/)

    const ctx = new Context()
    ctx.provide('agents', new MinimalRegistry() as unknown as AgentRegistry)
    expect(() => installAgentIntegration(ctx)).toThrow(/agentPresets/)

    const ctx2 = new Context()
    ctx2.provide('agents', new MinimalRegistry() as unknown as AgentRegistry)
    ctx2.provide('agentPresets', new StubAgentPresets() as unknown as AgentPresets)
    expect(() => installAgentIntegration(ctx2)).toThrow(/workspaceCordis/)
  })
})
