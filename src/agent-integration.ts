/** Register awaited workspace placement for newly created and resumed Agents. */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import { isAbsolute } from 'node:path'

/** Registration is owned by the caller's Cordis effect. */
export function installAgentIntegration(ctx: Context): () => void {
  const setup: AgentSetup = async (agentCtx, agent) => {
    const cwd = agent.session.header.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw new Error('workspace-agent-integration: Agent session requires an absolute cwd')
    }
    const lease = await ctx.workspaceCordis.acquire(cwd)
    try {
      ctx.agentPresets.place(agentCtx, lease)
    } catch (error) {
      await lease.release()
      throw error
    }
  }
  return ctx.agents.registerSetup(setup)
}
