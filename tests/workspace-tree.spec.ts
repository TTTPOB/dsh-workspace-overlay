import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import WorkspaceRegistry, { defaultConfig } from '../src/registry.js'
import { WorkspaceMountError, mountWorkspaceTree } from '../src/workspace-tree.js'
import {
  fixtureState,
  harness,
  makeWorkspace,
  markerRow,
  resetFixtures,
  seedPlugins,
  selfDisposed,
  teardown,
  writeConfig,
  type Harness,
} from './helpers.js'

let host: Harness

beforeEach(async () => {
  resetFixtures()
  host = await harness(defaultConfig)
})

afterEach(async () => {
  await teardown(host)
})

/** Every service name registered in the runtime, regardless of realm. */
function providedServiceNames(ctx: Context): string[] {
  const store = ctx.reflect.store
  return Object.getOwnPropertySymbols(store)
    .map(key => store[key]?.name)
    .filter((name): name is string => name !== undefined)
}

describe('mounting a workspace composition', () => {
  it('activates relative rows in the workspace scope and leaves the config file untouched', async () => {
    const ws = await makeWorkspace(host.root, 'configured')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, [
      '- id: alpha',
      '  name: ./plugins/contribute.js',
      '  config:',
      '    marker: alpha',
      '- id: beta',
      '  name: ./plugins/contribute.js',
      '  config:',
      '    marker: beta',
      '',
    ].join('\n'))
    const before = await readFile(configPath, 'utf8')

    const lease = await host.registry.acquire(ws)

    // Relative specifiers resolve from the `.dsh` directory, one row each.
    expect(fixtureState().markers).toEqual(['alpha', 'beta'])
    // The fixture's registrations landed in the workspace scope, not the host.
    expect(scopeOf(fixtureState().contexts[0]!)).toBe(lease.key)
    expect(scopeOf(fixtureState().contexts[1]!)).toBe(lease.key)
    expect(lease.configured).toBe(true)
    expect(lease.composition?.active).toBe(true)
    expect(lease.composition?.path).toBe(configPath)
    expect(host.registry.get(lease.canonical)?.composition?.active).toBe(true)
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  it('keeps an empty scope when no config file exists', async () => {
    const ws = await makeWorkspace(host.root, 'plain')

    const lease = await host.registry.acquire(ws)

    expect(lease.configured).toBe(false)
    expect(lease.composition).toBeUndefined()
    expect(host.registry.get(lease.canonical)?.composition).toBeUndefined()
    expect(fixtureState().markers).toEqual([])
  })

  it('mounts once for concurrent acquires of the same workspace', async () => {
    const ws = await makeWorkspace(host.root, 'shared')
    await seedPlugins(ws, ['contribute.js'])
    await writeConfig(ws, markerRow('shared'))

    const leases = await Promise.all(
      Array.from({ length: 8 }, () => host.registry.acquire(ws)),
    )

    expect(new Set(leases.map(lease => lease.key)).size).toBe(1)
    expect(fixtureState().markers).toEqual(['shared'])
    expect(host.registry.get(leases[0]!.canonical)?.leases).toBe(8)

    await Promise.all(leases.map(lease => lease.release()))
    // One composition, one effect, one disposer on the final release.
    expect(fixtureState().disposed).toBe(1)
    expect(host.registry.size).toBe(0)
  })

  it('resolves bare specifiers from the host base through the loader internal resolver', async () => {
    // Vitest workers expose no Node internal module loader, so the resolver
    // is stubbed: it records the routed specifier and base, then loads the
    // real on-disk package so the tree still activates end to end.
    const hostDir = join(host.root, 'host')
    const packageDir = join(hostDir, 'node_modules', 'ws-fixture-plugin')
    await mkdir(packageDir, { recursive: true })
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: 'ws-fixture-plugin', type: 'module', main: 'index.js' }),
    )
    await writeFile(
      join(packageDir, 'index.js'),
      'export const name = \'ws-fixture-plugin\'\n'
      + 'export function apply(ctx, config) {\n'
      + '  ctx.effect(() => { const r = globalThis.__WS_FIXTURE__ ??= { markers: [], contexts: [], disposed: 0 }; r.markers.push(config.marker); r.contexts.push(ctx) })\n'
      + '}\n',
    )
    const imported = vi.fn(async (specifier: string, base: string) => {
      const packageJson = join(hostDir, 'node_modules', specifier, 'package.json')
      const { main } = JSON.parse(await readFile(packageJson, 'utf8')) as { main: string }
      return await import(pathToFileURL(join(hostDir, 'node_modules', specifier, main)).href)
    })
    const loader = host.ctx.loader as unknown as {
      internal: { version: string; import: typeof imported }
    }
    loader.internal = { version: 'v1', import: imported }

    const ws = await makeWorkspace(host.root, 'bare')
    await writeConfig(ws, [
      '- id: pkg',
      '  name: ws-fixture-plugin',
      '  config:',
      '    marker: bare',
      '',
    ].join('\n'))

    const lease = await host.registry.acquire(ws)

    expect(imported).toHaveBeenCalledWith('ws-fixture-plugin', pathToFileURL(hostDir).href + '/', {})
    expect(fixtureState().markers).toEqual(['bare'])
    expect(lease.composition?.active).toBe(true)
  })

  it('disposes the composition on the final release without rewriting the config', async () => {
    const ws = await makeWorkspace(host.root, 'dispose')
    await seedPlugins(ws, ['contribute.js', 'self-dispose.js'])
    const configPath = await writeConfig(ws, [
      '- id: marker',
      '  name: ./plugins/contribute.js',
      '  config:',
      '    marker: kept',
      '- id: gone',
      '  name: ./plugins/self-dispose.js',
      '',
    ].join('\n'))
    const original = await readFile(configPath, 'utf8')

    const lease = await host.registry.acquire(ws)
    expect(fixtureState().markers).toEqual(['kept'])
    await selfDisposed()
    // Slack past settlement, not a race the number has to win: the write rides
    // the loader's fiber-unload listener, which stamps `disabled: true` and
    // calls `write()` in the same synchronous step. Polling would not help —
    // the assertion is an ABSENCE.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await readFile(configPath, 'utf8')).toBe(original)

    await lease.release()
    expect(fixtureState().disposed).toBe(1)
    expect(host.registry.size).toBe(0)
    expect(await readFile(configPath, 'utf8')).toBe(original)
  })
})

describe('rejecting an unusable workspace composition', () => {
  it('rejects a row waiting for a service the composition never supplies', async () => {
    const ws = await makeWorkspace(host.root, 'pending')
    await seedPlugins(ws, ['needs-missing.js'])
    await writeConfig(ws, '- id: waits\n  name: ./plugins/needs-missing.js\n')

    await expect(host.registry.acquire(ws)).rejects.toThrow(/waiting for serviceThatDoesNotExist/)
    expect(host.registry.size).toBe(0)
  })

  it('rejects rows publishing process-global services and unwinds them', async () => {
    const ws = await makeWorkspace(host.root, 'leaky')
    await seedPlugins(ws, ['global-service.js'])
    await writeConfig(ws, [
      '- id: leak-z',
      '  name: ./plugins/global-service.js',
      '  config:',
      '    service: zzzWsLeakedSvc',
      '    label: Z',
      '- id: leak-a',
      '  name: ./plugins/global-service.js',
      '  config:',
      '    service: aaaWsLeakedSvc',
      '    label: A',
      '',
    ].join('\n'))

    await expect(host.registry.acquire(ws))
      .rejects.toThrow(/process-global service\(s\) \[aaaWsLeakedSvc, zzzWsLeakedSvc\]/)

    // The rejected subtree is fully unwound: its registrations are gone from
    // the store rather than merely unreachable.
    expect(providedServiceNames(host.ctx)).not.toContain('aaaWsLeakedSvc')
    expect(providedServiceNames(host.ctx)).not.toContain('zzzWsLeakedSvc')
    expect(host.registry.size).toBe(0)
  })

  it('accepts the same provider behind an isolate realm', async () => {
    const ws = await makeWorkspace(host.root, 'isolated')
    await seedPlugins(ws, ['global-service.js'])
    await writeConfig(ws, [
      '- id: svc',
      '  name: ./plugins/global-service.js',
      '  isolate:',
      '    wsIsolatedSvc: true',
      '  config:',
      '    service: wsIsolatedSvc',
      '    label: ISOLATED',
      '',
    ].join('\n'))

    const lease = await host.registry.acquire(ws)

    expect(lease.composition?.active).toBe(true)
    // The provider ran under a realm-private symbol the root cannot reach.
    expect(providedServiceNames(host.ctx)).toContain('wsIsolatedSvc')
    expect(host.ctx.get('wsIsolatedSvc')).toBeUndefined()
  })

  it('reports the workspace path on mount failure', async () => {
    const ws = await makeWorkspace(host.root, 'reported')
    await writeConfig(ws, '- id: nope\n  name: ./plugins/does-not-exist.js\n')

    const error = await host.registry.acquire(ws).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(WorkspaceMountError)
    expect((error as WorkspaceMountError).workspace).toBe(ws)
    expect((error as WorkspaceMountError).message).toContain(ws)
    expect(host.registry.size).toBe(0)
  })

  it('refuses to mount into an unscoped context', async () => {
    const ws = await makeWorkspace(host.root, 'unscoped')
    await seedPlugins(ws, ['contribute.js'])
    await writeConfig(ws, markerRow('x'))

    await expect(mountWorkspaceTree(host.ctx, ws)).rejects.toThrow(/unscoped context/)
  })
})

describe('trust and retry', () => {
  it('never reads, parses, or imports when trust is disabled', async () => {
    const untrusted = await harness({ trustWorkspaceConfig: false })
    const ws = await makeWorkspace(untrusted.root, 'untrusted')

    // Invalid YAML: parsing would fail the acquire, success proves no parse.
    await writeConfig(ws, '- id: x\n  name: [unclosed\n')
    let lease = await untrusted.registry.acquire(ws)
    expect(lease.configured).toBe(true)
    expect(lease.composition).toBeUndefined()
    expect(fixtureState().markers).toEqual([])
    await lease.release()

    // Valid config: importing would register markers, their absence proves
    // the modules were never loaded.
    await seedPlugins(ws, ['contribute.js'])
    await writeConfig(ws, markerRow('never'))
    lease = await untrusted.registry.acquire(ws)
    expect(lease.configured).toBe(true)
    expect(lease.composition).toBeUndefined()
    expect(fixtureState().markers).toEqual([])
    await teardown(untrusted)
  })

  it('fails on invalid YAML, leaves no cached state, and retries after the fix', async () => {
    const ws = await makeWorkspace(host.root, 'broken-yaml')
    await seedPlugins(ws, ['contribute.js'])
    const configPath = await writeConfig(ws, '- id: x\n  name: [unclosed\n')

    await expect(host.registry.acquire(ws)).rejects.toBeInstanceOf(WorkspaceMountError)
    expect(host.registry.size).toBe(0)

    await writeFile(configPath, markerRow('fixed'))
    const lease = await host.registry.acquire(ws)
    expect(fixtureState().markers).toEqual(['fixed'])
    expect(lease.composition?.active).toBe(true)
  })

  it('fails on an unresolvable module and retries after the fix', async () => {
    const ws = await makeWorkspace(host.root, 'missing-module')
    const configPath = await writeConfig(ws, '- id: nope\n  name: ./plugins/does-not-exist.js\n')

    await expect(host.registry.acquire(ws)).rejects.toBeInstanceOf(WorkspaceMountError)
    expect(host.registry.size).toBe(0)

    await seedPlugins(ws, ['contribute.js'])
    await writeFile(configPath, markerRow('rescued'))
    const lease = await host.registry.acquire(ws)
    expect(fixtureState().markers).toEqual(['rescued'])
    expect(lease.composition?.active).toBe(true)
  })
})

describe('a registry with no loader composition', () => {
  it('keeps the service unavailable until a loader exists', async () => {
    const bare = new Context()
    const pending = bare.plugin(WorkspaceRegistry)
    // No loader in this composition: the provider must not activate, so the
    // service never registers. (`ctx.plugin()` resolves while a fiber is
    // still pending on its inject; service availability is the observable.)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(bare.get('workspaceCordis')).toBeUndefined()

    // Composing the loader unblocks activation.
    await bare.plugin(Loader)
    await pending
    await vi.waitFor(() => {
      expect(bare.get('workspaceCordis')).toBeDefined()
    })
  })
})
