/** Awaited Agent workspace placement contribution. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installAgentIntegration } from './agent-integration.js'

export const name = 'workspace-agent-integration'
export const inject = ['agents', 'agentPresets', 'workspaceCordis']
export interface Config {}
export const Config = z.object({}) as z<Config>

export function apply(ctx: Context, _config: Config): void {
  ctx.effect(() => installAgentIntegration(ctx))
}
