/**
 * Installer entry for the AgentRegistry workspace-binding integration.
 *
 * NOT wired into any composition yet: enabling it while the official
 * agentPresets provider still binds agents directly would double-bind the
 * agent scope key (the agentPresets decorator lands in the same commit that
 * enables this). Export-only for now, so the next commit can mount it as a
 * plugin row with `inject = ['agents', 'workspaceCordis']`.
 *
 * @module dsh-workspace-overlay/agent-integration
 */
import { type Context } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { installAgentRegistryDecorators } from './agent-registry-decorator.js'
import { AgentBindingCoordinator } from './coordinator.js'
import type WorkspaceRegistry from './registry.js'

/** The installed integration: the shared coordinator plus its reverser. */
export interface AgentIntegrationHandle {
  /** The coordinator shared by all agent bindings in this fiber. */
  readonly coordinator: AgentBindingCoordinator
  /** Revert create/resume to their pre-install descriptors. */
  dispose(): void
}

/**
 * Install the AgentRegistry create/resume decorators on `ctx.agents`,
 * backed by `ctx.workspaceCordis`. Requires both services to be available.
 */
export function installAgentIntegration(ctx: Context): AgentIntegrationHandle {
  const agents = ctx.get('agents') as AgentRegistry | undefined
  if (!agents) {
    throw new Error('agent-integration: ctx.agents is not available')
  }
  const workspaceCordis = ctx.get('workspaceCordis') as WorkspaceRegistry | undefined
  if (!workspaceCordis) {
    throw new Error('agent-integration: ctx.workspaceCordis is not available')
  }
  const coordinator = new AgentBindingCoordinator()
  const decorator = installAgentRegistryDecorators(agents, coordinator, workspaceCordis)
  return {
    coordinator,
    dispose: () => decorator.dispose(),
  }
}
