import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentRegistry, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
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

let host: Harness

beforeEach(async () => {
  host = await harness()
})

afterEach(async () => {
  await teardown(host)
})

describe('installAgentIntegration', () => {
  it('installs the decorators on ctx.agents and reverts them on dispose', async () => {
    const stub = new MinimalRegistry()
    host.ctx.provide('agents', stub as unknown as AgentRegistry)

    const integration = installAgentIntegration(host.ctx)

    expect(integration.coordinator.size).toBe(0)
    expect(Object.hasOwn(stub, 'create')).toBe(true)
    expect(Object.hasOwn(stub, 'resume')).toBe(true)

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
  })

  it('fails loudly when a required service is missing', () => {
    expect(() => installAgentIntegration(new Context())).toThrow(/agents/)
    const ctx = new Context()
    ctx.provide('agents', new MinimalRegistry() as unknown as AgentRegistry)
    expect(() => installAgentIntegration(ctx)).toThrow(/workspaceCordis/)
  })
})
