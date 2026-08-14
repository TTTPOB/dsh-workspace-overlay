/**
 * Connection supervisor tests: reconnect with bounded backoff, the failure
 * cap, the stability-window budget reset, list_changed re-sync (including
 * failure keeping the previous generation), startup failure policy, disposal
 * quiescence, and generation notifications — with the MCP SDK mocked so the
 * state machine is driven deterministically. Isolated file so vi.mock of the
 * SDK does not pollute other suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Config } from '../../src/mcp/types.js'

// ---- Mock MCP SDK ----

// vi.mock factories are hoisted above every import/const, so the mock fns and
// class must be created inside vi.hoisted to exist when the factories run.
const { mockConnect, mockClose, mockListTools, mockCallTool, mockSetNotificationHandler, MockClient, instances } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockCallTool = vi.fn<(
    _params?: Record<string, unknown>, _compatibilitySchema?: unknown, _options?: unknown,
  ) => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
    _schema: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    if (request.method === 'tools/call') return await mockCallTool(request.params, undefined, options)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    request = mockRequest
    setNotificationHandler = mockSetNotificationHandler
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  return { mockConnect, mockClose, mockListTools, mockCallTool, mockSetNotificationHandler, MockClient, instances }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}))

// vi.mock is hoisted above static imports, so the modules under test see the
// mocked SDK even through a static import.
import { apply } from '../../src/mcp/index.js'
import { RECONNECT_DEFAULTS, resolveReconnectPolicy, startConnection } from '../../src/mcp/connection.js'
import type { GenerationNotification } from '../../src/mcp/types.js'
import { captureLogs, mountRegistry, nextCallId, sleep, testToolSignal } from './helpers.js'

// ---- Helpers ----

function stdioConfig(extra: Record<string, unknown> = {}): Config {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...extra,
  } as Config
}

/** The tool list the mock server advertises after a successful (re)connect. */
function listing(...names: string[]): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return {
    tools: names.map(name => ({ name, inputSchema: { type: 'object' } })),
    nextCursor: undefined,
  }
}

describe('reconnect supervisor', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    instances.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue(listing('remote'))
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    ctx = await mountRegistry()
  })

  it('reconnects after a transport close, re-syncs through the new generation, and serves calls', async () => {
    const { warns, infos } = captureLogs(ctx)
    const notifications: GenerationNotification[] = []
    const handle = startConnection(
      ctx,
      stdioConfig({ reconnect: { initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 5 } }),
      resolveReconnectPolicy({ initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 5 }, 'reconnect'),
      change => notifications.push(change),
    )
    await handle.ready
    expect(notifications).toEqual([{ serverName: 'srv', names: ['mcp__srv__remote'], status: 'registered' }])

    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(instances).toHaveLength(1)

    // The recovered server advertises a different list: the swap must neither
    // duplicate nor leak the pre-crash generation.
    mockListTools.mockResolvedValue(listing('revived'))
    instances[0]!.onclose?.()

    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__revived')).toBeDefined() })
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    expect(instances).toHaveLength(2)
    expect(mockConnect).toHaveBeenCalledTimes(2)
    expect(notifications.at(-1)).toEqual({ serverName: 'srv', names: ['mcp__srv__revived'], status: 'registered' })

    // Post-recovery calls execute through the re-registered definition.
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__srv__revived', arguments: {},
    })
    expect(result.isError).toBe(false)

    // User-visible state: reconnecting and recovered are distinct lines.
    expect(warns.some(line => line.includes('reconnecting in 5ms (attempt 1/5)'))).toBe(true)
    expect(infos.some(line => line.includes('reconnected and re-synced tools'))).toBe(true)

    // A late close signal from the replaced generation is ignored.
    instances[0]!.onclose?.()
    await sleep(30)
    expect(instances).toHaveLength(2)
    await handle.dispose()
  })

  it('stops at the failure cap, unregisters the tools, and notifies unregistered', async () => {
    const { warns, errors } = captureLogs(ctx)
    const notifications: GenerationNotification[] = []
    const handle = startConnection(
      ctx,
      stdioConfig({ reconnect: { initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 2 } }),
      resolveReconnectPolicy({ initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 2 }, 'reconnect'),
      change => notifications.push(change),
    )
    await handle.ready
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()

    mockConnect.mockRejectedValue(new Error('server gone'))
    // A failing close on the failed attempt's cleanup must not break the loop.
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.reject(new Error('already closed'))
    })
    instances[0]!.onclose?.()

    await vi.waitFor(() => {
      expect(errors.some(line => line.includes('giving up after 2 consecutive failed reconnect attempts'))).toBe(true)
    })
    // Stale tools do not leak past final failure.
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    // Initial connect + exactly maxAttempts reconnect attempts.
    expect(mockConnect).toHaveBeenCalledTimes(3)
    expect(warns.some(line => line.includes('connection attempt failed: Error: server gone'))).toBe(true)
    expect(warns.some(line => line.includes('connection failed; retrying in 4ms (attempt 2/2)'))).toBe(true)
    await sleep(30)
    expect(mockConnect).toHaveBeenCalledTimes(3)
    // The give-up cleared the generation: final notification is unregistered.
    expect(notifications.at(-1)).toEqual({ serverName: 'srv', names: [], status: 'unregistered' })
    await handle.dispose()
  })

  it('dispose cancels the pending reconnect, unregisters tools, and notifies unregistered', async () => {
    const notifications: GenerationNotification[] = []
    const handle = startConnection(
      ctx,
      stdioConfig({ reconnect: { initialDelayMs: 60_000, maxDelayMs: 60_000, maxAttempts: 5 } }),
      resolveReconnectPolicy({ initialDelayMs: 60_000, maxDelayMs: 60_000, maxAttempts: 5 }, 'reconnect'),
      change => notifications.push(change),
    )
    await handle.ready
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    instances[0]!.onclose?.()
    // Now waiting out a 60s backoff; disposal must return promptly anyway.
    await handle.dispose()
    await sleep(30)
    expect(mockConnect).toHaveBeenCalledTimes(1)
    expect(instances).toHaveLength(1)
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    expect(notifications.at(-1)).toEqual({ serverName: 'srv', names: [], status: 'unregistered' })
  })

  it('re-syncs on list_changed and keeps the previous generation when the re-sync fails', async () => {
    const { errors } = captureLogs(ctx)
    await apply(ctx, stdioConfig())
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()

    mockListTools.mockResolvedValue(listing('updated'))
    const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
    await handler()
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__updated')).toBeDefined()

    // A failing re-sync keeps serving the last good generation, logged.
    mockListTools.mockRejectedValue(new Error('flaky server'))
    await handler()
    expect(ctx.tools.get('mcp__srv__updated')).toBeDefined()
    expect(errors.some(line => line.includes('tool re-sync failed: Error: flaky server'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('failOnStartupError=false resolves apply, reports the outcome, and retries', async () => {
    const { warns } = captureLogs(ctx)
    mockConnect.mockRejectedValue(new Error('refused'))
    await apply(ctx, stdioConfig({ reconnect: { initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 2 } }))

    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    await vi.waitFor(() => {
      expect(warns.some(line => line.includes('connection failed; retrying in 2ms (attempt 1/2)'))).toBe(true)
      expect(warns.some(line => line.includes('connection failed; retrying in 4ms (attempt 2/2)'))).toBe(true)
    })
    await ctx.fiber.dispose()
  })

  it('failOnStartupError=true rejects apply with the real cause', async () => {
    const cause = new Error('refused')
    mockConnect.mockRejectedValue(cause)
    await expect(apply(ctx, stdioConfig({ failOnStartupError: true }))).rejects.toMatchObject({
      message: 'mcp-client(srv): initial connection or tool synchronization failed',
      cause,
    })
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('strict startup propagates a registration conflict; contained startup does not', async () => {
    ctx.tools.register({
      name: 'mcp__srv__remote',
      description: 'Foreign squatter',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => 'foreign',
    })

    await expect(apply(ctx, stdioConfig({ failOnStartupError: true })))
      .rejects.toThrow('initial connection or tool synchronization failed')
    expect(ctx.tools.get('mcp__srv__remote')?.description).toBe('Foreign squatter')
    await ctx.fiber.dispose()

    // Contained startup: apply resolves, no tools from this server, squatter intact.
    const contained = await mountRegistry()
    contained.tools.register({
      name: 'mcp__srv__remote',
      description: 'Foreign squatter',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => 'foreign',
    })
    await apply(contained, stdioConfig())
    expect(contained.tools.get('mcp__srv__remote')?.description).toBe('Foreign squatter')
    await contained.fiber.dispose()
  })

  it('rejects a duplicate serverName at load and releases the reservation on dispose', async () => {
    await apply(ctx, stdioConfig())
    await expect(apply(ctx, stdioConfig())).rejects.toThrow(/serverName "srv" is already in use/)

    await apply(ctx, stdioConfig({ serverName: 'other' }))
    expect(ctx.tools.get('mcp__other__remote')).toBeDefined()
    await ctx.fiber.dispose()

    // The disposed instance no longer holds the reservation on its root.
    await expect(apply(ctx, stdioConfig())).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('an uptime past the stability window resets the attempt budget', async () => {
    const { errors } = captureLogs(ctx)
    await apply(ctx, stdioConfig({ reconnect: { initialDelayMs: 2, maxDelayMs: 30, maxAttempts: 1 } }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(instances).toHaveLength(2) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    await sleep(40)
    instances[1]!.onclose?.()
    await vi.waitFor(() => { expect(instances).toHaveLength(3) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(errors).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('reconnect disabled keeps registered tools after a lost connection', async () => {
    const { errors } = captureLogs(ctx)
    await apply(ctx, stdioConfig({ reconnect: { enabled: false } }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    instances[0]!.onclose?.()
    await sleep(30)
    expect(mockConnect).toHaveBeenCalledTimes(1)
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    expect(errors.some(line => line.includes('connection lost and reconnect is disabled'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('dispose quiesces an in-flight sync and unregisters everything it published', async () => {
    const fiber = ctx.plugin(
      { name: 'mcp-client', inject: ['tools'], apply },
      stdioConfig({ reconnect: { initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 5 } }),
    )
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    const gate: PromiseWithResolvers<unknown> = Promise.withResolvers()
    mockListTools.mockImplementation(() => gate.promise)
    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(mockListTools).toHaveBeenCalledTimes(2) })

    const disposing = fiber.dispose()
    await sleep(10)
    gate.resolve(listing('late'))
    await disposing

    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__late')).toBeUndefined()
  })

  it('a stale notification handler from a replaced generation is ignored', async () => {
    await apply(ctx, stdioConfig({ reconnect: { initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 5 } }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(instances).toHaveLength(2) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    const listCalls = mockListTools.mock.calls.length

    const staleHandler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
    await staleHandler()
    expect(mockListTools).toHaveBeenCalledTimes(listCalls)
    await ctx.fiber.dispose()
  })

  it('uses the streamable-http config path', async () => {
    const httpConfig: Config = {
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer x' },
      toolCallTimeoutMs: 30_000,
      failOnStartupError: false,
    }
    await apply(ctx, httpConfig)
    expect(ctx.tools.get('mcp__web__remote')).toBeDefined()
    await ctx.fiber.dispose()
  })
})

// ---- Policy resolution ----

describe('resolveReconnectPolicy', () => {
  const path = 'mcp-client(srv): reconnect'

  it('resolves omission to the defaults, frozen', () => {
    const policy = resolveReconnectPolicy(undefined, path)
    expect(policy).toEqual(RECONNECT_DEFAULTS)
    expect(Object.isFrozen(policy)).toBe(true)
  })

  it('keeps explicit values', () => {
    expect(resolveReconnectPolicy(
      { enabled: false, initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 7 },
      path,
    )).toEqual({ enabled: false, initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 7 })
  })

  it('rejects unknown keys', () => {
    expect(() => resolveReconnectPolicy({ jitterRatio: 0.5 } as never, path))
      .toThrow(/reconnect\.jitterRatio is not a reconnect option/)
  })

  it('rejects out-of-range delays', () => {
    expect(() => resolveReconnectPolicy({ initialDelayMs: 0 }, path)).toThrow(/initialDelayMs must be a positive finite number/)
    expect(() => resolveReconnectPolicy({ initialDelayMs: Number.POSITIVE_INFINITY }, path)).toThrow(/initialDelayMs/)
    expect(() => resolveReconnectPolicy({ maxDelayMs: -1 }, path)).toThrow(/maxDelayMs must be a positive finite number/)
  })

  it('rejects an initial delay above the ceiling', () => {
    expect(() => resolveReconnectPolicy({ initialDelayMs: 100, maxDelayMs: 5 }, path))
      .toThrow(/initialDelayMs must be less than or equal to maxDelayMs/)
  })

  it('rejects non-positive-integer attempt caps', () => {
    expect(() => resolveReconnectPolicy({ maxAttempts: 0 }, path)).toThrow(/maxAttempts must be a positive integer/)
    expect(() => resolveReconnectPolicy({ maxAttempts: 1.5 }, path)).toThrow(/maxAttempts must be a positive integer/)
  })

  it('apply fails loud at load on a misconfigured reconnect', async () => {
    const ctx = await mountRegistry()
    await expect(apply(ctx, stdioConfig({ reconnect: { initialDelayMs: 100, maxDelayMs: 5 } })))
      .rejects.toThrow(/initialDelayMs must be less than or equal to maxDelayMs/)
    await ctx.fiber.dispose()
  })
})
