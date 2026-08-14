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
 * A generation is keyed by the preset composition file's stat stamp
 * (`mtimeMs` + `size`): the same stamp reuses the current generation, a
 * changed stamp starts a fresh generation whose scope key is a new object.
 * Agents already joined keep the generation they run on; a superseded
 * generation is disposed once its joined count reaches zero, while the
 * current generation lives until the workspace scope's final dispose collects
 * it (generation scopes are children of the workspace scope, so disposal
 * happens automatically).
 *
 * State is held in a WeakMap keyed by the workspace scope key (`lease.key`),
 * so it never keeps a disposed workspace alive: when the workspace entry is
 * dropped, the key becomes unreachable and the whole per-workspace map —
 * generations included — is collectable.
 *
 * Mounting goes through the official `mountPreset()`, which registers the
 * generation scope key in the official standing-mount registry; the agent's
 * direct scope parent is therefore that generation key, which is exactly what
 * the official `standingMountFor()` / `composedPreset()` / `serviceFor()`
 * readers match on.
 *
 * @module dsh-workspace-overlay/workspace-presets
 */
import { mountPreset, PresetMountError, type AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import { createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { stat } from 'node:fs/promises'
import type { WorkspaceLease } from './registry.js'

/** One composition file's stat stamp: the generation's identity within a workspace. */
export interface CompositionStamp {
  readonly mtimeMs: number
  readonly size: number
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
  /** The composition file stamp the generation was mounted under. */
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

/** Whether two stamps name the same file state. */
function sameStamp(a: CompositionStamp, b: CompositionStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/** Read one composition file's stamp, or undefined when it cannot be statted. */
async function compositionStamp(path: string): Promise<CompositionStamp | undefined> {
  try {
    const { mtimeMs, size } = await stat(path)
    return { mtimeMs, size }
  } catch {
    return undefined
  }
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
  /** Current generation per preset id; replaced (and superseded) on stamp change. */
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
   * mounting it under a fresh child scope when the stamp changed or none
   * exists. Concurrent calls for the same preset share one mount; a settled
   * failure is not cached, so a later call retries the fixed file.
   *
   * The returned generation has no join yet: the caller joins it when it
   * actually binds an agent to it.
   * @param lease - the workspace lease the generation is scoped to.
   * @param preset - the resolved preset to compose.
   * @throws `PresetMountError` when the composition is unreadable or unusable.
   */
  async ensure(lease: WorkspaceLease, preset: AgentPreset): Promise<PresetGeneration> {
    const state = this.stateFor(lease.key)
    for (;;) {
      const stamp = await compositionStamp(preset.path)
      if (stamp === undefined) {
        throw new PresetMountError(preset.id, `composition file is unreadable: ${preset.path}`)
      }
      const current = state.current.get(preset.id)
      if (current !== undefined && sameStamp(current.stamp, stamp)) return current
      const inflight = state.inflight.get(preset.id)
      if (inflight !== undefined) {
        const generation = await inflight
        if (sameStamp(generation.stamp, stamp)) return generation
        // The file changed while the shared mount was in flight: drop the
        // settled result and create a fresh generation for the new stamp.
        if (state.inflight.get(preset.id) === inflight) state.inflight.delete(preset.id)
        continue
      }
      const created = this.createGeneration(lease, preset, stamp)
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
      // The file changed again while mounting; the loop re-checks the stamp.
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
   * propagates the official `PresetMountError`.
   */
  private async createGeneration(
    lease: WorkspaceLease,
    preset: AgentPreset,
    stamp: CompositionStamp,
  ): Promise<PresetGeneration> {
    const key: ScopeKey = {}
    const scope = createScope(lease.ctx, key, { parent: lease.key })
    try {
      await mountPreset(scope.ctx, preset)
    } catch (error) {
      await scope.dispose()
      throw error
    }
    return new GenerationImpl(key, preset.id, stamp, scope)
  }
}
