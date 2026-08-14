/**
 * End-to-end integration tests for the workspace-aware MCP manager against the
 * real Loader composition, real workspace `.dsh/cordis.yml` mounts, and real
 * fixture-server child processes (spawned and disposed within the test process
 * lifecycle). Covers the process-count contract (global + per-workspace
 * override + inheriting workspace), lease sharing, cwd resolution, the
 * real-registry namespace mask, bad-server mount rejection with retry, and
 * teardown with no leftover processes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { fileURLToPath } from 'node:url'
import WorkspaceMcpManager from '../../src/mcp/manager.js'
import * as workspaceClient from '../../src/mcp/workspace-client.js'
import { publicToolName } from '../../src/mcp/index.js'
import type { Config } from '../../src/mcp/types.js'
import { harness, makeWorkspace, seedPlugins, writeConfig, teardown, type Harness } from '../helpers.js'
import {
  captureLogs,
  killMarkedProcesses,
  makeMarkerFile,
  nextCallId,
  readMarkers,
  removeMarkerFile,
  sleep,
  testToolSignal,
} from './helpers.js'

const FIXTURE_SERVER = fileURLToPath(new URL('../fixtures/mcp/fixture-server.ts', import.meta.url))

/** One workspace composition row driving the workspace-aware MCP manager. */
function mcpRow(
  id: string,
  serverName: string,
  marker: string,
  extra: { mode?: string; env?: Record<string, string>; cwd?: string; failOnStartupError?: boolean } = {},
): string {
  const env = { MCP_FIXTURE_MARKER: marker, ...extra.mode === undefined ? {} : { MCP_FIXTURE_MODE: extra.mode }, ...extra.env }
  return [
    `- id: ${id}`,
    '  name: ./plugins/ws-mcp-entry.js',
    '  config:',
    '    transport: stdio',
    `    serverName: ${serverName}`,
    `    command: ${JSON.stringify(process.execPath)}`,
    `    args: ${JSON.stringify([FIXTURE_SERVER])}`,
    `    env: ${JSON.stringify(env)}`,
    `    cwd: ${JSON.stringify(extra.cwd ?? '')}`,
    '    toolCallTimeoutMs: 5000',
    `    failOnStartupError: ${extra.failOnStartupError ?? true}`,
    '    reconnect:',
    '      initialDelayMs: 30',
    '      maxDelayMs: 60',
    '      maxAttempts: 2',
    '',
  ].join('\n')
}

/** A global row config spawning the fixture server. */
function globalConfig(serverName: string, marker: string, extra: Record<string, string> = {}): Config {
  return {
    transport: 'stdio',
    serverName,
    command: process.execPath,
    args: [FIXTURE_SERVER],
    env: { MCP_FIXTURE_MARKER: marker, ...extra },
    cwd: '',
    toolCallTimeoutMs: 5_000,
    failOnStartupError: true,
    reconnect: { initialDelayMs: 30, maxDelayMs: 60, maxAttempts: 2 },
  }
}

/** Every public tool name one scope views, sorted. */
async function viewNames(scopeCtx: import('@deepseek-ai/cordis').Context, scope: ScopeKey | undefined): Promise<string[]> {
  const viewer = await scopeCtx.plugin({ name: 'viewer', inject: ['tools'], apply() {} })
  try {
    return viewer.ctx.tools.schemas(scope).map(schema => schema.name).sort()
  } finally {
    await viewer.dispose()
  }
}

/** Execute one workspace-scoped tool through its scope key. */
async function callTool(
  scopeCtx: import('@deepseek-ai/cordis').Context,
  scope: ScopeKey,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const viewer = await scopeCtx.plugin({ name: 'viewer', inject: ['tools'], apply() {} })
  try {
    const result = await viewer.ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(),
      name,
      arguments: args,
      agent: scope as unknown as Agent,
    })
    if (result.isError) throw new Error(`tool call failed: ${result.error?.message}`)
    return result.content[0]
  } finally {
    await viewer.dispose()
  }
}

let host: Harness
let markerFiles: string[]

beforeEach(async () => {
  host = await harness()
  await host.ctx.plugin(SystemPrompt)
  await host.ctx.plugin(ToolRuntime)
  await host.ctx.plugin(WorkspaceMcpManager)
  markerFiles = []
})

afterEach(async () => {
  await teardown(host)
  await sleep(300)
  for (const marker of markerFiles) {
    await killMarkedProcesses(marker)
    await removeMarkerFile(marker)
  }
})

/** Create a marker file and track it for cleanup. */
async function newMarker(): Promise<string> {
  const marker = await makeMarkerFile()
  markerFiles.push(marker)
  return marker
}

describe('process-count contract', () => {
  it('global a + ws1/ws2 override + ws3 inherit = 3 processes; dispose ws1 leaves global and ws2 intact', async () => {
    const markerGlobal = await newMarker()
    const markerWs1 = await newMarker()
    const markerWs2 = await newMarker()
    const globalFiber = await host.ctx.plugin(workspaceClient, globalConfig('a', markerGlobal))

    const ws1 = await makeWorkspace(host.root, 'ws1')
    await seedPlugins(ws1, ['ws-mcp-entry.js'])
    await writeConfig(ws1, mcpRow('mcp-a', 'a', markerWs1))
    const ws2 = await makeWorkspace(host.root, 'ws2')
    await seedPlugins(ws2, ['ws-mcp-entry.js'])
    await writeConfig(ws2, mcpRow('mcp-a', 'a', markerWs2))
    // ws3 declares no MCP row: it inherits the global process.
    const ws3 = await makeWorkspace(host.root, 'ws3')

    const lease1 = await host.registry.acquire(ws1)
    const lease2 = await host.registry.acquire(ws2)
    const lease3 = await host.registry.acquire(ws3)

    // Exactly one process per row: global + ws1 + ws2 = 3; ws3 none.
    await vi.waitFor(async () => {
      expect((await readMarkers(markerGlobal)).starts).toHaveLength(1)
      expect((await readMarkers(markerWs1)).starts).toHaveLength(1)
      expect((await readMarkers(markerWs2)).starts).toHaveLength(1)
    })
    await sleep(100)
    expect((await readMarkers(markerGlobal)).starts).toHaveLength(1)
    expect((await readMarkers(markerWs1)).starts).toHaveLength(1)
    expect((await readMarkers(markerWs2)).starts).toHaveLength(1)

    // The inheriting workspace sees the global server's tools.
    expect(await viewNames(lease3.ctx, lease3.key)).toContain('mcp__a__add')

    // Dispose ws1: its process exits; global and ws2 stay up.
    const ws1Pid = (await readMarkers(markerWs1)).starts[0]!
    await lease1.release()
    await vi.waitFor(async () => {
      expect((await readMarkers(markerWs1)).exits).toContain(ws1Pid)
    })
    await sleep(100)
    expect((await readMarkers(markerGlobal)).exits).toEqual([])
    expect((await readMarkers(markerWs2)).exits).toEqual([])
    expect(await viewNames(host.ctx, undefined)).toContain('mcp__a__add')
    expect(await viewNames(lease2.ctx, lease2.key)).toContain('mcp__a__add')

    await Promise.all([lease2.release(), lease3.release(), globalFiber.dispose()])
    await vi.waitFor(async () => {
      expect((await readMarkers(markerGlobal)).exits).toHaveLength(1)
      expect((await readMarkers(markerWs2)).exits).toHaveLength(1)
    })
  })

  it('two leases of one workspace share one entry, one composition, one process', async () => {
    const marker = await newMarker()
    const ws = await makeWorkspace(host.root, 'shared')
    await seedPlugins(ws, ['ws-mcp-entry.js'])
    await writeConfig(ws, mcpRow('mcp-a', 'a', marker))

    const lease1 = await host.registry.acquire(ws)
    const lease2 = await host.registry.acquire(ws)
    expect(lease1.key).toBe(lease2.key)
    expect(lease1.canonical).toBe(lease2.canonical)

    await vi.waitFor(async () => {
      expect((await readMarkers(marker)).starts).toHaveLength(1)
    })
    const pid = (await readMarkers(marker)).starts[0]!

    // Both consumers share the single workspace process.
    expect(await viewNames(lease1.ctx, lease1.key)).toContain('mcp__a__add')
    expect(await viewNames(lease2.ctx, lease2.key)).toContain('mcp__a__add')

    // One lease release does not tear the shared entry down.
    await lease1.release()
    await sleep(100)
    expect((await readMarkers(marker)).exits).toEqual([])

    // The final release closes the shared process.
    await lease2.release()
    await vi.waitFor(async () => {
      expect((await readMarkers(marker)).exits).toContain(pid)
    })
  })
})

describe('workspace cwd resolution end to end', () => {
  it('empty and ${workspaceRoot} cwd spawn the server in the canonical workspace root', async () => {
    const marker1 = await newMarker()
    const marker2 = await newMarker()
    const ws = await makeWorkspace(host.root, 'cwd')
    await seedPlugins(ws, ['ws-mcp-entry.js'])
    await writeConfig(ws, [
      mcpRow('mcp-1', 'cwd1', marker1, { cwd: '' }),
      mcpRow('mcp-2', 'cwd2', marker2, { cwd: '${workspaceRoot}' }),
    ].join('\n'))

    const lease = await host.registry.acquire(ws)
    await vi.waitFor(async () => {
      expect((await readMarkers(marker1)).starts).toHaveLength(1)
      expect((await readMarkers(marker2)).starts).toHaveLength(1)
    })

    const viaDefault = await callTool(lease.ctx, lease.key, 'mcp__cwd1__cwd_echo')
    expect(viaDefault).toEqual({ type: 'text', text: lease.canonical })
    const viaToken = await callTool(lease.ctx, lease.key, 'mcp__cwd2__cwd_echo')
    expect(viaToken).toEqual({ type: 'text', text: lease.canonical })

    await lease.release()
    await vi.waitFor(async () => {
      expect((await readMarkers(marker1)).exits).toHaveLength(1)
      expect((await readMarkers(marker2)).exits).toHaveLength(1)
    })
  })
})

describe('namespace masking with real servers', () => {
  it('global a t1..t5 + workspace a t1..t3 + global b: the workspace sees only its own a tools plus b', async () => {
    const markerA = await newMarker()
    const markerB = await newMarker()
    const markerWs = await newMarker()
    const globalA = await host.ctx.plugin(workspaceClient, globalConfig('a', markerA, {
      MCP_FIXTURE_MODE: 'masked',
      MCP_FIXTURE_MASKED_COUNT: '5',
    }))
    const globalB = await host.ctx.plugin(workspaceClient, globalConfig('b', markerB))

    const ws = await makeWorkspace(host.root, 'masked')
    await seedPlugins(ws, ['ws-mcp-entry.js'])
    await writeConfig(ws, mcpRow('mcp-a', 'a', markerWs, {
      env: { MCP_FIXTURE_MODE: 'masked-partial', MCP_FIXTURE_MASKED_COUNT: '3' },
    }))
    const lease = await host.registry.acquire(ws)
    await vi.waitFor(async () => {
      expect((await readMarkers(markerWs)).starts).toHaveLength(1)
    })

    // The workspace view: own a t1..t3 only, global a t4/t5 masked, global b kept.
    const expected = [
      'mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3',
      'mcp__b__add', publicToolName('b', 'admin.reset'), 'mcp__b__crash', 'mcp__b__cwd_echo',
      'mcp__b__env_echo', 'mcp__b__fail', 'mcp__b__greet', 'mcp__b__image',
      'mcp__b__register_extra', 'mcp__b__slow',
    ]
    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).toEqual(expected)
    })

    // A descendant agent under the workspace sees the same masked surface.
    const agentKey: ScopeKey = {}
    const agent = createScope(lease.ctx, agentKey, { parent: lease.key })
    expect(await viewNames(agent.ctx, agentKey)).toEqual(expected)

    // The global view keeps the full global a generation and b.
    expect(await viewNames(host.ctx, undefined)).toContain('mcp__a__t1')
    expect(await viewNames(host.ctx, undefined)).toContain('mcp__a__t5')

    await Promise.all([lease.release(), globalA.dispose(), globalB.dispose()])
  })
})

describe('bad workspace server', () => {
  it('blocks acquire, cleans the spawned process, and succeeds after the config is fixed', async () => {
    const markerBad = await newMarker()
    const ws = await makeWorkspace(host.root, 'broken')
    await seedPlugins(ws, ['ws-mcp-entry.js'])
    const configPath = await writeConfig(ws, mcpRow('mcp-dead', 'dead', markerBad, { mode: 'exit-on-start' }))

    // The startup failure rejects the composition mount, so acquire fails and
    // no agent could ever be published against this workspace.
    await expect(host.registry.acquire(ws)).rejects.toThrow(/failed to mount/)
    await vi.waitFor(async () => {
      const log = await readMarkers(markerBad)
      expect(log.starts.length).toBe(1)
      expect(log.exits.length).toBe(1)
    })
    // The failed activation's reconnect was cancelled: no retry processes.
    await sleep(150)
    expect((await readMarkers(markerBad)).starts).toHaveLength(1)

    // Fix the config: the next acquire mounts the corrected composition.
    const markerFixed = await newMarker()
    await writeConfig(ws, mcpRow('mcp-alive', 'alive', markerFixed))
    const lease = await host.registry.acquire(ws)
    await vi.waitFor(async () => {
      expect((await readMarkers(markerFixed)).starts).toHaveLength(1)
    })
    expect(await viewNames(lease.ctx, lease.key)).toContain('mcp__alive__add')
    await lease.release()
  })

  it('rejects a workspace row without failOnStartupError at mount time', async () => {
    const marker = await newMarker()
    const ws = await makeWorkspace(host.root, 'lenient')
    await seedPlugins(ws, ['ws-mcp-entry.js'])
    await writeConfig(ws, mcpRow('mcp-a', 'a', marker, { failOnStartupError: false }))
    await expect(host.registry.acquire(ws)).rejects.toThrow(/failOnStartupError/)
  })

  it('rejects two rows with the same serverName in one workspace composition', async () => {
    const marker1 = await newMarker()
    const marker2 = await newMarker()
    const ws = await makeWorkspace(host.root, 'dup')
    await seedPlugins(ws, ['ws-mcp-entry.js'])
    await writeConfig(ws, [
      mcpRow('mcp-a', 'a', marker1),
      mcpRow('mcp-a2', 'a', marker2),
    ].join('\n'))
    await expect(host.registry.acquire(ws)).rejects.toThrow(/already in use.*in this workspace/)
    // The first row's reservation was unwound with the failed mount: no
    // lingering processes and a clean retry after removing the duplicate.
    await sleep(150)
    expect((await readMarkers(marker1)).starts).toHaveLength(1)
    expect((await readMarkers(marker1)).exits.length).toBeGreaterThanOrEqual(1)
    expect((await readMarkers(marker2)).starts).toHaveLength(0)
    await writeConfig(ws, mcpRow('mcp-a', 'a', marker1))
    const lease = await host.registry.acquire(ws)
    await vi.waitFor(async () => {
      expect((await readMarkers(marker1)).starts).toHaveLength(2)
    })
    await lease.release()
  })

  it('keeps secrets out of logs for workspace rows', async () => {
    const { errors, warns } = captureLogs(host.ctx)
    const marker = await newMarker()
    const ws = await makeWorkspace(host.root, 'secret')
    await seedPlugins(ws, ['ws-mcp-entry.js'])
    await writeConfig(ws, mcpRow('mcp-a', 'a', marker, {
      env: { MCP_FIXTURE_MODE: 'exit-on-start', SECRET_CANARY: 'super-secret-token' },
    }))
    await expect(host.registry.acquire(ws)).rejects.toThrow(/failed to mount/)
    await sleep(100)
    const all = [...errors, ...warns].join('\n')
    expect(all).not.toContain('super-secret-token')
    expect(all).not.toContain('SECRET_CANARY=')
  })
})
