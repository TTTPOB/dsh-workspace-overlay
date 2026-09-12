import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { symbols, type Fiber } from '@deepseek-ai/cordis'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import type { AgentRegistry, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { AgentPresets, type Config as RosterConfig } from '@deepseek-ai/dsh-agent-presets'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../src/integration-plugin.js'
import { harness, markerPreset, resetFixtures, seedPreset, teardown, type Harness } from './helpers.js'

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
let presetsRoot: string

beforeEach(async () => {
  resetFixtures()
  host = await harness()
  presetsRoot = await mkdtemp(join(tmpdir(), 'dsh-ws-plugin-'))
  const roster: RosterConfig = {
    default: 'standard',
    roots: [{ path: presetsRoot, trust: 'system' }],
    includeUserRoot: false,
    includeShippedRoot: false,
  }
  await host.ctx.plugin(SessionProjections)
  await host.ctx.plugin(AgentPresets, roster)
})

afterEach(async () => {
  await rm(presetsRoot, { recursive: true, force: true })
  await teardown(host)
})

describe('integration-plugin module shape', () => {
  it('exports the Cordis function-plugin namespace without a default', () => {
    expect(plugin.name).toBe('workspace-agent-integration')
    expect(plugin.inject).toEqual(['agents', 'agentPresets', 'workspaceCordis'])
    expect(typeof plugin.apply).toBe('function')
    expect((plugin as { default?: unknown }).default).toBeUndefined()
    // Trust belongs to the workspaceCordis provider; this wiring row is empty.
    expect(plugin.Config({})).toEqual({})
  })

  it('composes as a real Loader row, installs the decorators, and reverts on dispose', async () => {
    await seedPreset(presetsRoot, 'standard', markerPreset('standard'))
    const stub = new MinimalRegistry()
    host.ctx.provide('agents', stub as unknown as AgentRegistry)

    const fiber: Fiber = await host.ctx.plugin(plugin)

    // Both decorators installed on the provider targets.
    expect(Object.hasOwn(stub, 'create')).toBe(true)
    expect(Object.hasOwn(stub, 'resume')).toBe(true)
    const rawPresets = (host.ctx.get('agentPresets') as unknown as { [symbols.original]?: unknown })[symbols.original]
    expect(rawPresets).toBeDefined()
    expect(Object.hasOwn(rawPresets as object, 'mount')).toBe(true)
    expect(Object.hasOwn(rawPresets as object, 'composeFrom')).toBe(true)
    expect(Object.hasOwn(rawPresets as object, 'recompose')).toBe(true)

    // The plugin never creates its own workspace registry: it consumes the
    // provider the harness already composed (same provider-owned instance
    // behind every traceable access).
    const rawRegistry = (host.registry as unknown as { [symbols.original]?: unknown })[symbols.original]
    expect((host.ctx.get('workspaceCordis') as unknown as { [symbols.original]?: unknown })[symbols.original])
      .toBe(rawRegistry)
    expect((host.ctx.workspaceCordis as unknown as { [symbols.original]?: unknown })[symbols.original])
      .toBe(rawRegistry)

    // Disposing the plugin fiber restores all five method descriptors.
    await fiber.dispose()
    expect(Object.hasOwn(stub, 'create')).toBe(false)
    expect(Object.hasOwn(stub, 'resume')).toBe(false)
    expect(Object.hasOwn(rawPresets as object, 'mount')).toBe(false)
    expect(Object.hasOwn(rawPresets as object, 'composeFrom')).toBe(false)
    expect(Object.hasOwn(rawPresets as object, 'recompose')).toBe(false)
    // The underlying services remain composed.
    expect(host.ctx.get('agents')).toBeDefined()
    expect(host.ctx.get('agentPresets')).toBeDefined()
    expect((host.ctx.get('workspaceCordis') as unknown as { [symbols.original]?: unknown })[symbols.original])
      .toBe(rawRegistry)
  })

  it('stays pending until every declared service exists, then activates', async () => {
    const stub = new MinimalRegistry()
    const pending = host.ctx.plugin(plugin)

    // agents is missing: the row must not activate (and must not throw).
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(Object.hasOwn(stub, 'create')).toBe(false)

    host.ctx.provide('agents', stub as unknown as AgentRegistry)
    const fiber: Fiber = await pending
    expect(Object.hasOwn(stub, 'create')).toBe(true)

    await fiber.dispose()
    expect(Object.hasOwn(stub, 'create')).toBe(false)
  })
})
