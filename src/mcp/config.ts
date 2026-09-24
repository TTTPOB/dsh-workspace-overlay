/**
 * Config schema and shared defaults for the ported MCP core, mirroring the
 * rc.6 `@deepseek-ai/dsh-mcp-client` `index.ts` Config section (MIT,
 * Copyright (c) 2026 DeepSeek — see the repository README for attribution)
 * and the installed rc.6 `lib/types/index.d.ts`.
 *
 * @module dsh-workspace-overlay/mcp/config
 */
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { RECONNECT_DEFAULTS } from './connection.js'
import type { ReconnectConfig, ResolvedReconnectPolicy, StdioConfig, StreamableHttpConfig } from './types.js'

export type { ReconnectConfig, ResolvedReconnectPolicy, StdioConfig, StreamableHttpConfig } from './types.js'

/** Configuration for one stdio or Streamable HTTP MCP server. */
export type Config = StdioConfig | StreamableHttpConfig

/** Default timeout for individual MCP tool calls (ms). */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/**
 * Default ceiling on a server's advertised `instructions` text, in bytes.
 * Matches the 0.1.7 `@deepseek-ai/dsh-mcp-client` default.
 */
export const DEFAULT_MAX_INSTRUCTION_BYTES = 32_768

/** Constraint shared by both transports for {@link DEFAULT_MAX_INSTRUCTION_BYTES}. */
const MaxInstructionBytes = z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES)

/** Valid `serverName`, kept below the public tool-name budget. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

const Reconnect: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
})

/** Schemastery schema for one stdio or Streamable HTTP MCP server config. */
export const Config = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: MaxInstructionBytes,
    reconnect: Reconnect,
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: MaxInstructionBytes,
    reconnect: Reconnect,
  }),
]) as unknown as z<Config>
