/**
 * Workspace-aware MCP plugin entry: the row form of the MCP client bridge for
 * the workspace overlay.
 *
 * One row connects one MCP server through the workspace-aware manager
 * (`ctx.workspaceMcp`), which decides global vs workspace semantics from the
 * row's scope: a row in the host composition is a global server (one process
 * per `serverName`), a row in a workspace `<workspace>/.dsh/cordis.yml` is
 * that workspace's override (one process per workspace, masking the inherited
 * global namespace). The same entry serves both, reusing the current MCP
 * Config schema and the supervisor's `startConnection`.
 *
 * Namespace plugin (named exports, no default export). The row's context is
 * the effect owner: disposal — composition unload, workspace scope teardown,
 * HMR — disconnects the server, unregisters its tools, removes the
 * override/mask, and releases the `serverName` reservation.
 *
 * @module dsh-workspace-overlay/mcp/workspace-client
 */
import type { Context } from '@deepseek-ai/cordis'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'
import { Config } from './config.js'
import type { Config as McpConfig } from './config.js'

export { Config } from './config.js'
export type { StdioConfig, StreamableHttpConfig } from './config.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'workspace-mcp'

/** Services required by this plugin: the tool registry and the manager. */
export const inject = ['tools', 'workspaceMcp']

/**
 * Activate one MCP row through the workspace-aware manager. The manager
 * validates the config, reserves the `serverName` namespace in the row's
 * scope, starts the supervised connection (registering tools into the row's
 * layer), builds the workspace mask over the live global generation, and
 * registers every teardown effect on this row context. Workspace rows must
 * set `failOnStartupError: true` so a failed startup rejects the workspace
 * composition before any agent is published; the manager enforces that.
 * @param ctx - the row context; its scope decides global vs workspace.
 * @param config - resolved transport and server namespace configuration.
 * @returns startup readiness after connection and tool discovery settle.
 */
export async function apply(ctx: Context, config: McpConfig): Promise<void> {
  await ctx.workspaceMcp.activate(ctx, config)
}
