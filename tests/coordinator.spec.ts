import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bindScopeParent, scopeParentOf } from '@deepseek-ai/dsh-scope'
import { AgentBindingCoordinator } from '../src/coordinator.js'
import { harness, makeWorkspace, teardown, type Harness } from './helpers.js'

let host: Harness

beforeEach(async () => {
  host = await harness()
})

afterEach(async () => {
  await teardown(host)
})

describe('AgentBindingCoordinator', () => {
  it('binds an agent key under the workspace scope and records lease and binding', async () => {
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const coordinator = new AgentBindingCoordinator()
    const agentKey = {}

    const binding = coordinator.bind(agentKey, lease)

    const record = coordinator.recordFor(agentKey)
    expect(record?.agentKey).toBe(agentKey)
    expect(record?.lease).toBe(lease)
    expect(record?.binding).toBe(binding)
    expect(scopeParentOf(agentKey)).toBe(lease.key)
    expect(coordinator.size).toBe(1)
    expect(coordinator.recordFor({})).toBeUndefined()
  })

  it('rejects a duplicate bind without disturbing the first record', async () => {
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const coordinator = new AgentBindingCoordinator()
    const agentKey = {}

    const binding = coordinator.bind(agentKey, lease)
    expect(() => coordinator.bind(agentKey, lease)).toThrow(/already bound/)

    expect(coordinator.recordFor(agentKey)?.binding).toBe(binding)
    expect(coordinator.size).toBe(1)
  })

  it('propagates bindScopeParent failures and leaves no record', async () => {
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const coordinator = new AgentBindingCoordinator()
    const agentKey = {}
    // The official agentPresets provider already bound this key elsewhere.
    bindScopeParent(agentKey, {})

    expect(() => coordinator.bind(agentKey, lease)).toThrow()
    expect(coordinator.recordFor(agentKey)).toBeUndefined()
    expect(coordinator.size).toBe(0)
  })

  it('unbinds idempotently and releases the lease exactly once', async () => {
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const coordinator = new AgentBindingCoordinator()
    const agentKey = {}
    coordinator.bind(agentKey, lease)
    expect(host.registry.size).toBe(1)

    await coordinator.unbind(agentKey)
    expect(coordinator.recordFor(agentKey)).toBeUndefined()
    expect(coordinator.size).toBe(0)
    // The final release disposed the workspace entry.
    expect(host.registry.size).toBe(0)

    // A second unbind is a no-op that still settles.
    await coordinator.unbind(agentKey)
    expect(coordinator.size).toBe(0)
    expect(host.registry.size).toBe(0)
  })

  it('keeps other agents bound while one unbinds', async () => {
    const ws = await makeWorkspace(host.root, 'ws')
    // Each agent holds its own lease on the shared workspace entry.
    const firstLease = await host.registry.acquire(ws)
    const secondLease = await host.registry.acquire(ws)
    expect(host.registry.size).toBe(1)
    const coordinator = new AgentBindingCoordinator()
    const first = {}
    const second = {}
    coordinator.bind(first, firstLease)
    coordinator.bind(second, secondLease)

    await coordinator.unbind(first)
    // The shared workspace entry survives while the second agent holds it.
    expect(host.registry.size).toBe(1)
    expect(coordinator.recordFor(second)).toBeDefined()

    await coordinator.unbind(second)
    expect(host.registry.size).toBe(0)
    expect(coordinator.size).toBe(0)
  })

  it('asserts liveness in commit only while the binding exists', async () => {
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const coordinator = new AgentBindingCoordinator()
    const agentKey = {}

    coordinator.bind(agentKey, lease)
    expect(() => coordinator.commit(agentKey)).not.toThrow()

    await coordinator.unbind(agentKey)
    expect(() => coordinator.commit(agentKey)).toThrow(/no longer live/)
  })
})
