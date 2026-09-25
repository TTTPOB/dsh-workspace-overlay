import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry, {
  type Agent,
  type AgentFactory,
  type AgentHandle,
  type AgentSetup,
  type CreateAgentOptions,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import { installAgentIntegration } from '../src/agent-integration.js'
import { harness, makeWorkspace, teardown, type Harness } from './helpers.js'

interface PreparedAgent extends Agent {
  session: Agent['session']
}

function factory(cwd: string): AgentFactory {
  async function prepare(owner: Context, setup: AgentSetup | undefined): Promise<AgentHandle> {
    const agent = { session: { header: { cwd } } } as PreparedAgent
    const scope = createScope(owner, agent)
    try {
      const commit = await setup?.(scope.ctx, agent)
      commit?.commit()
      return { agent, dispose: () => scope.dispose() }
    } catch (error) {
      await scope.dispose()
      throw error
    }
  }
  return {
    createAgent(owner, options: CreateAgentOptions) { return prepare(owner, options.setup) },
    resume(owner, options: ResumeAgentOptions) { return prepare(owner, options.setup) },
  }
}

let host: Harness
beforeEach(async () => { host = await harness({ trustWorkspaceConfig: false, watchWorkspaceConfig: false }) })
afterEach(async () => { await teardown(host) })

describe('workspace Agent setup contribution', () => {
  it('places create and resume before caller setup, and releases leases on disposal and failure', async () => {
    const cwd = await makeWorkspace(host.root, 'shared')
    await host.ctx.plugin(SessionProjectionRegistry)
    await host.ctx.plugin(AgentRegistry)
    await host.ctx.plugin(AgentPresetRegistry, { default: 'standard' })
    const releaseFactory = host.ctx.agents.setFactory(factory(cwd))
    const unregister = installAgentIntegration(host.ctx)
    try {
      const setup: AgentSetup = (agentCtx) => {
        const agentKey = scopeOf(agentCtx)!
        const workspaceKey = scopeParentOf(agentKey)!
        expect(host.registry.workspaceForScope(workspaceKey)).toBe(cwd)
        expect(host.registry.get(cwd)?.leases).toBeGreaterThan(0)
      }
      const created = await host.ctx.agents.create({
        sessionId: 'workspace-created' as CreateAgentOptions['sessionId'], setup,
      })
      expect(host.registry.get(cwd)?.leases).toBe(1)
      await created.dispose()
      expect(host.registry.size).toBe(0)

      const resumed = await host.ctx.agents.resume({
        resumeSessionId: 'workspace-resumed' as ResumeAgentOptions['resumeSessionId'], setup,
      })
      expect(host.registry.get(cwd)?.leases).toBe(1)
      await resumed.dispose()
      expect(host.registry.size).toBe(0)

      await expect(host.ctx.agents.create({
        sessionId: 'workspace-failure' as CreateAgentOptions['sessionId'],
        setup: async (agentCtx, agent) => {
          setup(agentCtx, agent)
          throw new Error('caller setup failed')
        },
      })).rejects.toThrow('caller setup failed')
      expect(host.registry.size).toBe(0)
    } finally {
      unregister()
      releaseFactory()
    }
  })
})
