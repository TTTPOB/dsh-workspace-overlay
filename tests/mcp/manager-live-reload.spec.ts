/**
 * MCP live reload tests: a workspace composition's MCP row reacts to
 * top-level `.dsh/cordis.yml` changes while the lease is live, using the real
 * fixture-server child processes (marker-file proven) and the real
 * workspace-aware MCP manager.
 *
 * Covers: valid->valid reload replacing the old workspace process and tools
 * while the global same-namespace mask stays correct; a broken MCP startup
 * failing the reload and unloading the old workspace MCP without killing the
 * workspace scope/lease; fixing the file recovering a fresh process and
 * mask; secret canary non-leakage; and final release leaving no fixture
 * process, tool, or mask behind.
 */
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import WorkspaceMcpManager from '../../src/mcp/manager.js'
import * as workspaceClient from '../../src/mcp/workspace-client.js'
import type { Config } from '../../src/mcp/types.js'
import { harness, makeWorkspace, seedPlugins, writeConfig, teardown, type Harness } from '../helpers.js'
import {
  captureLogs,
  killMarkedProcesses,
  makeMarkerFile,
  readMarkers,
  removeMarkerFile,
  sleep,
} from './helpers.js'

const FIXTURE_SERVER = fileURLToPath(new URL('../fixtures/mcp/fixture-server.ts', import.meta.url))

const DEBOUNCE_MS = 50

/** One workspace composition row driving the workspace-aware MCP manager. */
function mcpRow(
  id: string,
  serverName: string,
  marker: string,
  extra: { mode?: string; env?: Record<string, string>; cwd?: string } = {},
): string {
  const env = {
    MCP_FIXTURE_MARKER: marker,
    ...extra.mode === undefined ? {} : { MCP_FIXTURE_MODE: extra.mode },
    ...extra.env,
  }
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
    '    failOnStartupError: true',
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
async function viewNames(scopeCtx: import('@deepseek-ai/cordis').Context, scope: import('@deepseek-ai/dsh-scope').ScopeKey | undefined): Promise<string[]> {
  const viewer = await scopeCtx.plugin({ name: 'viewer', inject: ['tools'], apply() {} })
  try {
    return viewer.ctx.tools.schemas(scope).map(schema => schema.name).sort()
  } finally {
    await viewer.dispose()
  }
}

/** The masked workspace view: own t1..tN only (global t1..t5 masked). */
const MASKED_VIEW = ['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3']
const GLOBAL_A_NAMES = ['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3', 'mcp__a__t4', 'mcp__a__t5']

let host: Harness
let markerFiles: string[]

beforeEach(async () => {
  host = await harness({ reloadDebounceMs: DEBOUNCE_MS })
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

describe('workspace MCP live reload', () => {
  it('replaces the workspace process and tools on a config change while the global mask stays correct', async () => {
    const markerGlobal = await newMarker()
    const markerWs1 = await newMarker()
    const markerWs2 = await newMarker()
    const globalA = await host.ctx.plugin(workspaceClient, globalConfig('a', markerGlobal, {
      MCP_FIXTURE_MODE: 'masked',
      MCP_FIXTURE_MASKED_COUNT: '5',
    }))
    const ws = await makeWorkspace(host.root, 'mcp-reload')
    await seedPlugins(ws, ['ws-mcp-entry.js'])
    await writeConfig(ws, mcpRow('mcp-a', 'a', markerWs1, {
      env: { MCP_FIXTURE_MODE: 'masked-partial', MCP_FIXTURE_MASKED_COUNT: '3' },
    }))
    const lease = await host.registry.acquire(ws)

    // The workspace override masks the global generation: only its own t1..t3.
    await vi.waitFor(async () => {
      expect((await readMarkers(markerWs1)).starts).toHaveLength(1)
    }, { timeout: 5000 })
    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).toEqual(MASKED_VIEW)
    }, { timeout: 5000 })
    const pid1 = (await readMarkers(markerWs1)).starts[0]!

    // Rewrite the top-level config: same serverName, new marker. The old
    // workspace process exits and a new one starts.
    await writeConfig(ws, mcpRow('mcp-a', 'a', markerWs2, {
      env: { MCP_FIXTURE_MODE: 'masked-partial', MCP_FIXTURE_MASKED_COUNT: '3' },
    }))
    await vi.waitFor(async () => {
      expect((await readMarkers(markerWs1)).exits).toContain(pid1)
    }, { timeout: 5000 })
    await vi.waitFor(async () => {
      expect((await readMarkers(markerWs2)).starts).toHaveLength(1)
    }, { timeout: 5000 })
    const pid2 = (await readMarkers(markerWs2)).starts[0]!
    expect(pid2).not.toBe(pid1)

    // The mask is rebuilt against the live global generation: the workspace
    // still sees only its own t1..t3, and the global view keeps the full set.
    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).toEqual(MASKED_VIEW)
    }, { timeout: 5000 })
    expect(await viewNames(host.ctx, undefined)).toEqual(expect.arrayContaining(GLOBAL_A_NAMES))
    await vi.waitFor(() => {
      expect(host.registry.get(lease.canonical)?.reload?.successfulReloads).toBe(1)
    }, { timeout: 5000 })

    // Final release: the workspace process exits and its tools vanish; the
    // global row is untouched.
    await lease.release()
    await vi.waitFor(async () => {
      expect((await readMarkers(markerWs2)).exits).toContain(pid2)
    }, { timeout: 5000 })
    expect(await viewNames(host.ctx, undefined)).toEqual(expect.arrayContaining(GLOBAL_A_NAMES))
    await globalA.dispose()
    await vi.waitFor(async () => {
      expect((await readMarkers(markerGlobal)).exits).toHaveLength(1)
    }, { timeout: 5000 })
  })

  it('broken MCP startup fails the reload, unloads the old workspace MCP, keeps the workspace alive, and recovers', async () => {
    const markerGlobal = await newMarker()
    const markerWs = await newMarker()
    const markerBad = await newMarker()
    const markerFixed = await newMarker()
    const globalA = await host.ctx.plugin(workspaceClient, globalConfig('a', markerGlobal, {
      MCP_FIXTURE_MODE: 'masked',
      MCP_FIXTURE_MASKED_COUNT: '5',
    }))
    const ws = await makeWorkspace(host.root, 'mcp-broken')
    await seedPlugins(ws, ['ws-mcp-entry.js'])
    await writeConfig(ws, mcpRow('mcp-a', 'a', markerWs, {
      env: { MCP_FIXTURE_MODE: 'masked-partial', MCP_FIXTURE_MASKED_COUNT: '3' },
    }))
    const lease = await host.registry.acquire(ws)
    await vi.waitFor(async () => {
      expect((await readMarkers(markerWs)).starts).toHaveLength(1)
    }, { timeout: 5000 })
    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).toEqual(MASKED_VIEW)
    }, { timeout: 5000 })
    const pid1 = (await readMarkers(markerWs)).starts[0]!

    // Break the config with a server that exits on start and a secret canary.
    const { errors, warns } = captureLogs(host.ctx)
    await writeConfig(ws, mcpRow('mcp-a', 'a', markerBad, {
      mode: 'exit-on-start',
      env: { SECRET_CANARY: 'super-secret-live-token' },
    }))
    await vi.waitFor(() => {
      expect(host.registry.get(lease.canonical)?.reload?.status).toBe('failed')
    }, { timeout: 5000 })

    // The old workspace MCP is unloaded: its process exited and its tools are
    // gone; the mask is lifted, so the workspace inherits the full global
    // generation. The workspace scope, lease, and scope-root mapping survive.
    await vi.waitFor(async () => {
      expect((await readMarkers(markerWs)).exits).toContain(pid1)
    }, { timeout: 5000 })
    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).toEqual(expect.arrayContaining(GLOBAL_A_NAMES))
    }, { timeout: 5000 })
    expect(host.registry.get(lease.canonical)?.composition).toBeUndefined()
    expect(host.registry.workspaceForScope(lease.key)).toBe(lease.canonical)
    let scopeDisposed = false
    lease.ctx.effect(() => () => {
      scopeDisposed = true
    })

    // The secret canary never reaches any log line.
    const all = [...errors, ...warns].join('\n')
    expect(all).not.toContain('super-secret-live-token')
    expect(all).not.toContain('SECRET_CANARY=')

    // Fix the file: the next event restarts the workspace row and rebuilds
    // the mask.
    await writeConfig(ws, mcpRow('mcp-a', 'a', markerFixed, {
      env: { MCP_FIXTURE_MODE: 'masked-partial', MCP_FIXTURE_MASKED_COUNT: '3' },
    }))
    await vi.waitFor(async () => {
      expect((await readMarkers(markerFixed)).starts).toHaveLength(1)
    }, { timeout: 5000 })
    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).toEqual(MASKED_VIEW)
    }, { timeout: 5000 })
    await vi.waitFor(() => {
      expect(host.registry.get(lease.canonical)?.reload?.status).toBe('idle')
    }, { timeout: 5000 })

    // Final release: no workspace process, tool, or mask remains; the global
    // row keeps its process until disposed.
    const pidFixed = (await readMarkers(markerFixed)).starts[0]!
    await lease.release()
    await vi.waitFor(async () => {
      expect((await readMarkers(markerFixed)).exits).toContain(pidFixed)
    }, { timeout: 5000 })
    expect(await viewNames(host.ctx, undefined)).toEqual(expect.arrayContaining(GLOBAL_A_NAMES))
    expect(scopeDisposed).toBe(true)
    await globalA.dispose()
    await vi.waitFor(async () => {
      expect((await readMarkers(markerGlobal)).exits).toHaveLength(1)
    }, { timeout: 5000 })
  })

  it('valid->absent removes the workspace MCP process and tools, and a later add restores them', async () => {
    const markerGlobal = await newMarker()
    const markerWs1 = await newMarker()
    const markerWs2 = await newMarker()
    const globalA = await host.ctx.plugin(workspaceClient, globalConfig('a', markerGlobal, {
      MCP_FIXTURE_MODE: 'masked',
      MCP_FIXTURE_MASKED_COUNT: '5',
    }))
    const ws = await makeWorkspace(host.root, 'mcp-absent')
    await seedPlugins(ws, ['ws-mcp-entry.js'])
    const configPath = await writeConfig(ws, mcpRow('mcp-a', 'a', markerWs1, {
      env: { MCP_FIXTURE_MODE: 'masked-partial', MCP_FIXTURE_MASKED_COUNT: '3' },
    }))
    const lease = await host.registry.acquire(ws)
    await vi.waitFor(async () => {
      expect((await readMarkers(markerWs1)).starts).toHaveLength(1)
    }, { timeout: 5000 })
    const pid1 = (await readMarkers(markerWs1)).starts[0]!

    // Delete the config: the workspace row unloads (process exits, tools and
    // mask gone) and the workspace inherits the global generation.
    await rm(configPath)
    await vi.waitFor(async () => {
      expect((await readMarkers(markerWs1)).exits).toContain(pid1)
    }, { timeout: 5000 })
    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).toEqual(expect.arrayContaining(GLOBAL_A_NAMES))
    }, { timeout: 5000 })

    // Recreate the config: a fresh workspace process starts and masks again.
    await writeConfig(ws, mcpRow('mcp-a', 'a', markerWs2, {
      env: { MCP_FIXTURE_MODE: 'masked-partial', MCP_FIXTURE_MASKED_COUNT: '3' },
    }))
    await vi.waitFor(async () => {
      expect((await readMarkers(markerWs2)).starts).toHaveLength(1)
    }, { timeout: 5000 })
    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).toEqual(MASKED_VIEW)
    }, { timeout: 5000 })

    const pid2 = (await readMarkers(markerWs2)).starts[0]!
    await lease.release()
    await vi.waitFor(async () => {
      expect((await readMarkers(markerWs2)).exits).toContain(pid2)
    }, { timeout: 5000 })
    await globalA.dispose()
    await vi.waitFor(async () => {
      expect((await readMarkers(markerGlobal)).exits).toHaveLength(1)
    }, { timeout: 5000 })
  })
})
