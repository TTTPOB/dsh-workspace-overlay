import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { symbols, type Fiber } from '@deepseek-ai/cordis'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import type { AgentRegistry, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
// 0.1.7 renamed the package (`dsh-agent-presets` -> `dsh-agent-preset-registry`)
// and the service class (`AgentPresets` -> `AgentPresetRegistry`); the Cordis
// service name is still `agentPresets`. The file-roster `Config` is gone with it:
// `default` survives as a selection policy, and a preset is now an in-memory
// `PresetDefinition` handed to `registry.register()` instead of a directory
// discovered under a scanned presets root.
import { AgentPresetRegistry, type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as plugin from '../src/integration-plugin.js'
import { FIXTURES, harness, resetFixtures, teardown, type Harness } from './helpers.js'

/**
 * Absolute `file://` URL of one committed fixture plugin. With no roster root to
 * resolve against, a preset row names its plugin the way a host plugin is named:
 * by an absolute URL or a specifier the Loader can resolve from the host base.
 */
const fixturePlugin = (file: string): string => pathToFileURL(join(FIXTURES, 'plugins', file)).href

/** The one preset this suite declares, mirroring the old seeded `standard` row. */
const standardPreset: PresetDefinition = {
  id: 'standard',
  plugins: [{ id: 'marker', name: fixturePlugin('contribute.js'), config: { marker: 'standard' } }],
}

/** The 0.1.7 selection policy; the plugin schema fills the volatile fields. */
const selection = { default: 'standard' }

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
let presetFiber: Fiber

beforeEach(async () => {
  resetFixtures()
  host = await harness()
  await host.ctx.plugin(SessionProjections)
  // The registry injects `loader` and `sessionProjections`, so it composes
  // after both, and eagerly activates everything it is handed.
  presetFiber = await host.ctx.plugin(AgentPresetRegistry, selection)
  await (host.ctx.get('agentPresets') as unknown as AgentPresetRegistry).register(standardPreset)
})

afterEach(async () => {
  // The live-mount set is module state spanning every runtime in the process,
  // so the registry fiber goes down before the harness temp root is removed.
  await presetFiber.dispose()
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
