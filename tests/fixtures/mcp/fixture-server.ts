/**
 * Minimal MCP server over stdio for testing the overlay's ported MCP core.
 *
 * Adapted from the official rc.6 `dsh-mcp-client` fixture server (MIT,
 * Copyright (c) 2026 DeepSeek — see the repository README for attribution),
 * extended with env-driven modes so one spawn can exercise startup failure,
 * duplicate/bad-schema tool lists, pagination, list-changed resync, env
 * scrubbing, cwd, timeouts, and crash recovery.
 *
 * Run: node fixture-server.ts
 *
 * Environment:
 * - MCP_FIXTURE_MODE: 'normal' | 'exit-on-start' | 'dup-list' |
 *   'bad-schema-list' | 'paginate' | 'masked' | 'masked-partial' (default 'normal')
 * - MCP_FIXTURE_PAGE_SIZE: page size for 'paginate' (default 3)
 * - MCP_FIXTURE_MASKED_COUNT: tool count for 'masked' (default 5)
 * - MCP_FIXTURE_FAIL_LIST_AFTER: fail `tools/list` after N successful replies
 *   (injected list failure for the keep-previous-generation path)
 * - MCP_FIXTURE_MARKER: append `start <pid>` on boot and `exit <pid>` on exit
 */

import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ErrorCode, InitializeRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'

/** One controllable tool: schema plus the handler that produces its result. */
interface FixtureTool {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const marker = process.env.MCP_FIXTURE_MARKER
function mark(line: string): void {
  if (!marker) return
  try {
    mkdirSync(dirname(marker), { recursive: true })
    appendFileSync(marker, line)
  } catch {
    // Marker failures must never take the server down.
  }
}
mark(`start ${process.pid}\n`)
process.on('exit', () => mark(`exit ${process.pid}\n`))

const mode = process.env.MCP_FIXTURE_MODE ?? 'normal'
if (mode === 'exit-on-start') {
  process.exit(3)
}

/** The tool registry; register_extra mutates it and announces list_changed. */
const tools = new Map<string, FixtureTool>()

function register(tool: FixtureTool): void {
  tools.set(tool.name, tool)
}

register({
  name: 'add',
  title: 'Add Tool',
  description: 'Adds two numbers.',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  handler: async args => ({ content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] }),
})

register({
  name: 'greet',
  title: 'Greet Tool',
  description: 'Greets a person by name.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  handler: async args => ({ content: [{ type: 'text', text: `Hello, ${String(args.name)}!` }] }),
})

register({
  name: 'fail',
  title: 'Fail Tool',
  description: 'Always returns an error.',
  inputSchema: { type: 'object' },
  handler: async () => ({ content: [{ type: 'text', text: 'Something went wrong' }], isError: true }),
})

register({
  name: 'image',
  title: 'Image Tool',
  description: 'Returns an image content block.',
  inputSchema: { type: 'object' },
  handler: async () => ({
    content: [
      { type: 'text', text: 'Here is an image:' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { type: 'text', text: 'End of image.' },
    ],
  }),
})

register({
  name: 'crash',
  title: 'Crash Tool',
  description: 'Replies, then exits the server process (crash-recovery test).',
  inputSchema: { type: 'object' },
  handler: async () => {
    // Exit AFTER the response flushes so the caller observes a clean result
    // followed by a transport close, like a real post-reply crash.
    setTimeout(() => process.exit(7), 25)
    return { content: [{ type: 'text', text: 'crashing' }] }
  },
})

// Dotted name: legal in MCP, illegal in the DeepSeek function-name contract.
// Exercises the bridge's normalize-and-hash public-name path end to end.
register({
  name: 'admin.reset',
  title: 'Admin Reset Tool',
  description: 'Tool with a dotted name (normalization test).',
  inputSchema: { type: 'object' },
  handler: async () => ({ content: [{ type: 'text', text: 'reset done' }] }),
})

/** Reports selected environment entries: `[[name, value | null], ...]`. */
register({
  name: 'env_echo',
  title: 'Env Echo Tool',
  description: 'Reports the values of the named environment variables.',
  inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } } },
  handler: async args => {
    const names = Array.isArray(args.names) ? args.names.map(String) : []
    const entries = names.map(name => [name, process.env[name] ?? null])
    return { content: [{ type: 'text', text: JSON.stringify(entries) }] }
  },
})

/** Reports the child process working directory. */
register({
  name: 'cwd_echo',
  title: 'Cwd Echo Tool',
  description: 'Reports the child process working directory.',
  inputSchema: { type: 'object' },
  handler: async () => ({ content: [{ type: 'text', text: process.cwd() }] }),
})

/** Sleeps `ms` milliseconds, then answers (timeout/cancellation test). */
register({
  name: 'slow',
  title: 'Slow Tool',
  description: 'Sleeps for the given number of milliseconds.',
  inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
  handler: async args => {
    await sleep(Number(args.ms))
    return { content: [{ type: 'text', text: 'slow done' }] }
  },
})

/** Registers a new tool and announces notifications/tools/list_changed. */
register({
  name: 'register_extra',
  title: 'Register Extra Tool',
  description: 'Registers a new tool and announces a tool-list change.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  handler: async args => {
    const name = String(args.name)
    register({
      name,
      title: name,
      description: `Dynamically registered tool "${name}".`,
      inputSchema: { type: 'object' },
      handler: async () => ({ content: [{ type: 'text', text: 'extra' }] }),
    })
    await server.notification({ method: 'notifications/tools/list_changed' })
    return { content: [{ type: 'text', text: `registered ${name}` }] }
  },
})

const server = new Server(
  { name: 'fixture-server', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)

server.setRequestHandler(InitializeRequestSchema, async request => ({
  protocolVersion: request.params.protocolVersion,
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: 'fixture-server', version: '1.0.0' },
}))

/** Successful tools/list replies so far; used by MCP_FIXTURE_FAIL_LIST_AFTER. */
let listReplies = 0
const failListAfter = Number(process.env.MCP_FIXTURE_FAIL_LIST_AFTER ?? '0')

server.setRequestHandler(ListToolsRequestSchema, async request => {
  listReplies += 1
  if (failListAfter > 0 && listReplies > failListAfter) {
    throw new McpError(ErrorCode.InternalError, 'injected list failure')
  }
  const all = [...tools.values()].map(tool => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema },
  }))
  switch (mode) {
    case 'dup-list':
      return { tools: [all[0]!, { ...all[0]!, name: all[0]!.name }] }
    case 'bad-schema-list':
      return {
        tools: [
          ...all.filter(tool => tool.name === 'add'),
          {
            name: 'exotic',
            description: 'Tool whose input schema uses an unsupported vocabulary.',
            inputSchema: { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
          },
        ],
      }
    case 'paginate': {
      const pageSize = Math.max(1, Number(process.env.MCP_FIXTURE_PAGE_SIZE ?? '3'))
      const cursor = request.params?.cursor
      const start = cursor === undefined ? 0 : Number(cursor)
      const page = all.slice(start, start + pageSize)
      const next = start + pageSize < all.length ? String(start + pageSize) : undefined
      return { tools: page, nextCursor: next }
    }
    case 'masked': {
      // Namespace-mask tests: a server exposing only t1..tN.
      const count = Math.max(1, Number(process.env.MCP_FIXTURE_MASKED_COUNT ?? '5'))
      return {
        tools: Array.from({ length: count }, (_, i) => ({
          name: `t${i + 1}`,
          description: `Masked tool ${i + 1}.`,
          inputSchema: { type: 'object' },
        })),
      }
    }
    case 'masked-partial': {
      // The override side of the namespace-mask tests: t1..tN (default 3),
      // a subset of the global 'masked' list.
      const count = Math.max(1, Number(process.env.MCP_FIXTURE_MASKED_COUNT ?? '3'))
      return {
        tools: Array.from({ length: count }, (_, i) => ({
          name: `t${i + 1}`,
          description: `Override tool ${i + 1}.`,
          inputSchema: { type: 'object' },
        })),
      }
    }
    default:
      return { tools: all }
  }
})

server.setRequestHandler(CallToolRequestSchema, async request => {
  const tool = tools.get(request.params.name)
  if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`)
  const args = request.params.arguments ?? {}
  return tool.handler(args)
})

const transport = new StdioServerTransport()
await server.connect(transport)
