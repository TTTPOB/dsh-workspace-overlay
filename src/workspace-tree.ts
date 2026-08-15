/**
 * One workspace's Cordis composition: `<workspace>/.dsh/cordis.yml` mounted
 * as an `Include` subtree under the workspace's scope context.
 *
 * The scope context is what makes the composition per-workspace: entry
 * contexts chain to the context the subtree was plugged into, so every
 * registration inside the config files into that workspace's layer and
 * unwinds with it. Two guards make that safe, mirroring the agent-presets
 * mount audit. A row that never reached a usable state is rejected, because
 * a directly-plugged subtree is absent from `ctx.loader.entries()` and no
 * boot audit covers it. A row that published a service into the ROOT realm
 * is rejected, because such a service is process-global rather than
 * per-workspace and the second workspace mounting the same row collides with
 * the first.
 *
 * @module dsh-workspace-overlay/workspace-tree
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import type { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import { inactiveRows, leakedServices } from '@deepseek-ai/dsh-agent-presets'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The fixed config file every workspace composition is read from. */
const CONFIG_REL = join('.dsh', 'cordis.yml')

/** The absolute path of one workspace's composition file. */
export function workspaceConfigPath(workspace: string): string {
  return join(workspace, CONFIG_REL)
}

/** A workspace composition failed to mount and was fully unwound. */
export class WorkspaceMountError extends Error {
  /** The canonical workspace path whose composition failed. */
  readonly workspace: string

  constructor(workspace: string, reason: string, options?: ErrorOptions) {
    super(`workspace-cordis: workspace ${workspace} failed to mount: ${reason}`, options)
    this.name = 'WorkspaceMountError'
    this.workspace = workspace
  }
}

/** What one mounted subtree publishes about itself for the audit to read. */
export interface MountedWorkspaceTree {
  /** The rows the composition created. */
  readonly tree: EntryTree
  /**
   * The subtree's own fiber. Captured here rather than taken from
   * `ctx.plugin()`, which hands back a thenable `Object.create(fiber)` wrapper
   * that is never identical to the fiber appearing in a parent chain.
   */
  readonly fiber: Fiber
  /**
   * Dispose exactly this subtree and wait for its teardown.
   *
   * Idempotent: only the first call tears the subtree down; later calls —
   * including one racing the first, and one arriving after the workspace
   * scope has already unwound the tree — resolve with the same result. The
   * workspace scope and every other child survive, which is what live reload
   * relies on; the final scope disposal may safely encounter an
   * already-disposed subtree.
   */
  dispose(): Promise<void>
}

/** What the constructor publishes before the mount's audit and disposer exist. */
type MountedSubtree = Omit<MountedWorkspaceTree, 'dispose'>

/**
 * Subtrees captured by config identity. A subtree plugged directly (rather
 * than created as a loader entry) never links itself to an `Entry`, so this
 * is the only handle to the rows it created; config objects are minted per
 * mount, so concurrent mounts cannot collide.
 */
const mounted = new WeakMap<object, MountedSubtree>()

/**
 * The base URL bare specifiers resolve against, per pending mount, keyed by
 * the same config object. Recorded before the subtree is plugged, because
 * `Include` rewrites its own context's `baseUrl` to the composition's
 * directory and the pre-mount value is the only handle on where the host
 * itself lives.
 */
const harnessBase = new WeakMap<object, string>()

/**
 * Include subclass that publishes its tree and fiber for the audit, and never
 * writes to the file it read.
 */
export class WorkspaceTree extends Include {
  constructor(ctx: Context, config: Include.Config) {
    super(ctx, config)
    mounted.set(config, { tree: this, fiber: ctx.fiber })
  }

  /**
   * Resolve a bare specifier from the host rather than from the workspace.
   *
   * `EntryTree.import()` resolves against the tree's own `baseUrl`, which
   * `Include` sets to the composition's directory. That is right for a
   * relative specifier — a workspace's own files travel with it — and wrong
   * for a package name: the workspace's `.dsh` directory is not part of the
   * profile's dependency tree, so no `@deepseek-ai/dsh-*` row would import.
   * The mount records the host composition's base instead, which is inside
   * the installed harness, and bare names resolve from there. An absolute
   * filesystem path names neither base and becomes a file URL before Node's
   * ESM loader receives it, which is required for drive-letter paths on
   * Windows.
   * @param name - the module specifier from the row.
   * @param getOuterStack - the loader's stack composer for import diagnostics.
   * @returns the imported module, or the `cordis:` builtin.
   */
  override import(name: string, getOuterStack?: () => string[]): unknown {
    const specifier = isAbsolute(name) ? pathToFileURL(name).href : name
    const base = harnessBase.get(this.config)
    /* v8 ignore next -- every WorkspaceTree is constructed by `mountWorkspaceTree`, which records the base first */
    if (base === undefined) return super.import(specifier, getOuterStack)
    if (name.startsWith('.') || name.startsWith('cordis:')) return super.import(name, getOuterStack)
    const internal = this.ctx.loader.internal
    /* v8 ignore next -- Node always supplies the internal module loader; the branch keeps a
       hypothetical embedder from losing the row's name in a resolution error. */
    if (internal === undefined) return super.import(specifier, getOuterStack)
    return internal.import(specifier, base, {})
  }

  /**
   * A workspace config is an input, never a persistence target.
   *
   * The Loader writes a tree back through this method whenever it decides the
   * config changed — a plugin self-disposing is enough, and disposing the
   * workspace scope tears the whole subtree down. Inherited, that rewrites
   * the config file with whatever the dying tree held, which in practice
   * means truncating a shipped composition to `[]` the first time a workspace
   * goes idle. Persisting a workspace config is also meaningless: nothing
   * here is runtime state, and the same file backs every lease of the
   * workspace.
   *
   * Dropping the write drops the `loader/config-update` the inherited method
   * emits with it. Nothing observes one for a workspace subtree today, and a
   * future reload flow needs a deliberate persistence path rather than this
   * method's return.
   */
  override write(): void {
  }
}

/**
 * The reportable text of a mount failure.
 *
 * The loader reports several failed rows as one `AggregateError`, whose own
 * message names none of them; without flattening, a composition that fails on
 * two rows says only "loader entries failed to apply" and the operator has
 * nothing to act on.
 * @param error - the value the mount rejected with.
 * @returns a single-line-per-cause description.
 */
function mountDetail(error: unknown): string {
  /* v8 ignore next -- every path into the mount's catch throws an Error: the loader
     wraps a row's thrown value before it propagates, and this module's own
     rejections are Errors. The fallback keeps a hostile value readable. */
  if (!(error instanceof Error)) return String(error)
  if (!(error instanceof AggregateError)) return error.message
  return [error.message, ...error.errors.map(cause => `- ${mountDetail(cause)}`)].join('\n')
}

/**
 * Mount `workspace`'s `<workspace>/.dsh/cordis.yml` under `scopeCtx` and
 * return only once every row is usable.
 *
 * The subtree is owned by `scopeCtx`'s fiber, so it unwinds with the scope,
 * and the returned handle also exposes an exact idempotent disposer for live
 * reload without tearing down the parent workspace scope. The registry's
 * final lease release remains the fallback owner. A rejection leaves nothing
 * mounted.
 * @param scopeCtx - the workspace scope's context, from the registry lease.
 * @param workspace - the canonical workspace path whose config to mount.
 * @returns the mounted subtree's tree and fiber.
 * @throws when `scopeCtx` carries no scope, a row is unusable, or a row
 * published a service into the root realm.
 */
export async function mountWorkspaceTree(
  scopeCtx: Context,
  workspace: string,
): Promise<MountedWorkspaceTree> {
  const scope = scopeOf(scopeCtx)
  if (scope === undefined) {
    throw new Error(
      'workspace-cordis: refusing to mount a workspace composition into an unscoped context; '
      + 'its registrations would apply to every workspace in the process',
    )
  }
  const path = workspaceConfigPath(workspace)
  const config: Include.Config = { path: pathToFileURL(path).href }
  // Captured before the subtree exists: the workspace scope context still
  // carries the host composition's base, which is inside the installed
  // harness and is therefore where a row's package name has to resolve from.
  /* v8 ignore next -- the Loader sets `baseUrl` on the root before any scoped context derives from it */
  if (scopeCtx.baseUrl !== undefined) harnessBase.set(config, scopeCtx.baseUrl)
  const handle = scopeCtx.plugin(WorkspaceTree, config)
  try {
    await handle.await()
    const subtree = mounted.get(config)
    /* v8 ignore next -- the subclass constructor runs before `await()` settles for every mounted tree */
    if (subtree === undefined) throw new Error('mounted subtree did not publish its entry tree')
    const unusable = inactiveRows(subtree.tree)
    if (unusable.length > 0) {
      throw new Error(`${String(unusable.length)} row(s) did not activate:\n${unusable.join('\n')}`)
    }
    const leaked = leakedServices(scopeCtx, subtree.fiber)
    if (leaked.length > 0) {
      throw new Error(
        `row(s) published process-global service(s) [${leaked.join(', ')}]; `
        + 'a workspace service must sit behind an `isolate` realm or move to the host composition',
      )
    }
    // The plugin handle wraps the subtree fiber and its disposal is awaited;
    // the memoized wrapper keeps the method idempotent under concurrent
    // callers and after the scope has already unwound the tree.
    let disposal: Promise<void> | undefined
    return {
      tree: subtree.tree,
      fiber: subtree.fiber,
      dispose: () => {
        disposal ??= Promise.resolve(handle.dispose())
        return disposal
      },
    }
  } catch (error) {
    try {
      await handle.dispose()
    /* v8 ignore next 5 -- teardown of a subtree nothing else references has no
       observed failure mode; the guard exists so a teardown error cannot
       replace the mount diagnostic the caller needs. */
    } catch {
      // Swallows only this subtree's teardown failure. The mount error below is
      // the actionable one, and the discarded fiber is unreachable either way.
    }
    throw new WorkspaceMountError(workspace, `${mountDetail(error)} (${path})`, { cause: error })
  }
}
