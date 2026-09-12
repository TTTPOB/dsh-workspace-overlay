/**
 * End-to-end integration tests for the ported MCP core against the real
 * fixture server (spawned stdio child processes, disposed within the test
 * process lifecycle) and an in-process Streamable HTTP server (headers
 * asserted server-side). Covers discovery, naming, pagination, startup
 * failure policy, crash recovery, list_changed resync, call timeout and
 * cancellation, and teardown with no leftover child processes.
 */
import { describe, expect, it, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createServer, type Server as HttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { apply, publicToolName, resolveReconnectPolicy, startConnection } from '../../src/mcp/index.js'
import type { Config } from '../../src/mcp/types.js'
import type { GenerationNotification } from '../../src/mcp/types.js'
import {
  KNOWN_FIXTURE_HASH_NAME,
  captureLogs,
  killMarkedProcesses,
  makeMarkerFile,
  mountRegistry,
  nextCallId,
  readMarkers,
  removeMarkerFile,
  sleep,
  testToolSignal,
} from './helpers.js'
import { Context } from '@deepseek-ai/cordis'

const FIXTURE_SERVER = fileURLToPath(new URL('../fixtures/mcp/fixture-server.ts', import.meta.url))

/** Stdio config spawning the fixture server with the given env/mode. */
function fixtureConfig(serverName: string, extra: Record<string, unknown> = {}): Config {
  return {
    transport: 'stdio',
    serverName,
    command: process.execPath,
    args: [FIXTURE_SERVER],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 5_000,
    failOnStartupError: false,
    ...extra,
  } as Config
}

// ---- Shared discovery/execution suite over one normal-mode server ----

describe('fixture server — discovery and execution', () => {
  let ctx: Context
  let marker: string

  beforeAll(async () => {
    marker = await makeMarkerFile()
    ctx = await mountRegistry()
    await apply(ctx, fixtureConfig('fixture', {
      env: { MCP_FIXTURE_MARKER: marker },
      reconnect: { initialDelayMs: 50, maxDelayMs: 200, maxAttempts: 3 },
    }))
  }, 30_000)

  afterAll(async () => {
    if (ctx) await ctx.fiber.dispose()
    await sleep(300)
    await killMarkedProcesses(marker)
    await removeMarkerFile(marker)
  })

  it('discovers all fixture tools under the server namespace, never raw names', () => {
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('mcp__fixture__add')
    expect(names).toContain('mcp__fixture__greet')
    expect(names).toContain('mcp__fixture__fail')
    expect(names).toContain('mcp__fixture__image')
    expect(names).toContain('mcp__fixture__env_echo')
    expect(names).toContain('mcp__fixture__cwd_echo')
    expect(names).toContain('mcp__fixture__slow')
    expect(names).toContain('mcp__fixture__register_extra')
    expect(names).not.toContain('add')
    expect(names).not.toContain('greet')
  })

  it('normalizes the dotted tool name with the installed-rc.6 known-answer hash', () => {
    expect(publicToolName('fixture', 'admin.reset')).toBe(KNOWN_FIXTURE_HASH_NAME)
    expect(ctx.tools.get(KNOWN_FIXTURE_HASH_NAME)).toBeDefined()
  })

  it('executes tools through the public names with the raw name on the wire', async () => {
    const add = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__fixture__add', arguments: { a: 2, b: 3 },
    })
    if (add.isError) throw new Error(`add failed: ${add.error?.message}`)
    expect(add.content[0]).toEqual({ type: 'text', text: '5' })
    expect(add.value).toEqual({ content: [{ type: 'text', text: '5' }] })

    const reset = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: KNOWN_FIXTURE_HASH_NAME, arguments: {},
    })
    if (reset.isError) throw new Error(`admin.reset failed: ${reset.error?.message}`)
    expect(reset.content[0]).toEqual({ type: 'text', text: 'reset done' })
  })

  it('maps MCP isError to a harness error result', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__fixture__fail', arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Error: Something went wrong' })
  })

  it('projects image blocks to placeholders while preserving the JSON value', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__fixture__image', arguments: {},
    })
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Here is an image:\n[image: image/png, content discarded]\nEnd of image.',
    })
    if (result.isError) throw new Error('expected image success')
    expect(result.value).toMatchObject({
      content: [
        { type: 'text', text: 'Here is an image:' },
        { type: 'image', mimeType: 'image/png' },
        { type: 'text', text: 'End of image.' },
      ],
    })
  })

  it('drains paginated tools/list from the real server', async () => {
    // A second server in paginate mode with page size 2.
    const ctx2 = await mountRegistry()
    const paginatedMarker = await makeMarkerFile()
    try {
      await apply(ctx2, fixtureConfig('paged', {
        env: { MCP_FIXTURE_MODE: 'paginate', MCP_FIXTURE_PAGE_SIZE: '2', MCP_FIXTURE_MARKER: paginatedMarker },
      }))
      const names = ctx2.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('mcp__paged__'))
      expect(names).toContain('mcp__paged__add')
      expect(names).toContain('mcp__paged__greet')
      expect(names).toContain(publicToolName('paged', 'admin.reset'))
      expect(names.length).toBe(10)
    } finally {
      await ctx2.fiber.dispose()
      await sleep(200)
      await killMarkedProcesses(paginatedMarker)
      await removeMarkerFile(paginatedMarker)
    }
  })
})

// ---- Startup failure policy ----

describe('fixture server — startup failure policy', () => {
  let ctx: Context
  let marker: string

  beforeEach(async () => {
    ctx = await mountRegistry()
    marker = await makeMarkerFile()
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await sleep(200)
    await killMarkedProcesses(marker)
    await removeMarkerFile(marker)
  })

  it('failOnStartupError=true rejects apply for a duplicate tool list; no tools registered', async () => {
    await expect(apply(ctx, fixtureConfig('dup', {
      env: { MCP_FIXTURE_MODE: 'dup-list', MCP_FIXTURE_MARKER: marker },
      failOnStartupError: true,
    }))).rejects.toThrow('initial connection or tool synchronization failed')
    expect(ctx.tools.schemas().some(schema => schema.name.startsWith('mcp__dup__'))).toBe(false)
  })

  it('failOnStartupError=true accepts full MCP input schema vocabulary', async () => {
    await expect(apply(ctx, fixtureConfig('schema', {
      env: { MCP_FIXTURE_MODE: 'bad-schema-list', MCP_FIXTURE_MARKER: marker },
      failOnStartupError: true,
    }))).resolves.toBeUndefined()
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('mcp__schema__')))
      .toEqual(['mcp__schema__add', 'mcp__schema__exotic'])
  })

  it('failOnStartupError=true rejects apply when the server exits on start', async () => {
    await expect(apply(ctx, fixtureConfig('dead', {
      env: { MCP_FIXTURE_MODE: 'exit-on-start', MCP_FIXTURE_MARKER: marker },
      failOnStartupError: true,
    }))).rejects.toThrow('initial connection or tool synchronization failed')
    expect(ctx.tools.schemas().some(schema => schema.name.startsWith('mcp__dead__'))).toBe(false)
  })

  it('failOnStartupError=false survives a dying server, retries, and gives up with bounded processes', async () => {
    const { errors } = captureLogs(ctx)
    await apply(ctx, fixtureConfig('dead', {
      env: { MCP_FIXTURE_MODE: 'exit-on-start', MCP_FIXTURE_MARKER: marker },
      failOnStartupError: false,
      reconnect: { initialDelayMs: 30, maxDelayMs: 60, maxAttempts: 2 },
    }))
    await vi.waitFor(() => {
      expect(errors.some(line => line.includes('giving up after 2 consecutive failed reconnect attempts'))).toBe(true)
    })
    expect(ctx.tools.schemas().some(schema => schema.name.startsWith('mcp__dead__'))).toBe(false)

    // Initial process + exactly maxAttempts retry processes, all exited.
    const log = await readMarkers(marker)
    expect(log.starts.length).toBe(3)
    expect(log.exits.length).toBe(3)
  })
})

// ---- Crash recovery / list_changed / timeout / cancel / dispose ----

describe('fixture server — lifecycle behaviors', () => {
  let ctx: Context
  let marker: string

  beforeEach(async () => {
    ctx = await mountRegistry()
    marker = await makeMarkerFile()
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await sleep(300)
    await killMarkedProcesses(marker)
    await removeMarkerFile(marker)
  })

  it('crash recovery: a new generation reconnects and re-registers the tools', async () => {
    const { warns, infos } = captureLogs(ctx)
    await apply(ctx, fixtureConfig('crashy', {
      env: { MCP_FIXTURE_MARKER: marker },
      reconnect: { initialDelayMs: 50, maxDelayMs: 200, maxAttempts: 3 },
    }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__crashy__add')).toBeDefined() })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__crashy__crash', arguments: {},
    })
    if (result.isError) throw new Error(`crash call failed: ${result.error?.message}`)

    await vi.waitFor(() => {
      expect(ctx.tools.get('mcp__crashy__add')).toBeDefined()
      expect(warns.some(line => line.includes('connection lost; reconnecting'))).toBe(true)
      expect(infos.some(line => line.includes('reconnected and re-synced tools'))).toBe(true)
    })
    // A second server process took over.
    expect((await readMarkers(marker)).starts.length).toBeGreaterThanOrEqual(2)

    // The re-registered definition serves calls again.
    const again = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__crashy__add', arguments: { a: 1, b: 1 },
    })
    if (again.isError) throw new Error(`post-reconnect add failed: ${again.error?.message}`)
    expect(again.content[0]).toEqual({ type: 'text', text: '2' })
  })

  it('list_changed re-syncs and the replacement serves calls', async () => {
    await apply(ctx, fixtureConfig('dyn', { env: { MCP_FIXTURE_MARKER: marker } }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__dyn__register_extra')).toBeDefined() })

    const trigger = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__dyn__register_extra', arguments: { name: 'dyn1' },
    })
    if (trigger.isError) throw new Error(`register_extra failed: ${trigger.error?.message}`)

    await vi.waitFor(() => { expect(ctx.tools.get('mcp__dyn__dyn1')).toBeDefined() })
    // The rest of the generation stayed registered.
    expect(ctx.tools.get('mcp__dyn__add')).toBeDefined()

    const call = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__dyn__dyn1', arguments: {},
    })
    if (call.isError) throw new Error(`dyn1 failed: ${call.error?.message}`)
    expect(call.content[0]).toEqual({ type: 'text', text: 'extra' })
  })

  it('a failing list_changed re-sync keeps the previous good generation', async () => {
    const { errors } = captureLogs(ctx)
    await apply(ctx, fixtureConfig('flaky', {
      env: { MCP_FIXTURE_MARKER: marker, MCP_FIXTURE_FAIL_LIST_AFTER: '1' },
    }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__flaky__add')).toBeDefined() })

    // The initial sync consumed list #1; the notification-triggered list #2 fails.
    const trigger = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__flaky__register_extra', arguments: { name: 'ghost' },
    })
    if (trigger.isError) throw new Error(`register_extra failed: ${trigger.error?.message}`)

    await vi.waitFor(() => {
      expect(errors.some(line => line.includes('tool re-sync failed:') && line.includes('injected list failure'))).toBe(true)
    })
    // The previous generation is still live; the failed one never registered.
    expect(ctx.tools.get('mcp__flaky__add')).toBeDefined()
    expect(ctx.tools.get('mcp__flaky__ghost')).toBeUndefined()
  })

  it('call timeout surfaces as a harness error without wedging the connection', async () => {
    const notifications: GenerationNotification[] = []
    const handle = startConnection(
      ctx,
      fixtureConfig('timeout', {
        env: { MCP_FIXTURE_MARKER: marker },
        toolCallTimeoutMs: 300,
        reconnect: { initialDelayMs: 50, maxDelayMs: 200, maxAttempts: 3 },
      }),
      resolveReconnectPolicy({ initialDelayMs: 50, maxDelayMs: 200, maxAttempts: 3 }, 'reconnect'),
      change => notifications.push(change),
    )
    await handle.ready
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__timeout__slow')).toBeDefined() })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__timeout__slow', arguments: { ms: 5_000 },
    })
    expect(result.isError).toBe(true)
    expect(String(result.error?.message)).toMatch(/timed out|timeout/i)

    // The connection survives the timeout and keeps serving.
    const after = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__timeout__add', arguments: { a: 1, b: 2 },
    })
    if (after.isError) throw new Error(`post-timeout call failed: ${after.error?.message}`)
    expect(after.content[0]).toEqual({ type: 'text', text: '3' })
    expect(notifications.at(-1)).toEqual({ serverName: 'timeout', names: expect.any(Array), status: 'registered' })
    await handle.dispose()
  })

  it('caller cancellation aborts the in-flight call', async () => {
    await apply(ctx, fixtureConfig('cancellable', { env: { MCP_FIXTURE_MARKER: marker } }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__cancellable__slow')).toBeDefined() })

    const controller = new AbortController()
    const pending = ctx.tools.execute({
      signal: controller.signal,
      callId: nextCallId(), name: 'mcp__cancellable__slow', arguments: { ms: 10_000 },
    })
    await sleep(100)
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(String(result.error?.message)).toMatch(/abort/i)
  })

  it('dispose closes the child process and unregisters every tool', async () => {
    const notifications: GenerationNotification[] = []
    const handle = startConnection(
      ctx,
      fixtureConfig('dispose-me', { env: { MCP_FIXTURE_MARKER: marker } }),
      resolveReconnectPolicy(undefined, 'reconnect'),
      change => notifications.push(change),
    )
    await handle.ready
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__dispose-me__add')).toBeDefined() })
    const pid = (await readMarkers(marker)).starts[0]
    expect(pid).toBeDefined()

    await handle.dispose()
    await sleep(500)

    // Every tool this server owned is unregistered; the final notification
    // reports zero live registrations.
    expect(ctx.tools.get('mcp__dispose-me__add')).toBeUndefined()
    expect(ctx.tools.schemas().some(schema => schema.name.startsWith('mcp__dispose-me__'))).toBe(false)
    expect(notifications.at(-1)).toEqual({ serverName: 'dispose-me', names: [], status: 'unregistered' })

    // The child process exited (marker records it), so nothing lingers.
    await expect.poll(async () => (await readMarkers(marker)).exits).toContain(pid)
  })
})

// ---- Streamable HTTP ----

describe('streamable-http transport end to end', () => {
  let ctx: Context
  let httpServer: HttpServer
  let baseUrl: string
  /** The Authorization header the client attached, observed server-side. */
  let seenAuthorization: string | undefined

  beforeAll(async () => {
    ctx = await mountRegistry()

    httpServer = createServer(async (req, res) => {
      seenAuthorization = req.headers.authorization
      // Stateless mode: the SDK Protocol binds one transport for life, so each
      // self-contained HTTP request gets a fresh Server + transport.
      const mcpServer = new Server(
        { name: 'http-fixture', version: '1.0.0' },
        { capabilities: { tools: {} } },
      )
      mcpServer.setRequestHandler(InitializeRequestSchema, async request => ({
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'http-fixture', version: '1.0.0' },
      }))
      mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'http_add', description: 'Adds over HTTP.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }],
      }))
      mcpServer.setRequestHandler(CallToolRequestSchema, async request => ({
        content: [{ type: 'text', text: String(Number(request.params.arguments?.a) + Number(request.params.arguments?.b)) }],
      }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await mcpServer.connect(transport)
      await transport.handleRequest(req, res)
    })
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('http server did not bind a port')
    baseUrl = `http://127.0.0.1:${address.port}/mcp`
  }, 15_000)

  afterAll(async () => {
    await ctx.fiber.dispose()
    await new Promise<void>((resolve, reject) => {
      httpServer.closeAllConnections?.()
      httpServer.close(error => error ? reject(error) : resolve())
    })
  })

  it('connects with headers, registers tools, and serves calls; headers reach the server', async () => {
    const { errors } = captureLogs(ctx)
    await apply(ctx, {
      transport: 'streamable-http',
      serverName: 'http',
      url: baseUrl,
      headers: { Authorization: 'Bearer http-canary-header' },
      toolCallTimeoutMs: 5_000,
      failOnStartupError: false,
    })

    expect(ctx.tools.get('mcp__http__http_add')).toBeDefined()
    // The configured header reached the server on the wire.
    expect(seenAuthorization).toBe('Bearer http-canary-header')
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__http__http_add', arguments: { a: 20, b: 22 },
    })
    if (result.isError) throw new Error(`http_add failed: ${result.error?.message}`)
    expect(result.content[0]).toEqual({ type: 'text', text: '42' })

    // No log line carries the header value.
    expect(errors.some(line => line.includes('http-canary-header'))).toBe(false)
    await ctx.fiber.dispose()
  })
})
