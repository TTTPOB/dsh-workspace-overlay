/**
 * Installer entry for the workspace-agent integration.
 *
 * Installs the AgentRegistry `create`/`resume` decorators AND the agentPresets
 * `mount`/`composeFrom`/`recompose` decorators, sharing one binding
 * coordinator and one workspace-local preset registry between them. Requires
 * `ctx.agents`, `ctx.agentPresets` and `ctx.workspaceCordis` to be available;
 * disposal restores all five method descriptors in reverse install order.
 *
 * This is the library entry the Cordis function plugin (`./integration-plugin`)
 * mounts; it is exported separately so tests can drive the install without a
 * plugin row.
 *
 * @module dsh-workspace-overlay/agent-integration
 */
import { type Context } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { installAgentRegistryDecorators } from './agent-registry-decorator.js'
import { installAgentPresetsDecorators } from './agent-presets-decorator.js'
import { AgentBindingCoordinator } from './coordinator.js'
import type WorkspaceRegistry from './registry.js'
import { WorkspacePresetRegistry } from './workspace-presets.js'

/** The installed integration: the shared state plus its reverser. */
export interface AgentIntegrationHandle {
  /** The coordinator shared by all agent bindings in this fiber. */
  readonly coordinator: AgentBindingCoordinator
  /** The workspace-local preset registry shared by all agents in this fiber. */
  readonly presets: WorkspacePresetRegistry
  /**
   * Revert create/resume/mount/composeFrom/recompose to their pre-install
   * descriptors, in reverse install order.
   */
  dispose(): void
}

/**
 * Install the AgentRegistry and agentPresets decorators on their provider
 * targets, backed by `ctx.workspaceCordis`. Requires all three services.
 */
export function installAgentIntegration(ctx: Context): AgentIntegrationHandle {
  const agents = ctx.get('agents') as AgentRegistry | undefined
  if (!agents) {
    throw new Error('agent-integration: ctx.agents is not available')
  }
  const agentPresets = ctx.get('agentPresets') as AgentPresets | undefined
  if (!agentPresets) {
    throw new Error('agent-integration: ctx.agentPresets is not available')
  }
  const workspaceCordis = ctx.get('workspaceCordis') as WorkspaceRegistry | undefined
  if (!workspaceCordis) {
    throw new Error('agent-integration: ctx.workspaceCordis is not available')
  }
  const coordinator = new AgentBindingCoordinator()
  const presets = new WorkspacePresetRegistry()
  const agentDecorator = installAgentRegistryDecorators(agents, coordinator, workspaceCordis)
  const presetDecorator = installAgentPresetsDecorators(agentPresets, coordinator, presets)
  return {
    coordinator,
    presets,
    dispose() {
      // Reverse order: the preset decorator's wrappers may still be reached
      // by a caller while the registry decorator unwinds, so it goes first.
      presetDecorator.dispose()
      agentDecorator.dispose()
    },
  }
}
