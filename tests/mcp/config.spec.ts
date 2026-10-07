/**
 * Config schema tests for the ported MCP core, including supported-field checks
 * against the official 0.1.7-rc.2 `@deepseek-ai/dsh-mcp-client` Config schema
 * (imported from the public package entry, never a private subpath).
 */
import { describe, expect, it } from 'vitest'
import { Config as OfficialConfig } from '@deepseek-ai/dsh-mcp-client'
import { Config } from '../../src/mcp/config.js'
import { RECONNECT_DEFAULTS } from '../../src/mcp/connection.js'

/** Minimal raw stdio config exercising every defaulted field. */
function rawStdio(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { transport: 'stdio', serverName: 'srv', command: 'echo', ...extra }
}

describe('mcp Config schema', () => {
  it('materializes every stdio default', () => {
    const resolved = Config(rawStdio() as never)
    expect(resolved).toEqual({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
      reconnect: RECONNECT_DEFAULTS,
    })
  })

  it('materializes every streamable-http default', () => {
    const resolved = Config({
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://localhost:3000/mcp',
    } as never)
    expect(resolved).toEqual({
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://localhost:3000/mcp',
      headers: {},
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
      reconnect: RECONNECT_DEFAULTS,
    })
  })

  it('merges partial reconnect overrides onto the defaults', () => {
    const resolved = Config(rawStdio({ reconnect: { initialDelayMs: 100 } }) as never)
    expect(resolved.reconnect).toEqual({ ...RECONNECT_DEFAULTS, initialDelayMs: 100 })
  })

  it('rejects a missing serverName', () => {
    expect(() => Config({ transport: 'stdio', command: 'echo' } as never)).toThrow()
  })

  it('rejects an invalid serverName', () => {
    expect(() => Config(rawStdio({ serverName: 'bad name!' }) as never)).toThrow()
    expect(() => Config(rawStdio({ serverName: 'x'.repeat(33) }) as never)).toThrow()
  })

  it('accepts a valid serverName', () => {
    expect(Config(rawStdio({ serverName: 'github-prod_1' }) as never).serverName).toBe('github-prod_1')
  })

  it('rejects an invalid reconnect block', () => {
    expect(() => Config(rawStdio({ reconnect: { maxAttempts: 0 } }) as never)).toThrow()
  })

  it('rejects unsupported server-instruction configuration for both transports', () => {
    expect(() => Config(rawStdio({ maxInstructionBytes: 32_768 }) as never)).toThrow()
    expect(() => Config({ transport: 'streamable-http', serverName: 'web', url: 'http://x/mcp', maxInstructionBytes: 32_768 } as never)).toThrow()
  })

  it('rejects an unknown transport', () => {
    expect(() => Config(rawStdio({ transport: 'sse' }) as never)).toThrow()
  })
})

describe('supported-field compatibility with the official 0.1.7-rc.2 Config schema', () => {
  const supported = [
    'transport', 'serverName', 'command', 'args', 'env', 'cwd', 'url', 'headers',
    'toolCallTimeoutMs', 'failOnStartupError', 'reconnect',
  ]
  const cases: Record<string, unknown>[] = [
    rawStdio(),
    rawStdio({ args: ['a', 'b'], env: { K: 'v' }, cwd: '/tmp', toolCallTimeoutMs: 1234, failOnStartupError: true }),
    rawStdio({ reconnect: { initialDelayMs: 100, maxDelayMs: 5000, maxAttempts: 3 } }),
    rawStdio({ reconnect: { enabled: false } }),
    { transport: 'streamable-http', serverName: 'web', url: 'http://x/mcp' },
    { transport: 'streamable-http', serverName: 'web', url: 'http://x/mcp', headers: { Authorization: 'Bearer t' } },
  ]

  it('normalizes every supported field identically', () => {
    for (const raw of cases) {
      const mine = Config(raw as never)
      const official = OfficialConfig(raw as never)
      expect(mine).toEqual(Object.fromEntries(Object.entries(official).filter(([key]) => supported.includes(key))))
    }
  })

  it('rejects the same invalid configs', () => {
    const invalid: Record<string, unknown>[] = [
      { transport: 'stdio', command: 'echo' },
      { transport: 'stdio', serverName: 'bad name!', command: 'echo' },
      rawStdio({ reconnect: { maxAttempts: 0 } }),
      rawStdio({ reconnect: { initialDelayMs: 0 } }),
      rawStdio({ transport: 'sse' }),
      { transport: 'streamable-http', serverName: 'srv' },
    ]
    for (const raw of invalid) {
      let mineThrew = false
      let officialThrew = false
      try { Config(raw as never) } catch { mineThrew = true }
      try { OfficialConfig(raw as never) } catch { officialThrew = true }
      expect(mineThrew, JSON.stringify(raw)).toBe(true)
      expect(officialThrew, JSON.stringify(raw)).toBe(true)
    }
  })
})
