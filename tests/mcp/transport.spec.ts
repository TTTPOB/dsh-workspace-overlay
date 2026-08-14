/**
 * Transport factory tests: SDK transport selection for both config branches,
 * plus a REAL stdio spawn over the raw SDK Client proving the child receives
 * the scrubbed ambient env plus explicit overrides, with a canary secret that
 * must never reach the child, and an explicit `cwd` that must be honored.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTransport } from '../../src/mcp/transport.js'
import type { Config } from '../../src/mcp/types.js'
import { makeMarkerFile, readMarkers, removeMarkerFile } from './helpers.js'

const FIXTURE_SERVER = fileURLToPath(new URL('../fixtures/mcp/fixture-server.ts', import.meta.url))

/** Base stdio config for the fixture server; `extra` may override any field. */
function fixtureConfig(extra: Record<string, unknown> = {}): Config {
  return {
    transport: 'stdio',
    serverName: 'fixture',
    command: process.execPath,
    args: [FIXTURE_SERVER],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 5_000,
    failOnStartupError: false,
    ...extra,
  } as Config
}

/** The ambient env entries restored by afterEach. */
const ambientEnv = new Map<string, string | undefined>()

describe('createTransport', () => {
  it('creates a StdioClientTransport for stdio config', () => {
    const transport = createTransport(fixtureConfig())
    expect(transport).toBeInstanceOf(StdioClientTransport)
  })

  it('creates a StreamableHTTPClientTransport for streamable-http config', () => {
    const transport = createTransport({
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer token' },
      toolCallTimeoutMs: 5_000,
      failOnStartupError: false,
    })
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
  })
})

describe('stdio transport child environment', () => {
  afterEach(async () => {
    // Restore every ambient entry this suite set (the child env snapshot is
    // taken at spawn, so restoring here never affects already-spawned tests).
    for (const [key, value] of ambientEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    ambientEnv.clear()
  })

  /** Set an ambient env entry for the duration of this suite; returns a restorer. */
  function setAmbient(key: string, value: string | undefined): void {
    if (!ambientEnv.has(key)) ambientEnv.set(key, process.env[key])
    process.env[key] = value as string
  }

  it('scrubs credential-shaped and DSH_* vars, keeps safe vars, merges explicit env, honors cwd', async () => {
    const marker = await makeMarkerFile()
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-mcp-cwd-'))
    try {
      setAmbient('API_KEY', 'canary-api-key')
      setAmbient('MCP_TEST_SECRET', 'canary-secret')
      setAmbient('DSH_WS_CANARY', 'canary-dsh')
      setAmbient('MCP_SAFE_VAR', 'safe-value')

      const client = new Client({ name: 'transport-spec', version: '1' })
      await client.connect(createTransport(fixtureConfig({
        env: {
          MCP_FIXTURE_MARKER: marker,
          MCP_FIXTURE_EXTRA: 'explicit-value',
        },
        cwd,
      })))
      try {
        const listing = await client.request({ method: 'tools/list' }, ListToolsResultSchema)
        expect(listing.tools.map(tool => tool.name)).toContain('env_echo')

        const envCall = await client.request({
          method: 'tools/call',
          params: {
            name: 'env_echo',
            arguments: { names: ['API_KEY', 'MCP_TEST_SECRET', 'DSH_WS_CANARY', 'MCP_SAFE_VAR', 'MCP_FIXTURE_EXTRA'] },
          },
        }, CallToolResultSchema)
        const entries = JSON.parse(String(envCall.content[0] && 'text' in envCall.content[0] ? envCall.content[0].text : '')) as [string, string | null][]
        expect(Object.fromEntries(entries)).toEqual({
          API_KEY: null,
          MCP_TEST_SECRET: null,
          DSH_WS_CANARY: null,
          MCP_SAFE_VAR: 'safe-value',
          MCP_FIXTURE_EXTRA: 'explicit-value',
        })

        const cwdCall = await client.request({
          method: 'tools/call',
          params: { name: 'cwd_echo', arguments: {} },
        }, CallToolResultSchema)
        const reported = cwdCall.content[0] && 'text' in cwdCall.content[0] ? cwdCall.content[0].text : ''
        expect(reported).toBe(cwd)
      } finally {
        await client.close()
      }

      // The child exited; its lifecycle is fully recorded in the marker.
      await expect.poll(() => readMarkers(marker)).toMatchObject({ starts: [expect.any(Number)], exits: [expect.any(Number)] })
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await removeMarkerFile(marker)
    }
  })
})
