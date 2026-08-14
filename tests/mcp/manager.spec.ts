/**
 * Workspace-aware MCP manager tests: scope identity, reservations, workspace
 * row validation (failOnStartupError / cwd), the namespace mask over the real
 * ScopedLayers registry, global-generation rebuilds and clears, own-list
 * rebuilds, startup rollback, and teardown. The MCP SDK is mocked so tool
 * lists and generation changes are driven deterministically. Isolated file so
 * vi.mock of the SDK does not pollute the real-SDK integration suite.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { Fiber } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import type { Config } from '../../src/mcp/types.js'
import WorkspaceMcpManager from '../../src/mcp/manager.js'
import * as workspaceClient from '../../src/mcp/workspace-client.js'
import { harness, makeWorkspace, teardown, type Harness } from '../helpers.js'

// ---- Mock MCP SDK ----

const { mockConnect, mockClose, mockListTools, mockCallTool, mockSetNotificationHandler, mockStdioTransport, MockClient, instances } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockCallTool = vi.fn<() => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  const mockStdioTransport = vi.fn()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
    _schema: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    if (request.method === 'tools/call') return await mockCallTool()
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
  return { mockConnect, mockClose, mockListTools, mockCallTool, mockSetNotificationHandler, mockStdioTransport, MockClient, instances }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: mockStdioTransport,
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}))

// ---- Helpers ----

/** Raw stdio config; the manager validates it against the MCP Config schema. */
function stdioConfig(serverName: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transport: 'stdio',
    serverName,
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...extra,
  }
}

/** One mock tools/list page of simple tools. */
function listing(...names: string[]): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return {
    tools: names.map(name => ({ name, inputSchema: { type: 'object' } })),
    nextCursor: undefined,
  }
}

/** The list_changed notification handler registered by one mock client. */
function notificationHandler(index: number): () => Promise<void> {
  return mockSetNotificationHandler.mock.calls[index]![1] as () => Promise<void>
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

/** Mount one MCP row under a scope (or the host root) as a real plugin fiber. */
function mountRow(scopeCtx: import('@deepseek-ai/cordis').Context, config: Record<string, unknown>): Fiber {
  return scopeCtx.plugin({
    name: 'mcp-row',
    inject: ['tools'],
    apply: (ctx) => ctx.get('workspaceMcp')!.activate(ctx, config),
  })
}

let host: Harness

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
  host = await harness()
  await host.ctx.plugin(SystemPrompt)
  await host.ctx.plugin(ToolRuntime)
  await host.ctx.plugin(WorkspaceMcpManager)
})

afterEach(async () => {
  await teardown(host)
})

describe('module shape', () => {
  it('exports the manager as the default Service class under ctx.workspaceMcp', () => {
    expect(WorkspaceMcpManager.prototype.constructor.name).toBe('WorkspaceMcpManager')
    expect(host.ctx.workspaceMcp).toBeInstanceOf(WorkspaceMcpManager)
    expect((WorkspaceMcpManager as unknown as { inject: string[] }).inject).toEqual(['tools', 'workspaceCordis'])
  })

  it('workspace-client is a namespace plugin (named exports, no default) reusing the Config schema', () => {
    expect(workspaceClient.name).toBe('workspace-mcp')
    expect(workspaceClient.inject).toEqual(['tools', 'workspaceMcp'])
    expect(typeof workspaceClient.apply).toBe('function')
    expect((workspaceClient as { default?: unknown }).default).toBeUndefined()
    // The Config schema is the shared MCP schema with defaults.
    expect(workspaceClient.Config({ transport: 'stdio', serverName: 'srv', command: 'echo' } as never)).toEqual({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    })
  })
})

describe('scope identity and reservations', () => {
  it('a root row is global; its tools land in the global layer', async () => {
    mockListTools.mockResolvedValueOnce(listing('t1', 't2'))
    const fiber = await host.ctx.plugin(workspaceClient, stdioConfig('a') as never)
    await expect(viewNames(host.ctx, undefined)).resolves.toEqual(['mcp__a__t1', 'mcp__a__t2'])
    await fiber.dispose()
    await expect(viewNames(host.ctx, undefined)).resolves.toEqual([])
  })

  it('rejects a duplicate serverName in the global scope and releases it on dispose', async () => {
    const fiber = await host.ctx.plugin(workspaceClient, stdioConfig('a') as never)
    await expect(host.ctx.plugin(workspaceClient, stdioConfig('a') as never))
      .rejects.toThrow(/serverName "a" is already in use/)
    await fiber.dispose()
    const again = await host.ctx.plugin(workspaceClient, stdioConfig('a') as never)
    await again.dispose()
  })

  it('rejects a duplicate serverName within one workspace and allows it across workspaces', async () => {
    const ws1 = await makeWorkspace(host.root, 'ws1')
    const ws2 = await makeWorkspace(host.root, 'ws2')
    const lease1 = await host.registry.acquire(ws1)
    const lease2 = await host.registry.acquire(ws2)
    const row1 = mountRow(lease1.ctx, stdioConfig('a', { failOnStartupError: true }))
    await row1.await()
    // Second row, same workspace scope: rejected.
    const row1b = mountRow(lease1.ctx, stdioConfig('a', { failOnStartupError: true }))
    await expect(row1b.await()).rejects.toThrow(/serverName "a" is already in use.*in this workspace/)
    // Same serverName in a different workspace: allowed.
    const row2 = mountRow(lease2.ctx, stdioConfig('a', { failOnStartupError: true }))
    await row2.await()
    await Promise.all([row1.dispose(), row2.dispose(), lease1.release(), lease2.release()])
  })

  it('rejects a row that activates under a scope that is not a workspace scope', async () => {
    const foreign = createScope(host.ctx, {})
    const fiber = await foreign.ctx.plugin({ name: 'row', inject: ['tools'], apply() {} })
    const row = mountRow(fiber.ctx, stdioConfig('x', { failOnStartupError: true }))
    await expect(row.await()).rejects.toThrow(/not a workspace scope/)
  })
})

describe('workspace row validation', () => {
  it('rejects a workspace row without failOnStartupError: true', async () => {
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const row = mountRow(lease.ctx, stdioConfig('a'))
    await expect(row.await()).rejects.toThrow(/workspace rows must set failOnStartupError: true/)
    await lease.release()
  })

  it('rejects relative cwd and resolves empty / ${workspaceRoot} / absolute to explicit paths', async () => {
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const row = mountRow(lease.ctx, stdioConfig('a', { cwd: 'subdir', failOnStartupError: true }))
    await expect(row.await()).rejects.toThrow(/relative cwd "subdir" is not allowed/)

    const empty = mountRow(lease.ctx, stdioConfig('b', { cwd: '', failOnStartupError: true }))
    await empty.await()
    expect(mockStdioTransport.mock.calls.at(-1)![0].cwd).toBe(lease.canonical)

    const token = mountRow(lease.ctx, stdioConfig('c', { cwd: '${workspaceRoot}', failOnStartupError: true }))
    await token.await()
    expect(mockStdioTransport.mock.calls.at(-1)![0].cwd).toBe(lease.canonical)

    const absolute = mountRow(lease.ctx, stdioConfig('d', { cwd: '/tmp/somewhere', failOnStartupError: true }))
    await absolute.await()
    expect(mockStdioTransport.mock.calls.at(-1)![0].cwd).toBe('/tmp/somewhere')

    await Promise.all([empty.dispose(), token.dispose(), absolute.dispose(), lease.release()])
  })

  it('keeps the official cwd passthrough for global rows', async () => {
    const fiber = await host.ctx.plugin(workspaceClient, stdioConfig('g', { cwd: '/some/global/dir' }) as never)
    expect(mockStdioTransport.mock.calls.at(-1)![0].cwd).toBe('/some/global/dir')
    await fiber.dispose()
  })

  it('rejects an invalid config through the shared schema', async () => {
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const row = mountRow(lease.ctx, { transport: 'stdio', serverName: 'bad name!', command: 'echo' })
    await expect(row.await()).rejects.toThrow()
    await lease.release()
  })
})

describe('namespace masking', () => {
  it('masks the inherited global namespace per server, keeps other namespaces and own tools', async () => {
    // global a: t1..t5, global b: b1, workspace a override: t1..t3.
    mockListTools
      .mockResolvedValueOnce(listing('t1', 't2', 't3', 't4', 't5'))
      .mockResolvedValueOnce(listing('b1'))
      .mockResolvedValueOnce(listing('t1', 't2', 't3'))
    const globalA = await host.ctx.plugin(workspaceClient, stdioConfig('a', { failOnStartupError: true }) as never)
    const globalB = await host.ctx.plugin(workspaceClient, stdioConfig('b', { failOnStartupError: true }) as never)
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const row = mountRow(lease.ctx, stdioConfig('a', { failOnStartupError: true }))
    await row.await()

    // The workspace sees only its own a tools plus the unrelated global b.
    expect(await viewNames(lease.ctx, lease.key)).toEqual(['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3', 'mcp__b__b1'])

    // A descendant agent under the workspace sees the same masked surface.
    const agentKey: ScopeKey = {}
    const agent = createScope(lease.ctx, agentKey, { parent: lease.key })
    expect(await viewNames(agent.ctx, agentKey)).toEqual(['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3', 'mcp__b__b1'])

    // The global view is untouched.
    expect(await viewNames(host.ctx, undefined)).toEqual(['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3', 'mcp__a__t4', 'mcp__a__t5', 'mcp__b__b1'])

    // Disposing the workspace row lifts the mask and unregisters its tools:
    // the inherited global namespace is visible again.
    await row.dispose()
    expect(await viewNames(lease.ctx, lease.key)).toEqual(['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3', 'mcp__a__t4', 'mcp__a__t5', 'mcp__b__b1'])

    await Promise.all([globalA.dispose(), globalB.dispose(), lease.release()])
  })

  it('builds the mask when the global generation activates after the override', async () => {
    mockListTools
      .mockResolvedValueOnce(listing('t1', 't2', 't3'))
      .mockResolvedValueOnce(listing('t1', 't2', 't3', 't4', 't5'))
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const row = mountRow(lease.ctx, stdioConfig('a', { failOnStartupError: true }))
    await row.await()
    // No global generation yet: the override's own tools are the whole view.
    expect(await viewNames(lease.ctx, lease.key)).toEqual(['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3'])

    const globalA = await host.ctx.plugin(workspaceClient, stdioConfig('a', { failOnStartupError: true }) as never)
    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).toEqual(['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3'])
    })
    // Wait for the mask rebuild driven by the global notification, then the
    // global t4/t5 must stay hidden.
    await vi.waitFor(async () => {
      const names = await viewNames(lease.ctx, lease.key)
      expect(names).not.toContain('mcp__a__t4')
    })
    await Promise.all([globalA.dispose(), row.dispose(), lease.release()])
  })

  it('rebuilds the mask when the global generation swaps to a different full set', async () => {
    // global a starts t1..t3; the workspace override owns t1..t3, so no mask.
    mockListTools
      .mockResolvedValueOnce(listing('t1', 't2', 't3'))
      .mockResolvedValueOnce(listing('t1', 't2', 't3'))
    const globalA = await host.ctx.plugin(workspaceClient, stdioConfig('a', { failOnStartupError: true }) as never)
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const row = mountRow(lease.ctx, stdioConfig('a', { failOnStartupError: true }))
    await row.await()
    expect(await viewNames(lease.ctx, lease.key)).toEqual(['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3'])

    // Global list_changed: t1..t3 → t1..t5. The mask must be built for the
    // new generation, hiding the new t4/t5 from the workspace.
    mockListTools.mockResolvedValueOnce(listing('t1', 't2', 't3', 't4', 't5'))
    await notificationHandler(0)()
    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).toEqual(['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3'])
    })
    expect(await viewNames(host.ctx, undefined)).toEqual(['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3', 'mcp__a__t4', 'mcp__a__t5'])

    await Promise.all([globalA.dispose(), row.dispose(), lease.release()])
  })

  it('drops the mask when the global generation goes away', async () => {
    mockListTools
      .mockResolvedValueOnce(listing('t1', 't2', 't3', 't4', 't5'))
      .mockResolvedValueOnce(listing('t1', 't2', 't3'))
    const globalA = await host.ctx.plugin(workspaceClient, stdioConfig('a', { failOnStartupError: true }) as never)
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const row = mountRow(lease.ctx, stdioConfig('a', { failOnStartupError: true }))
    await row.await()
    expect(await viewNames(lease.ctx, lease.key)).toEqual(['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3'])

    // Global row disposed: its generation unregisters, the mask is released.
    await globalA.dispose()
    // A global tool with a formerly-masked name is now inherited again.
    host.ctx.tools.register({
      name: 'mcp__a__t4',
      description: 'Replacement global tool',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => 'foreign',
    })
    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).toContain('mcp__a__t4')
    })

    await Promise.all([row.dispose(), lease.release()])
  })

  it('rebuilds the mask when the workspace own list changes', async () => {
    mockListTools
      .mockResolvedValueOnce(listing('t1', 't2', 't3', 't4', 't5'))
      .mockResolvedValueOnce(listing('t1', 't2', 't3'))
    const globalA = await host.ctx.plugin(workspaceClient, stdioConfig('a', { failOnStartupError: true }) as never)
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const row = mountRow(lease.ctx, stdioConfig('a', { failOnStartupError: true }))
    await row.await()
    const agentKey: ScopeKey = {}
    const agent = createScope(lease.ctx, agentKey, { parent: lease.key })
    expect(await viewNames(agent.ctx, agentKey)).toEqual(['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3'])

    // The workspace's own server grows to t1..t4: the deny set must shrink
    // from [t4, t5] to [t5], or the agent would lose its own t4.
    mockListTools.mockResolvedValueOnce(listing('t1', 't2', 't3', 't4'))
    await notificationHandler(1)()
    await vi.waitFor(async () => {
      expect(await viewNames(agent.ctx, agentKey)).toEqual(['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3', 'mcp__a__t4'])
    })

    await Promise.all([globalA.dispose(), row.dispose(), lease.release()])
  })
})

describe('startup failure and teardown', () => {
  it('rejects the row on a failed startup and unwinds every effect', async () => {
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    mockConnect.mockRejectedValueOnce(new Error('refused'))
    const row = mountRow(lease.ctx, stdioConfig('a', { failOnStartupError: true }))
    await expect(row.await()).rejects.toThrow(/initial connection or tool synchronization failed/)

    // The reservation and override record were released: the same serverName
    // activates again on a fresh row, whose tools are the whole view.
    const fresh = mountRow(lease.ctx, stdioConfig('a', { failOnStartupError: true }))
    await fresh.await()
    expect(await viewNames(lease.ctx, lease.key)).toEqual(['mcp__a__remote'])
    await Promise.all([fresh.dispose(), lease.release()])
  })

  it('disposing the row closes the connection, unregisters tools, lifts the mask, and frees the name', async () => {
    mockListTools
      .mockResolvedValueOnce(listing('t1', 't2', 't3', 't4', 't5'))
      .mockResolvedValueOnce(listing('t1', 't2', 't3'))
    const globalA = await host.ctx.plugin(workspaceClient, stdioConfig('a', { failOnStartupError: true }) as never)
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const row = mountRow(lease.ctx, stdioConfig('a', { failOnStartupError: true }))
    await row.await()
    expect(await viewNames(lease.ctx, lease.key)).toEqual(['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3'])

    const closesBefore = mockClose.mock.calls.length
    await row.dispose()
    await vi.waitFor(() => { expect(mockClose.mock.calls.length).toBe(closesBefore + 1) })
    // Mask lifted, tools unregistered, name free for a fresh row.
    expect(await viewNames(lease.ctx, lease.key)).toEqual(['mcp__a__t1', 'mcp__a__t2', 'mcp__a__t3', 'mcp__a__t4', 'mcp__a__t5'])
    const fresh = mountRow(lease.ctx, stdioConfig('a', { failOnStartupError: true }))
    await fresh.await()
    await Promise.all([globalA.dispose(), fresh.dispose(), lease.release()])
  })

  it('the final lease release tears the workspace row down through the scope', async () => {
    mockListTools
      .mockResolvedValueOnce(listing('t1', 't2'))
      .mockResolvedValueOnce(listing('t1', 't2'))
    const globalA = await host.ctx.plugin(workspaceClient, stdioConfig('a', { failOnStartupError: true }) as never)
    const ws = await makeWorkspace(host.root, 'ws')
    const lease = await host.registry.acquire(ws)
    const row = mountRow(lease.ctx, stdioConfig('a', { failOnStartupError: true }))
    await row.await()
    expect(await viewNames(lease.ctx, lease.key)).toEqual(['mcp__a__t1', 'mcp__a__t2'])

    // No connection attempt is retried: the scope dispose closes the child.
    const closesBefore = mockClose.mock.calls.length
    await lease.release()
    await vi.waitFor(() => { expect(mockClose.mock.calls.length).toBe(closesBefore + 1) })
    expect(await viewNames(host.ctx, undefined)).toEqual(['mcp__a__t1', 'mcp__a__t2'])
    await globalA.dispose()
  })
})
