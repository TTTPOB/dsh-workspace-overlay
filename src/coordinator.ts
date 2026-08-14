/**
 * Per-agent workspace binding coordinator.
 *
 * The AgentRegistry decorator acquires one workspace lease per agent and
 * records the agent's unique scope-parent binding here, keyed by the agent
 * scope key (`scopeOf(agentCtx)`). The record lives in a WeakMap, so it dies
 * with the agent; `unbind()` drops the record and releases the lease, and is
 * the single teardown path (registered as the agent's effect disposer).
 * dsh-scope exposes no API to delete a parent link, so disposal only drops
 * our record and releases the lease — the parent edge itself lives and dies
 * with the agent scope.
 *
 * The record is the agentPresets decorator's storage for the exact
 * workspace-local preset generation the agent runs on (`preset`), so
 * blank-session recompose and subagent `composeFrom()` can rebind through the
 * same unique binding and keep the joined counts balanced.
 *
 * @module dsh-workspace-overlay/coordinator
 */
import { bindScopeParent, type ScopeKey, type ScopeParentBinding } from '@deepseek-ai/dsh-scope'
import type { WorkspaceLease } from './registry.js'
import type { PresetGeneration } from './workspace-presets.js'

/** One live agent's workspace binding. */
export interface AgentBindingRecord {
  /** The agent scope key (`scopeOf(agentCtx)`); compares by reference only. */
  readonly agentKey: ScopeKey
  /** The workspace lease this agent holds; released exactly once on unbind. */
  readonly lease: WorkspaceLease
  /** The unique parent binding; the agentPresets decorator rebinds it. */
  readonly binding: ScopeParentBinding
  /**
   * The exact workspace-local preset generation the agent is joined to, or
   * undefined while the agent sits directly on the workspace layer.
   */
  preset?: PresetGeneration
}

/** Coordinates agent scope keys with the workspace leases they hold. */
export class AgentBindingCoordinator {
  private readonly records = new WeakMap<ScopeKey, AgentBindingRecord>()
  private live = 0

  /** Number of live agent bindings (debug). */
  get size(): number {
    return this.live
  }

  /**
   * Bind `agentKey` under the workspace scope of `lease`.
   *
   * A duplicate bind for the same key is rejected before any mutation, and a
   * `bindScopeParent` failure (the key already has a parent) propagates
   * untouched — either way no record is left behind.
   *
   * @returns the unique parent binding, kept in the record for rebinding.
   */
  bind(agentKey: ScopeKey, lease: WorkspaceLease): ScopeParentBinding {
    if (this.records.has(agentKey)) {
      throw new Error('agent scope is already bound to a workspace lease')
    }
    const binding = bindScopeParent(agentKey, lease.key)
    this.records.set(agentKey, { agentKey, lease, binding })
    this.live += 1
    return binding
  }

  /** The live binding record for `agentKey`, or undefined. */
  recordFor(agentKey: ScopeKey): AgentBindingRecord | undefined {
    return this.records.get(agentKey)
  }

  /**
   * Re-link the agent to `generation`'s scope key and balance the joined
   * counts: the previous generation (if any) is left, the new one joined.
   *
   * Used by mount, blank-session recompose, and synchronous `composeFrom`
   * alike — all three are a parent re-link through the record's binding. The
   * rebind happens first, so a cycle rejection (unreachable here: the
   * generation is a fresh child of the workspace scope) leaves both the
   * binding and the counts untouched; a re-join of the generation the agent
   * already runs on is a no-op.
   */
  switchPreset(agentKey: ScopeKey, generation: PresetGeneration): void {
    const record = this.records.get(agentKey)
    if (!record) {
      throw new Error('agent-presets: agent has no live workspace binding; cannot join a preset generation')
    }
    record.binding.rebind(generation.key)
    if (record.preset === generation) return
    record.preset?.leave()
    generation.join()
    record.preset = generation
  }

  /**
   * Drop the record and release the workspace lease. The preset generation is
   * left FIRST — an idle superseded generation disposes here, before the
   * lease release can tear the workspace scope down. Idempotent, and safe as
   * an async Cordis effect disposer: the effect machinery awaits the returned
   * promise, so the final lease release disposes the workspace scope only
   * after the agent scope has unwound.
   */
  unbind(agentKey: ScopeKey): Promise<void> {
    const record = this.records.get(agentKey)
    if (!record) return Promise.resolve()
    record.preset?.leave()
    this.records.delete(agentKey)
    this.live -= 1
    return Promise.resolve(record.lease.release())
  }

  /**
   * Assert the binding for `agentKey` is still live. The decorator runs this
   * at the agent's publication commit point, after the caller's own commit.
   */
  commit(agentKey: ScopeKey): void {
    if (!this.records.has(agentKey)) {
      throw new Error('agent workspace binding is no longer live at publication commit')
    }
  }
}
