/**
 * Reversible decorator for the official `agentPresets` provider.
 *
 * The official `AgentPresets.mount()` / `composeFrom()` / `recompose()` bind
 * the agent scope key directly to the provider's GLOBAL standing preset scope.
 * With the workspace binding in place that would double-bind (the agent key is
 * already parented to its workspace scope), so this decorator takes over those
 * three call sites and routes them through the shared coordinator and the
 * workspace-local preset registry instead:
 *
 * - `mount` / `recompose`: the agent's coordinator record must exist; the
 *   preset is resolved through the official `resolve()` (the private
 *   `resolveMountable()` broken check is replicated here, since it is not
 *   exported), the workspace-local generation is ensured under the agent's
 *   lease, and the agent's unique binding is re-linked to the generation's
 *   scope key with joined counts balanced.
 * - `composeFrom`: strictly synchronous — it reads the parent's live record
 *   (workspace identity compared by lease canonical, no filesystem I/O) and
 *   re-links the child to the parent's EXACT generation. A parent without a
 *   record and without an official standing mount keeps the child on its own
 *   workspace layer (rosterless semantics); a parent bound outside this
 *   coordinator, or in a different workspace, is rejected rather than
 *   silently dropping the child's workspace layer.
 *
 * The ORIGINAL three methods are never invoked — each one would write a second
 * scope-parent binding. Discovery, settings, authoring, `standingKeyFor()`
 * and the readers (`composedPreset()` / `serviceFor()`) stay official: the
 * agent's direct parent is the generation key `mountPreset()` registered in
 * the official standing-mount registry, which is exactly what those readers
 * match on.
 *
 * Like the AgentRegistry decorator, this is a startup-structure install: it
 * is not hardened against live-agent HMR of the decorator's own rows. Host
 * teardown and fiber dispose with no live agents restore the three method
 * descriptors completely.
 *
 * @module dsh-workspace-overlay/agent-presets-decorator
 */
import { symbols, type Context } from '@deepseek-ai/cordis'
import {
  PresetMountError,
  standingMountFor,
  type AgentPreset,
  type AgentPresets,
} from '@deepseek-ai/dsh-agent-presets'
import { scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import type { AgentBindingCoordinator } from './coordinator.js'
import { installMethodWrapper } from './method-wrapper.js'
import type { WorkspacePresetRegistry } from './workspace-presets.js'

/** Reverting the decorators restores the pre-install method descriptors. */
export interface AgentPresetsDecoratorHandle {
  dispose(): void
}

/** The agent scope key of one context, or a clear error when absent. */
function requireAgentKey(agentCtx: Context, what: string): ScopeKey {
  const agentKey = scopeOf(agentCtx)
  if (agentKey === undefined) {
    throw new Error(
      `agent-presets-decorator: refusing to ${what} an unscoped context; `
      + 'the scope key is what joins an agent to its preset',
    )
  }
  return agentKey
}

/**
 * The official `resolveMountable()` is private; replicate its contract —
 * resolve, then refuse a discovery-reported broken preset with the same error
 * type the mounting paths use, before any mount attempt.
 */
async function resolveMountable(thisArg: AgentPresets, id: string | undefined): Promise<AgentPreset> {
  const preset = await thisArg.resolve(id)
  if (preset.broken !== undefined) throw new PresetMountError(preset.id, preset.broken)
  return preset
}

/** Wrap `mount`: ensure the workspace-local generation, then re-link and join. */
function wrapMount(coordinator: AgentBindingCoordinator, presets: WorkspacePresetRegistry) {
  return async (
    _original: AgentPresets['mount'],
    thisArg: AgentPresets,
    args: unknown[],
  ): Promise<unknown> => {
    const agentCtx = args[0] as Context | undefined
    if (!agentCtx) throw new TypeError('agent-presets-decorator: mount() requires an agent context')
    const id = args[1] as string | undefined
    const agentKey = requireAgentKey(agentCtx, 'compose an agent')
    const record = coordinator.recordFor(agentKey)
    if (!record) {
      throw new Error(
        'agent-presets-decorator: agent has no workspace binding; mount must run '
        + 'inside the workspace-composed agent setup (ctx.agents.create/resume)',
      )
    }
    const preset = await resolveMountable(thisArg, id)
    const generation = await presets.ensure(record.lease, preset)
    coordinator.switchPreset(agentKey, generation)
    return preset
  }
}

/**
 * Wrap `recompose`: the same transaction as mount — a workspace-local
 * generation switch through the record's unique binding. The caller keeps
 * owning the blank-session precondition, exactly as official recompose does.
 */
function wrapRecompose(coordinator: AgentBindingCoordinator, presets: WorkspacePresetRegistry) {
  return async (
    _original: AgentPresets['recompose'],
    thisArg: AgentPresets,
    args: unknown[],
  ): Promise<unknown> => {
    const agentCtx = args[0] as Context | undefined
    if (!agentCtx) throw new TypeError('agent-presets-decorator: recompose() requires an agent context')
    const id = args[1] as string | undefined
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('agent-presets-decorator: recompose() requires a preset id')
    }
    const agentKey = requireAgentKey(agentCtx, 'recompose an agent')
    const record = coordinator.recordFor(agentKey)
    if (!record) {
      throw new Error(
        'agent-presets-decorator: agent has no workspace binding; recompose requires '
        + 'an agent created through ctx.agents.create/resume',
      )
    }
    const preset = await resolveMountable(thisArg, id)
    const generation = await presets.ensure(record.lease, preset)
    coordinator.switchPreset(agentKey, generation)
    return preset
  }
}

/**
 * Wrap `composeFrom`: strictly synchronous inheritance of the parent's EXACT
 * generation, with no roster read, no mount, and no filesystem access.
 *
 * The child record must exist (the child's workspace bind runs before any
 * setup contribution). A parent with no record and no official standing mount
 * is a rosterless parent: the child stays on its own workspace layer. A
 * parent with an official standing mount but no record was composed outside
 * this coordinator — inheriting it would hang the child on the official
 * GLOBAL standing and drop its workspace layer, so it is rejected. A parent
 * on a different workspace is rejected too: cross-workspace children must be
 * created independently through the full asynchronous create path.
 */
function wrapComposeFrom(coordinator: AgentBindingCoordinator) {
  return (
    _original: AgentPresets['composeFrom'],
    _thisArg: AgentPresets,
    args: unknown[],
  ): unknown => {
    const agentCtx = args[0] as Context | undefined
    const parentCtx = args[1] as Context | undefined
    if (!agentCtx || !parentCtx) {
      throw new TypeError('agent-presets-decorator: composeFrom() requires agent and parent contexts')
    }
    const childKey = requireAgentKey(agentCtx, 'compose a child')
    const child = coordinator.recordFor(childKey)
    if (!child) {
      throw new Error(
        'agent-presets-decorator: child agent has no workspace binding; composeFrom '
        + 'must run inside the workspace-composed agent setup (ctx.agents.create/resume)',
      )
    }
    const parentKey = scopeOf(parentCtx)
    const parent = parentKey === undefined ? undefined : coordinator.recordFor(parentKey)
    if (!parent) {
      // Only a parent that joined nothing anywhere keeps the child on its own
      // workspace layer; a foreign standing mount is a composition this
      // coordinator cannot inherit without losing the workspace.
      if (standingMountFor(parentCtx) === undefined) return undefined
      throw new Error(
        'agent-presets-decorator: parent agent was composed outside this workspace '
        + 'binding; inheriting its preset would drop the child\'s workspace layer',
      )
    }
    if (parent.lease.canonical !== child.lease.canonical) {
      throw new Error(
        'agent-presets-decorator: cannot composeFrom across workspaces; a child in '
        + 'another workspace must be created independently',
      )
    }
    if (parent.preset === undefined) return undefined
    coordinator.switchPreset(childKey, parent.preset)
    return parent.preset.presetId
  }
}

/**
 * Install the mount/composeFrom/recompose decorators on the provider-owned
 * AgentPresets target. `target` may be the raw instance or a traceable value;
 * only the `symbols.original` target is ever modified. The installed methods
 * are plain functions that never call the original — they implement the
 * workspace-local composition themselves.
 */
export function installAgentPresetsDecorators(
  target: AgentPresets,
  coordinator: AgentBindingCoordinator,
  presets: WorkspacePresetRegistry,
): AgentPresetsDecoratorHandle {
  const raw = (target as AgentPresets & { [symbols.original]?: AgentPresets })[symbols.original] ?? target
  const handles = [
    installMethodWrapper(raw, 'mount', wrapMount(coordinator, presets)),
    installMethodWrapper(raw, 'composeFrom', wrapComposeFrom(coordinator)),
    installMethodWrapper(raw, 'recompose', wrapRecompose(coordinator, presets)),
  ]
  return {
    dispose() {
      for (const handle of handles) handle.dispose()
    },
  }
}
