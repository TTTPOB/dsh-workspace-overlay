/**
 * Tool bridge tests: public naming (against known-answer values derived from
 * the installed rc.6 bundle), transactional generation swaps, pagination,
 * official input-schema pass-through, callTool timeout/cancellation, and the
 * McpResult mapping — all against a mock MCP client.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallId } from '@deepseek-ai/dsh-llm'
import { KNOWN_FIXTURE_HASH_NAME, KNOWN_LONG_NAME, KNOWN_SRV_HASH_NAME, mountRegistry, nextCallId, sleep, testToolSignal } from './helpers.js'
import { publicToolName, syncTools } from '../../src/mcp/tools.js'
import type { GenerationNotification, ToolBridgeOptions } from '../../src/mcp/types.js'

interface MockTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  execution?: { taskSupport?: 'optional' | 'required' | 'forbidden' }
}

interface MockCallResult {
  content: unknown[]
  structuredContent?: unknown
  isError?: boolean
}

function createMockClient(tools: MockTool[], callResult: MockCallResult = { content: [{ type: 'text', text: 'ok' }] }) {
  const listTools = vi.fn(async (
    _params?: Record<string, unknown>,
  ): Promise<{ tools: MockTool[]; nextCursor: string | undefined }> => ({ tools, nextCursor: undefined }))
  const callTool = vi.fn(async (
    _params?: Record<string, unknown>,
    _compatibilitySchema?: unknown,
    _options?: unknown,
  ): Promise<Record<string, unknown>> => ({ ...callResult }))
  return {
    listTools,
    callTool,
    request: vi.fn(async (
      request: { method: string; params?: Record<string, unknown> },
      _schema: unknown,
      options?: unknown,
    ): Promise<unknown> => {
      if (request.method === 'tools/list') return listTools(request.params)
      if (request.method === 'tools/call') return callTool(request.params, undefined, options)
      throw new Error(`unexpected MCP request: ${request.method}`)
    }),
    setNotificationHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

const defaultOpts: ToolBridgeOptions = {
  registrationFailure: 'contain',
  serverName: 'srv',
  toolCallTimeoutMs: 60_000,
}

describe('publicToolName', () => {
  it('joins clean names verbatim', () => {
    expect(publicToolName('github', 'create_issue')).toBe('mcp__github__create_issue')
    expect(publicToolName('everything', 'get-sum')).toBe('mcp__everything__get-sum')
  })

  it('matches the installed rc.6 known-answer values for lossy normalization', () => {
    expect(publicToolName('srv', 'admin.reset')).toBe(KNOWN_SRV_HASH_NAME)
    expect(publicToolName('fixture', 'admin.reset')).toBe(KNOWN_FIXTURE_HASH_NAME)
  })

  it('truncates over-long names with a known-answer hash and a 64-char budget', () => {
    const name = publicToolName('srv', 'a'.repeat(80))
    expect(name).toBe(KNOWN_LONG_NAME)
    expect(name).toHaveLength(64)
  })

  it('is deterministic and collision-free for distinct identities', () => {
    const a = publicToolName('srv', 'admin.reset')
    const b = publicToolName('srv', 'admin_reset')
    expect(a).toBe(publicToolName('srv', 'admin.reset'))
    expect(a).not.toBe(b)
  })
})

describe('syncTools', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await mountRegistry()
  })

  it('registers tools under server-qualified public names and reports the generation', async () => {
    const notifications: GenerationNotification[] = []
    const client = createMockClient([
      { name: 'greet', description: 'Say hello', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
      { name: 'add', description: 'Add numbers', inputSchema: { type: 'object', properties: {} } },
    ])

    const disposers = await syncTools(
      client as unknown as Client,
      ctx,
      { ...defaultOpts, onGeneration: change => notifications.push(change) },
      new Map(),
    )

    expect(disposers.size).toBe(2)
    expect(ctx.tools.get('mcp__srv__greet')).toBeDefined()
    expect(ctx.tools.get('mcp__srv__add')).toBeDefined()
    // Raw names are NOT registered.
    expect(ctx.tools.get('greet')).toBeUndefined()
    expect(ctx.tools.get('add')).toBeUndefined()
    expect(notifications).toEqual([
      { serverName: 'srv', names: ['mcp__srv__greet', 'mcp__srv__add'], status: 'registered' },
    ])
  })

  it('lets two servers publish the same raw name side by side', async () => {
    const clientA = createMockClient([{ name: 'search', inputSchema: { type: 'object' } }])
    const clientB = createMockClient([{ name: 'search', inputSchema: { type: 'object' } }])

    await syncTools(clientA as unknown as Client, ctx, { ...defaultOpts, serverName: 'github' }, new Map())
    await syncTools(clientB as unknown as Client, ctx, { ...defaultOpts, serverName: 'web' }, new Map())

    expect(ctx.tools.get('mcp__github__search')).toBeDefined()
    expect(ctx.tools.get('mcp__web__search')).toBeDefined()
  })

  it('rejects a tool list where one raw name appears twice', async () => {
    const client = createMockClient([
      { name: 'dup', inputSchema: { type: 'object' } },
      { name: 'dup', inputSchema: { type: 'object' } },
    ])

    await expect(syncTools(client as unknown as Client, ctx, defaultOpts, new Map()))
      .rejects.toThrow(/listed tool "dup" more than once/)
    expect(ctx.tools.get('mcp__srv__dup')).toBeUndefined()
  })

  it('passes full MCP input schemas through like the official bridge', async () => {
    const paperSearchSchema = {
      type: 'object',
      properties: {
        query: { type: 'string' },
        year: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
          default: null,
        },
      },
      required: ['query'],
    }
    const bioMcpSchema = {
      type: 'object',
      properties: {
        sections: { type: 'array', items: { $ref: '#/$defs/Section' } },
      },
      $defs: { Section: { type: 'string', enum: ['all', 'genes'] } },
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    }
    const client = createMockClient([
      { name: 'paper_search', inputSchema: paperSearchSchema },
      { name: 'biomcp_get', inputSchema: bioMcpSchema },
    ])

    const disposers = await syncTools(client as unknown as Client, ctx, defaultOpts, new Map())

    expect(disposers.size).toBe(2)
    expect(ctx.tools.get('mcp__srv__paper_search')?.parameters).toBe(paperSearchSchema)
    expect(ctx.tools.get('mcp__srv__biomcp_get')?.parameters).toBe(bioMcpSchema)
  })

  it('keeps the previous generation when the fetch phase fails', async () => {
    const client = createMockClient([{ name: 'stable', inputSchema: { type: 'object' } }])
    const first = await syncTools(client as unknown as Client, ctx, defaultOpts, new Map())
    expect(ctx.tools.get('mcp__srv__stable')).toBeDefined()

    client.listTools.mockRejectedValue(new Error('network down'))
    await expect(syncTools(client as unknown as Client, ctx, defaultOpts, first)).rejects.toThrow('network down')
    expect(ctx.tools.get('mcp__srv__stable')).toBeDefined()
  })

  it('rolls back the whole generation when a foreign tool squats on the namespace', async () => {
    ctx.tools.register({
      name: 'mcp__srv__taken',
      description: 'Squatter',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => 'squatter',
    })
    const notifications: GenerationNotification[] = []
    const client = createMockClient([
      { name: 'free', inputSchema: { type: 'object' } },
      { name: 'taken', inputSchema: { type: 'object' } },
    ])

    const disposers = await syncTools(
      client as unknown as Client,
      ctx,
      { ...defaultOpts, onGeneration: change => notifications.push(change) },
      new Map(),
    )

    expect(disposers.size).toBe(0)
    expect(ctx.tools.get('mcp__srv__free')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__taken')).toBeDefined()
    expect(notifications).toEqual([{ serverName: 'srv', names: [], status: 'unregistered' }])
  })

  it('propagates a strict registration conflict to the caller', async () => {
    ctx.tools.register({
      name: 'mcp__srv__taken',
      description: 'Squatter',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => 'squatter',
    })
    const client = createMockClient([{ name: 'taken', inputSchema: { type: 'object' } }])

    await expect(syncTools(
      client as unknown as Client,
      ctx,
      { ...defaultOpts, registrationFailure: 'throw' },
      new Map(),
    )).rejects.toThrow()
    // The squatter is untouched; the partial generation was rolled back.
    expect(ctx.tools.get('mcp__srv__taken')?.description).toBe('Squatter')
  })

  it('unregisters previous tools before re-syncing and notifies each generation', async () => {
    const notifications: GenerationNotification[] = []
    const client = createMockClient([{ name: 'old_tool', inputSchema: { type: 'object' } }])
    const opts = { ...defaultOpts, onGeneration: (change: GenerationNotification) => notifications.push(change) }

    const firstDisposers = await syncTools(client as unknown as Client, ctx, opts, new Map())
    expect(ctx.tools.get('mcp__srv__old_tool')).toBeDefined()

    client.listTools.mockResolvedValue({ tools: [{ name: 'new_tool', inputSchema: { type: 'object' } }], nextCursor: undefined })
    const secondDisposers = await syncTools(client as unknown as Client, ctx, opts, firstDisposers)

    expect(ctx.tools.get('mcp__srv__old_tool')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__new_tool')).toBeDefined()
    expect(secondDisposers.size).toBe(1)
    expect(notifications.map(n => n.status)).toEqual(['registered', 'registered'])
    expect(notifications[1]!.names).toEqual(['mcp__srv__new_tool'])
  })

  it('drains paginated listTools responses', async () => {
    const client = createMockClient([])
    client.listTools
      .mockResolvedValueOnce({ tools: [{ name: 'page1', inputSchema: { type: 'object' } }], nextCursor: 'cursor1' })
      .mockResolvedValueOnce({ tools: [{ name: 'page2', inputSchema: { type: 'object' } }], nextCursor: undefined })

    const disposers = await syncTools(client as unknown as Client, ctx, defaultOpts, new Map())

    expect(disposers.size).toBe(2)
    expect(ctx.tools.get('mcp__srv__page1')).toBeDefined()
    expect(ctx.tools.get('mcp__srv__page2')).toBeDefined()
  })
})

describe('tool execution', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await mountRegistry()
  })

  it('calls callTool with the RAW name, timeout, and abort signal; maps McpResult', async () => {
    const controller = new AbortController()
    const client = createMockClient(
      [{ name: 'echo', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'hello world' }] },
    )

    await syncTools(client as unknown as Client, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({
      signal: controller.signal,
      callId: nextCallId(), name: 'mcp__srv__echo', arguments: { msg: 'hi' },
    })

    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'hello world' }])
    if (result.isError) throw new Error('expected MCP success')
    expect(result.value).toEqual({ content: [{ type: 'text', text: 'hello world' }] })
    // The wire sees the raw MCP name, never the public name, plus timeout and signal.
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'echo', arguments: { msg: 'hi' } },
      undefined,
      expect.objectContaining({ timeout: 60_000, signal: controller.signal }),
    )
  })

  it('sends the raw name for normalized public names', async () => {
    const client = createMockClient(
      [{ name: 'admin.reset', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'reset done' }] },
    )

    await syncTools(client as unknown as Client, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: publicToolName('srv', 'admin.reset'), arguments: {},
    })

    expect(result.isError).toBe(false)
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'admin.reset', arguments: {} },
      undefined,
      expect.anything(),
    )
  })

  it('joins multiple text blocks with newline and preserves image placeholders in rendering', async () => {
    const client = createMockClient(
      [{ name: 'multi', inputSchema: { type: 'object' } }],
      { content: [
        { type: 'text', text: 'before' },
        { type: 'image', mimeType: 'image/png', data: 'base64-data' },
        { type: 'text', text: 'after' },
      ] },
    )

    await syncTools(client as unknown as Client, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: nextCallId(), name: 'mcp__srv__multi', arguments: {} })

    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'before\n[image: image/png, content discarded]\nafter',
    })
    if (result.isError) throw new Error('expected MCP success')
    expect(result.value).toEqual({
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', mimeType: 'image/png', data: 'base64-data' },
        { type: 'text', text: 'after' },
      ],
    })
  })

  it('maps isError to an error result via throw', async () => {
    const client = createMockClient(
      [{ name: 'fail', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'something went wrong' }], isError: true },
    )

    await syncTools(client as unknown as Client, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: nextCallId(), name: 'mcp__srv__fail', arguments: {} })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Error: something went wrong' })
    expect('value' in result).toBe(false)
  })

  it('preserves structuredContent under a supported output schema', async () => {
    const outputSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { answer: { type: 'integer' } },
      required: ['answer'],
    }
    const client = createMockClient(
      [{ name: 'structured', inputSchema: { type: 'object' }, outputSchema }],
      { content: [{ type: 'text', text: '42' }], structuredContent: { answer: 42 } },
    )

    await syncTools(client as unknown as Client, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__srv__structured', arguments: {},
    })

    if (result.isError) throw new Error('expected supported structuredContent to validate')
    expect(result.value).toEqual({ content: [{ type: 'text', text: '42' }], structuredContent: { answer: 42 } })
  })

  it('falls back to JsonValue for unsupported advertised output schemas', async () => {
    const client = createMockClient(
      [{ name: 'future-schema', inputSchema: { type: 'object' }, outputSchema: { type: 'object', patternProperties: { '^x-': { type: 'string' } } } }],
      { content: [], structuredContent: ['kept', { nested: true }] },
    )

    await syncTools(client as unknown as Client, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__srv__future-schema', arguments: {},
    })

    if (result.isError) throw new Error('unsupported MCP output schemas must fall back')
    expect(result.value).toEqual({ content: [], structuredContent: ['kept', { nested: true }] })
  })

  it('handles the legacy toolResult shape', async () => {
    const client = createMockClient([{ name: 'legacy', inputSchema: { type: 'object' } }])
    client.callTool.mockResolvedValue({ toolResult: { key: 'value' } })

    await syncTools(client as unknown as Client, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: nextCallId(), name: 'mcp__srv__legacy', arguments: {} })

    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: '{"key":"value"}' })
  })

  it('rejects tools that require task-based execution without a wire call', async () => {
    const client = createMockClient([
      { name: 'task-only', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } },
    ])

    await syncTools(client as unknown as Client, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__srv__task-only', arguments: {},
    })

    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('requires task-based execution')
    expect(client.callTool).not.toHaveBeenCalled()
  })

  it('coerces non-object args to an empty object for callTool', async () => {
    const client = createMockClient(
      [{ name: 'coerce', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'ok' }] },
    )

    await syncTools(client as unknown as Client, ctx, defaultOpts, new Map())
    await ctx.tools.execute({ signal: testToolSignal, callId: nextCallId(), name: 'mcp__srv__coerce', arguments: null })

    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'coerce', arguments: {} },
      undefined,
      expect.anything(),
    )
  })

  it('surfaces a timed-out call as an error result', async () => {
    const client = createMockClient([{ name: 'slow', inputSchema: { type: 'object' } }])
    client.callTool.mockImplementation((async (_params: unknown, _schema: unknown, options?: { signal?: AbortSignal; timeout?: number }) => {
      // Model the SDK request timeout: reject when the deadline elapses.
      await new Promise<void>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('RequestTimeout: Request timed out')), options?.timeout ?? 100)
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('AbortError: This operation was aborted'))
        })
      })
    }) as never)

    await syncTools(client as unknown as Client, ctx, { ...defaultOpts, toolCallTimeoutMs: 30 }, new Map())
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: nextCallId(), name: 'mcp__srv__slow', arguments: {} })

    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('RequestTimeout')
  })

  it('surfaces caller cancellation as an error result', async () => {
    const client = createMockClient([{ name: 'hang', inputSchema: { type: 'object' } }])
    client.callTool.mockImplementation((async (_params: unknown, _schema: unknown, options?: { signal?: AbortSignal; timeout?: number }) => {
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new Error('AbortError: This operation was aborted'))
        })
        void _resolve
      })
    }) as never)

    await syncTools(client as unknown as Client, ctx, defaultOpts, new Map())
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      signal: controller.signal,
      callId: CallId('cancel-me'), name: 'mcp__srv__hang', arguments: {},
    })
    await sleep(10)
    controller.abort()
    const result = await pending

    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('AbortError')
  })
})
