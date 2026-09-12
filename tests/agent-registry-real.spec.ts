import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Context } from '@deepseek-ai/cordis'
import AgentRegistry, {
  type Agent,
  type AgentFactory,
  type AgentHandle,
  type CreateAgentOptions,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { createScope } from '@deepseek-ai/dsh-scope'
import { installAgentIntegration } from '../src/agent-integration.js'
import { harness, makeWorkspace, teardown, type Harness } from './helpers.js'

class StubAgentPresets {
  async mount(): Promise<never> {
    throw new Error('not used by this workspace-only integration test')
  }

  composeFrom(): string | undefined {
    return undefined
  }

  async recompose(): Promise<never> {
    throw new Error('not used by this workspace-only integration test')
  }
}

interface MinimalAgent extends Agent {
  session: Agent['session']
}

function createFactory(createCwd: string, resumeCwd: string, owners: Context[]): AgentFactory {
  async function prepare(ownerCtx: Context, cwd: string, setup: CreateAgentOptions['setup']): Promise<AgentHandle> {
    owners.push(ownerCtx)
    const agent = {
      session: { header: { cwd } },
    } as unknown as MinimalAgent
    const scope = createScope(ownerCtx, agent)
    const agentCtx = scope.ctx.extend({ agent })
    try {
      const commit = await setup?.(agentCtx, agent)
      commit?.commit()
    } catch (error) {
      await scope.dispose()
      throw error
    }
    return {
      agent,
      dispose: () => scope.dispose(),
    }
  }

  return {
    createAgent(ownerCtx, options) {
      return prepare(ownerCtx, createCwd, options.setup)
    },
    resume(ownerCtx, options: ResumeAgentOptions) {
      return prepare(ownerCtx, resumeCwd, options.setup)
    },
  }
}

let host: Harness

beforeEach(async () => {
  host = await harness()
})

afterEach(async () => {
  await teardown(host)
})

describe('real AgentRegistry provider integration', () => {
  it('decorates public create/resume through the traceable service and owns leases until handle disposal', async () => {
    const createWorkspace = await makeWorkspace(host.root, 'real-create')
    const resumeWorkspace = await makeWorkspace(host.root, 'real-resume')
    await host.ctx.plugin(AgentRegistry)
    host.ctx.provide('agentPresets', new StubAgentPresets() as unknown as AgentPresets)

    const owners: Context[] = []
    const releaseFactory = host.ctx.agents.setFactory(
      createFactory(createWorkspace, resumeWorkspace, owners),
    )
    const integration = installAgentIntegration(host.ctx)
    const caller = await host.ctx.plugin({
      name: 'real-agent-registry-caller',
      inject: ['agents'],
      apply() {},
    })

    const created = await caller.ctx.agents.create({
      sessionId: 'real-create' as CreateAgentOptions['sessionId'],
      meta: { cwd: createWorkspace },
    })
    expect(owners[0]?.fiber).toBe(caller.ctx.fiber)
    expect(integration.coordinator.size).toBe(1)
    expect(host.registry.size).toBe(1)

    await created.dispose()
    expect(integration.coordinator.size).toBe(0)
    expect(host.registry.size).toBe(0)

    const resumed = await caller.ctx.agents.resume({
      resumeSessionId: 'real-resume' as ResumeAgentOptions['resumeSessionId'],
    })
    expect(owners[1]?.fiber).toBe(caller.ctx.fiber)
    expect(integration.coordinator.size).toBe(1)
    expect(host.registry.size).toBe(1)

    await resumed.dispose()
    expect(integration.coordinator.size).toBe(0)
    expect(host.registry.size).toBe(0)

    integration.dispose()
    releaseFactory()
    await caller.dispose()
  })
})
