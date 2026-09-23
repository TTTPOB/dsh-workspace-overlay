/**
 * Workspace-local agent preset generations.
 *
 * One preset composition exists ONCE per canonical workspace, not once per
 * agent: `WorkspacePresetRegistry` maintains, per workspace scope key, the
 * current generation of each preset id — a `createScope(lease.ctx, key, {
 * parent: lease.key })` subtree with the preset mounted inside it — and
 * single-flights concurrent `ensure()` calls so two agents racing the first
 * use of one preset in a workspace share one composition.
 *
 * A generation is keyed by the preset's live revision identity: the same
 * revision reuses the current generation, a new revision starts a fresh
 * generation whose scope key is a new object. Agents already joined keep the
 * generation they run on; a superseded generation is disposed once its joined
 * count reaches zero, while the current generation lives until the workspace
 * scope's final dispose collects it (generation scopes are children of the
 * workspace scope, so disposal happens automatically).
 *
 * State is held in a WeakMap keyed by the workspace scope key (`lease.key`),
 * so it never keeps a disposed workspace alive: when the workspace entry is
 * dropped, the key becomes unreachable and the whole per-workspace map —
 * generations included — is collectable.
 *
 * ## DSH 0.1.7 migration notes
 *
 * The old code called the official `mountPreset(ctx, preset)`, which read the
 * composition from `preset.path`. 0.1.7 removed both:
 *
 *   * `mountPreset` is no longer re-exported from the package root (only
 *     `auditRows`, `leakedServices`, `livePresetMounts`, `serviceForAgent`
 *     and `standingMountFor` are), and
 *   * the public `AgentPreset` roster row no longer carries `path` — a preset
 *     is now an in-memory `PresetDefinition` whose `plugins` entry list is
 *     supplied by the declaring `@deepseek-ai/dsh-agent-preset` row.
 *
 * So this module mounts the definition itself, with a small in-memory
 * `EntryTree` subclass that mirrors what the official `PresetTree` does, and
 * reads the definition out of the registry's own declaration map. The
 * revision identity is the official standing mount's scope key, which 0.1.7
 * replaces whenever a definition is re-registered — the same "changed
 * composition means a new generation" signal the file's stat stamp used to
 * give.
 *
 * One deliberate gap: our subtree is not added to the registry's module-private
 * `mounts` set (there is no public way to), so `standingMountFor()` /
 * `serviceForAgent()` do not resolve workspace-local preset generations.
 * The only in-tree consumer of those in 0.1.7 is
 * `@deepseek-ai/dsh-plugin-package-inventory-deepseek`, which uses them to
 * list active plugin packages for a session; workspace preset entries are
 * therefore absent from that inventory. Nothing on the agent execution path
 * reads them.
 *
 * @module dsh-workspace-overlay/workspace-presets
 */
import {
  auditRows,
  leakedServices,
  livePresetMounts,
  type AgentPreset,
  type AgentPresetRegistry,
} from '@deepseek-ai/dsh-agent-preset-registry'
import type { Context } from '@deepseek-ai/cordis'
import { EntryTree, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createScope, scopeOf, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import type { WorkspaceLease } from './registry.js'

/**
 * The live revision identity of one preset: the scope key of its official
 * standing mount. Compared by reference — a re-registered definition gets a
 * new key, which is exactly the "the composition changed" signal.
 */
export interface CompositionStamp {
  readonly revision: ScopeKey
}

/**
 * In-memory loader tree for one preset composition.
 *
 * Mirrors the official `PresetTree`: an `EntryTree` whose `write()` is a
 * no-op, because a workspace-local preset generation is an input the overlay
 * never persists.
 */
class PresetListTree extends EntryTree {
  write(): void {}
}

/**
 * Mount one preset definition under `ctx` and return only once every row is
 * usable. Equivalent to the 0.1.5 official `mountPreset(ctx, preset)`, less
 * the private `mounts` registration that has no public entry point in 0.1.7.
 *
 * The subtree is owned by `ctx`'s fiber, so it unwinds with the scope that
 * contains it; the caller receives no separate disposer.
 * @param ctx - the generation scope's context.
 * @param id - preset identity, for diagnostics.
 * @param plugins - the definition's Cordis entry list.
 * @throws when `ctx` carries no scope, a row failed, or a row leaked a
 * service into the root realm.
 */
async function mountPresetEntries(
  ctx: Context,
  id: string,
  plugins: readonly EntryOptions[],
): Promise<void> {
  if (scopeOf(ctx) === undefined) {
    throw new Error(`agent-presets: mounting preset "${id}" requires a scoped context`)
  }
  await ctx.fiber.await()
  const tree = new PresetListTree(ctx)
  ctx.effect(() => () => {
    tree.root.stop()
  }, `agent-preset.${id}.tree`)
  await tree.root.update(structuredClone(plugins) as EntryOptions[])
  const audit = await auditRows(tree)
  if (audit.failed.length > 0) {
    throw new Error(`preset "${id}" failed to mount:\n${audit.failed.join('\n')}`)
  }
  const leaked = leakedServices(ctx, ctx.fiber)
  if (leaked.length > 0) {
    throw new Error(
      `preset "${id}" published non-isolated service(s) [${leaked.join(', ')}]; `
      + 'preset services require isolate realms',
    )
  }
}

/**
 * Read one preset's declared entry list out of the registry.
 *
 * `AgentPresetRegistry` keeps its declarations in a private `definitions`
 * map of `{ config: PresetDefinition, ... }`. 0.1.7 exposes no public
 * accessor for a definition's `plugins`, and the roster row dropped `path`,
 * so this is the only way to obtain the composition to re-mount per
 * workspace. Read defensively: a shape change returns `undefined` and the
 * caller surfaces an actionable error rather than mounting nothing.
 */
function pluginsOf(registry: AgentPresetRegistry, id: string): readonly EntryOptions[] | undefined {
  const holder = registry as unknown as {
    definitions?: Map<string, { config?: { plugins?: readonly EntryOptions[] } }>
  }
  return holder.definitions?.get(id)?.config?.plugins
}

/** The official standing mount key for `id`, used as its revision identity. */
function revisionOf(id: string): ScopeKey | undefined {
  return livePresetMounts().find(mount => mount.presetId === id)?.key
}

/**
 * One mounted workspace-local preset composition, shared by every agent of
 * the workspace that joins it.
 */
export interface PresetGeneration {
  /** Opaque scope identity; compare by reference only. */
  readonly key: ScopeKey
  /** The preset this generation was composed from. */
  readonly presetId: string
  /** The preset revision the generation was mounted under. */
  readonly stamp: CompositionStamp
  /** The generation's scope; disposed with the workspace scope at the latest. */
  readonly scope: Scope
  /** Number of live agents joined to this generation (debug). */
  readonly joined: number
  /** True once the generation's scope has been disposed. */
  readonly disposed: boolean
  /** Increment the joined count. Throws once the generation is disposed. */
  join(): void
  /** Decrement the joined count; a superseded generation disposes at zero. */
  leave(): void
  /** Mark superseded: dispose now if idle, else on the last leave(). */
  supersede(): void
}

/** Whether two stamps name the same preset revision. */
function sameStamp(a: CompositionStamp, b: CompositionStamp): boolean {
  return a.revision === b.revision
}

class GenerationImpl implements PresetGeneration {
  readonly key: ScopeKey
  readonly presetId: string
  readonly stamp: CompositionStamp
  readonly scope: Scope
  private count = 0
  private supersededFlag = false
  private disposedFlag = false
  private disposing: Promise<void> | undefined

  constructor(key: ScopeKey, presetId: string, stamp: CompositionStamp, scope: Scope) {
    this.key = key
    this.presetId = presetId
    this.stamp = stamp
    this.scope = scope
  }

  get joined(): number {
    return this.count
  }

  get disposed(): boolean {
    return this.disposedFlag
  }

  join(): void {
    if (this.disposedFlag) {
      throw new Error(
        `agent-presets: cannot join generation of preset "${this.presetId}": already disposed`,
      )
    }
    this.count += 1
  }

  leave(): void {
    if (this.count > 0) this.count -= 1
    this.maybeDispose()
  }

  supersede(): void {
    this.supersededFlag = true
    this.maybeDispose()
  }

  private maybeDispose(): void {
    if (!this.supersededFlag || this.count > 0 || this.disposedFlag) return
    this.disposedFlag = true
    // Fire-and-forget: disposal of an idle superseded generation is best
    // effort here — the workspace scope's final dispose collects the fiber
    // anyway. The rejection sink keeps a failed early disposal from surfacing
    // as an unhandled rejection.
    this.disposing ??= Promise.resolve(this.scope.dispose()).then(() => undefined, () => undefined)
  }
}

/** Per-workspace preset state; dies with the workspace scope key. */
interface WorkspacePresetState {
  /** Current generation per preset id; replaced (and superseded) on revision change. */
  current: Map<string, PresetGeneration>
  /** Single-flight creation per preset id. */
  inflight: Map<string, Promise<PresetGeneration>>
}

/**
 * Per-workspace preset generation registry.
 *
 * Identity is the workspace scope key (`lease.key`), so two agents holding
 * leases on the same workspace share one state map and one generation per
 * preset, while different workspaces (and different entries of a recreated
 * workspace) are fully isolated.
 */
export class WorkspacePresetRegistry {
  private readonly states = new WeakMap<ScopeKey, WorkspacePresetState>()

  /**
   * Ensure the current generation of `preset` in the lease's workspace,
   * mounting it under a fresh child scope when the revision changed or none
   * exists. Concurrent calls for the same preset share one mount; a settled
   * failure is not cached, so a later call retries.
   *
   * The returned generation has no join yet: the caller joins it when it
   * actually binds an agent to it.
   * @param lease - the workspace lease the generation is scoped to.
   * @param preset - the resolved preset to compose.
   * @param registry - the live preset registry, read for the definition.
   * @throws `RemoteError` when the definition is unavailable or unusable.
   */
  async ensure(
    lease: WorkspaceLease,
    preset: AgentPreset,
    registry: AgentPresetRegistry,
  ): Promise<PresetGeneration> {
    const state = this.stateFor(lease.key)
    for (;;) {
      const revision = revisionOf(preset.id)
      if (revision === undefined) {
        const reason = `preset has no live standing mount: ${preset.id}`
        throw new RemoteError('agent-preset/invalid', reason, {
          agentPreset: preset.id,
          reason,
        })
      }
      const stamp: CompositionStamp = { revision }
      const current = state.current.get(preset.id)
      if (current !== undefined && sameStamp(current.stamp, stamp)) return current
      const inflight = state.inflight.get(preset.id)
      if (inflight !== undefined) {
        const generation = await inflight
        if (sameStamp(generation.stamp, stamp)) return generation
        // The revision changed while the shared mount was in flight: drop the
        // settled result and create a fresh generation for the new revision.
        if (state.inflight.get(preset.id) === inflight) state.inflight.delete(preset.id)
        continue
      }
      const created = this.createGeneration(lease, preset, stamp, registry)
      state.inflight.set(preset.id, created)
      void created
        .then(
          (generation) => {
            const prev = state.current.get(preset.id)
            state.current.set(preset.id, generation)
            // The previous generation stays for its joined agents and is
            // disposed once they all leave.
            if (prev !== undefined && prev !== generation) prev.supersede()
          },
          () => {
            // The rejection is delivered to every ensure() awaiting `created`;
            // this bookkeeping chain must not become an unhandled rejection.
          },
        )
        .finally(() => {
          if (state.inflight.get(preset.id) === created) state.inflight.delete(preset.id)
        })
      const generation = await created
      if (sameStamp(generation.stamp, stamp)) return generation
      // The revision changed again while mounting; the loop re-checks.
    }
  }

  private stateFor(key: ScopeKey): WorkspacePresetState {
    let state = this.states.get(key)
    if (state === undefined) {
      state = { current: new Map(), inflight: new Map() }
      this.states.set(key, state)
    }
    return state
  }

  /**
   * Mount one preset generation under a fresh scope child of the workspace
   * scope. The key is always a new object — a generation's identity must
   * never alias another scope's. A mount failure disposes the fresh scope and
   * propagates the error.
   */
  private async createGeneration(
    lease: WorkspaceLease,
    preset: AgentPreset,
    stamp: CompositionStamp,
    registry: AgentPresetRegistry,
  ): Promise<PresetGeneration> {
    const plugins = pluginsOf(registry, preset.id)
    if (plugins === undefined) {
      const reason = `preset definition is not readable from the registry: ${preset.id}`
      throw new RemoteError('agent-preset/invalid', reason, {
        agentPreset: preset.id,
        reason,
      })
    }
    const key: ScopeKey = {}
    const scope = createScope(lease.ctx, key, { parent: lease.key })
    try {
      await mountPresetEntries(scope.ctx, preset.id, plugins)
    } catch (error) {
      await scope.dispose()
      // Match the official contract: `AgentPresetRegistry.retain()` reports a
      // preset whose composition will not mount as `agent-preset/invalid` with
      // the diagnostic carried in `reason` (see `retain` + `diagnostic` in
      // 0.1.7). A plain Error here would reach remote clients as an opaque
      // failure instead of "this preset is broken, because …".
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('agent-preset/invalid', reason, {
        agentPreset: preset.id,
        reason,
      })
    }
    return new GenerationImpl(key, preset.id, stamp, scope)
  }
}
