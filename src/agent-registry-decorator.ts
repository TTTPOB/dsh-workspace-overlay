/**
 * Reversible AgentRegistry `create`/`resume` decorator.
 *
 * Wraps the public `ctx.agents.create()` and `ctx.agents.resume()` methods so
 * every consumer (Web API, ACP, SDK/headless, …) composes the caller's setup
 * with a workspace bind that completes BEFORE any caller contribution:
 *
 * ```text
 * combined setup(agentCtx)
 *   → scopeOf(agentCtx) must exist and read session.header.cwd from the key
 *   → await workspaceCordis.acquire(cwd)          (rejects on bad cwd)
 *   → coordinator.bind(agentKey, lease)           (unique parent binding)
 *   → agentCtx.effect: async disposer → coordinator.unbind(agentKey)
 *   → await caller setup(agentCtx)
 *   → commit: caller commit first, then a coordinator liveness assertion
 * ```
 *
 * The lease therefore outlives setup/commit/publish failures only while the
 * agent scope lives: a setup throw, commit throw, or publication rollback
 * unwinds the scope, which runs the effect disposer and releases the lease.
 * A bind failure happens before the disposer exists, so the lease is released
 * manually on that path.
 *
 * NOT enabled in any composition yet: enabling it while the official
 * agentPresets provider still binds agents directly would double-bind the
 * agent scope key. The agentPresets decorator lands in the same commit that
 * wires this up.
 *
 * @module dsh-workspace-overlay/agent-registry-decorator
 */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {
  Agent,
  AgentRegistry,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { isAbsolute } from 'node:path'
import type { AgentBindingCoordinator } from './coordinator.js'
import { installMethodWrapper } from './method-wrapper.js'
import type WorkspaceRegistry from './registry.js'

/** Reverting the decorators restores the pre-install method descriptors. */
export interface AgentRegistryDecoratorHandle {
  dispose(): void
}

/**
 * Compose the caller's setup with the workspace acquire/bind transaction.
 *
 * The agent scope key is the agent itself (ReactLoopAgent mints
 * `createScope(loopCtx, this)`), so the session header's `cwd` is read
 * directly from the key. A missing, relative, or unresolvable cwd rejects the
 * setup — it never falls back to `process.cwd()`.
 */
export function composeAgentSetup(
  callerSetup: AgentSetup | undefined,
  coordinator: AgentBindingCoordinator,
  workspaceCordis: WorkspaceRegistry,
): AgentSetup {
  return async (agentCtx: Context) => {
    const agentKey = scopeOf(agentCtx)
    if (!agentKey) {
      throw new Error(
        'agent-registry-decorator: agent setup ran on an unscoped context; cannot bind a workspace',
      )
    }
    const agent = agentKey as Agent
    const cwd = agent.session?.header.cwd
    if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd)) {
      throw new Error(
        'agent-registry-decorator: agent session has no valid absolute cwd; refusing to bind a workspace',
      )
    }
    const lease = await workspaceCordis.acquire(cwd)
    try {
      // The unique scope-parent binding. Rejects duplicate coordinator records
      // and pre-existing scope parents; no record is left on failure.
      coordinator.bind(agentKey, lease)
    } catch (error) {
      // The lease was acquired but the bind failed before the effect disposer
      // existed: release it here so no path leaks a lease.
      await lease.release()
      throw error
    }
    try {
      // From here on the agent scope owns the lease: setup/commit/publish
      // failures and final disposal all unwind the scope, which awaits this
      // async disposer and releases the lease exactly once.
      agentCtx.effect(() => () => coordinator.unbind(agentKey), 'agent-workspace-binding')
    } catch (error) {
      await coordinator.unbind(agentKey)
      throw error
    }
    const callerCommit = await callerSetup?.(agentCtx)
    return {
      commit: () => {
        // The caller's publication commit runs first; the decorator then
        // asserts its binding is still live at the exact commit point.
        callerCommit?.commit()
        coordinator.commit(agentKey)
      },
    }
  }
}

/** Rewrite `create` options with the combined setup. */
function rewriteCreate(
  coordinator: AgentBindingCoordinator,
  workspaceCordis: WorkspaceRegistry,
) {
  return (original: AgentRegistry['create'], thisArg: AgentRegistry, args: unknown[]): unknown => {
    const options = args[0] as CreateAgentOptions | undefined
    if (!options) {
      throw new TypeError('agent-registry-decorator: create() requires options')
    }
    return original.call(thisArg, {
      ...options,
      setup: composeAgentSetup(options.setup, coordinator, workspaceCordis),
    })
  }
}

/** Rewrite `resume` options with the combined setup. */
function rewriteResume(
  coordinator: AgentBindingCoordinator,
  workspaceCordis: WorkspaceRegistry,
) {
  return (original: AgentRegistry['resume'], thisArg: AgentRegistry, args: unknown[]): unknown => {
    const options = args[0] as ResumeAgentOptions | undefined
    if (!options) {
      throw new TypeError('agent-registry-decorator: resume() requires options')
    }
    return original.call(thisArg, {
      ...options,
      setup: composeAgentSetup(options.setup, coordinator, workspaceCordis),
    })
  }
}

/**
 * Install the create/resume decorators on the provider-owned AgentRegistry
 * target. `target` may be the raw instance or a traceable value; only the
 * `symbols.original` target is ever modified, and the installed methods are
 * plain functions that call the original with the traceable shadow receiver,
 * preserving `this.ctx` (the caller's owner context) through to the factory.
 */
export function installAgentRegistryDecorators(
  target: AgentRegistry,
  coordinator: AgentBindingCoordinator,
  workspaceCordis: WorkspaceRegistry,
): AgentRegistryDecoratorHandle {
  const raw = (target as AgentRegistry & { [symbols.original]?: AgentRegistry })[symbols.original] ?? target
  const handles = [
    installMethodWrapper(raw, 'create', rewriteCreate(coordinator, workspaceCordis)),
    installMethodWrapper(raw, 'resume', rewriteResume(coordinator, workspaceCordis)),
  ]
  return {
    dispose() {
      for (const handle of handles) handle.dispose()
    },
  }
}
