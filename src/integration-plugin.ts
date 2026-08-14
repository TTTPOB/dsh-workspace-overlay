/**
 * Cordis function plugin wiring the workspace-agent integration into a
 * composition.
 *
 * Declares `agents`, `agentPresets` and `workspaceCordis` as required
 * services, so the row activates only once the official agent registry, the
 * official preset roster, and this bundle's workspace registry all exist —
 * and never re-creates a workspace registry of its own: the `workspaceCordis`
 * provider row owns the scopes and the trust switch. `apply` installs the
 * AgentRegistry + agentPresets decorators inside an effect and restores all
 * five method descriptors on fiber dispose.
 *
 * Decorators are startup-structure wiring: developing them requires disposing
 * live agents or restarting the host, and profile must not contain sync
 * `AgentLoop.create()` / direct-factory agent entries, which bypass the
 * awaited workspace setup.
 *
 * @module dsh-workspace-overlay/integration-plugin
 */
import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installAgentIntegration } from './agent-integration.js'

export const name = 'workspace-agent-integration'

/** Activate once the agent registry, preset roster, and workspace registry exist. */
export const inject = ['agents', 'agentPresets', 'workspaceCordis']

/** No integration-local settings; workspace trust belongs to the provider row. */
export interface Config {}

export const Config = z.object({}) as z<Config>

export function apply(ctx: Context, _config: Config): void {
  ctx.effect(() => {
    const integration = installAgentIntegration(ctx)
    return () => integration.dispose()
  })
}
