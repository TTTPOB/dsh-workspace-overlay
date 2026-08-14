/**
 * Public type surface of the ported MCP core.
 *
 * This module is a self-contained port of the rc.6
 * `@deepseek-ai/dsh-mcp-client` public contract (MIT, Copyright (c) 2026
 * DeepSeek — see the repository README for attribution). The installed rc.6
 * package does not export its implementation (`lib` ships only the plugin
 * entry), so the necessary logic is copied here rather than imported from a
 * private subpath; the types below mirror the installed rc.6
 * `lib/types/*.d.ts` so behavior stays aligned with the target DSH version.
 *
 * @module dsh-workspace-overlay/mcp/types
 */
import type { JsonValue } from '@deepseek-ai/dsh-tools'

/** Config for connecting to an MCP server via a spawned child process over stdio. */
export interface StdioConfig {
  /** Selects child-process stdio transport. */
  transport: 'stdio'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args: string[]
  /** Extra env vars merged on top of scrubbed ambient env. */
  env: Record<string, string>
  /** Working directory for the child process. */
  cwd: string
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Config for connecting to an MCP server over Streamable HTTP (SSE). */
export interface StreamableHttpConfig {
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers: Record<string, string>
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Configuration for one stdio or Streamable HTTP MCP server. */
export type Config = StdioConfig | StreamableHttpConfig

/** Automatic reconnect policy for one MCP server connection. */
export interface ReconnectConfig {
  /** Reconnect automatically after a lost connection (default true). */
  enabled?: boolean
  /** First reconnect delay in milliseconds; doubles per consecutive failed attempt (default 500). */
  initialDelayMs?: number
  /** Backoff ceiling in milliseconds; also the uptime after which the attempt budget resets (default 30000). */
  maxDelayMs?: number
  /** Consecutive failed attempts per outage before giving up for good (default 10). */
  maxAttempts?: number
}

/** Fully resolved reconnect policy captured at plugin load. */
export type ResolvedReconnectPolicy = Readonly<Required<ReconnectConfig>>

/** Result from the initial connection attempt, for startup-await semantics. */
export interface ConnectionOutcome {
  /** If the initial connection or tool sync failed, the error; otherwise absent. */
  error?: unknown
}

/** Handle for one plugin instance's supervised connection. */
export interface ConnectionHandle {
  /**
   * Settles when the first connection attempt completes (success or failure).
   * The supervisor enters its reconnect loop regardless; the caller decides
   * whether a failed startup is fatal via `failOnStartupError`.
   */
  ready: Promise<ConnectionOutcome>
  /**
   * Stop reconnection, close the live client, wait for the in-flight attempt
   * and queued tool syncs to quiesce, then unregister every tool this server
   * still owns.
   */
  dispose(): Promise<void>
}

/** Resolved options relevant to tool bridging. */
export interface ToolBridgeOptions {
  /** Whether a registry conflict is contained or rejects this synchronization. */
  registrationFailure: 'contain' | 'throw'
  serverName: string
  toolCallTimeoutMs: number
  /**
   * Generation-change notification reserved for the future workspace
   * manager's tool tracking. Emitted synchronously after each committed
   * generation change: a successful swap reports the registered public
   * names; an all-or-nothing rollback, the give-up disposal, and the final
   * plugin disposal report zero names. No mask/restriction is implemented
   * here — this hook only observes.
   */
  onGeneration?: (change: GenerationNotification) => void
}

/** State for one sync generation: the current set of disposers keyed by public name. */
export type ToolDisposers = Map<string, () => void>

/** Canonical MCP result exposed to Code Mode without discarding protocol blocks. */
export type McpResult<Structured extends JsonValue = JsonValue> = {
  content: JsonValue[]
  structuredContent?: Structured
}

/**
 * One committed tool-generation change. `names` lists the public tool names
 * this server owns right after the change; `'registered'` follows a
 * successful swap (possibly empty when the server lists no tools), and
 * `'unregistered'` follows a rollback, the reconnect give-up, or disposal.
 */
export interface GenerationNotification {
  serverName: string
  /** Public tool names registered after a successful swap; empty when unregistered. */
  names: string[]
  /** 'registered' after a committed swap; 'unregistered' when this server owns no live registrations. */
  status: 'registered' | 'unregistered'
}
