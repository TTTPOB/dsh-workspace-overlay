/**
 * Workspace-aware MCP manager: owns the global/workspace split of MCP server
 * namespaces and drives the per-workspace namespace masking.
 *
 * Process contract (see the workspace-cordis plan §4.1): one global row of a
 * `serverName` spawns one server process for the whole app; a same-named
 * workspace override spawns one process per workspace; a workspace without an
 * override inherits the global process and spawns nothing. All agents of one
 * workspace share that workspace's entry and its process, because the
 * workspace composition (and therefore its MCP row) mounts once per
 * workspace scope.
 *
 * Masking contract: when a workspace declares an override of a server that
 * also has a live global generation, the workspace's own registrations
 * replace the inherited global namespace entirely — no mixed instance view.
 * The mask is `ctx.tools.restrict({ deny })` on the workspace row context
 * (its scope is the workspace scope), with `deny = current global public
 * names − the workspace's own public names`. The subtraction is required by
 * the rc.6 `view()` semantics: a restriction filters every inherited name for
 * a scope chain, and the workspace layer's own registrations are only exempt
 * for the workspace scope's OWN view — a descendant agent sees the workspace
 * layer's tools as inherited, so denying a name the workspace itself
 * registered would hide it from every agent under the workspace. The
 * subtracted names are instead shadowed by the workspace's own registrations,
 * which is exactly "replaced". `restrict()` demands scoped contexts and
 * known deny names, so masks are built only after the tracked global
 * generation is registered, and rebuilt — disposed first, new restriction
 * created in the same synchronous step, no `await` in between — whenever the
 * global generation swaps, gives up, or the workspace's own tool list
 * changes. All mask mutations for one `serverName` run on one serial commit
 * chain, so a global change can never interleave with an override's own
 * rebuild.
 *
 * Lifecycle ownership: `activate()` registers all of its effects on the row
 * context it receives, so the row fiber (owned by the workspace scope via
 * the composition) is the single teardown path: connection disposed first,
 * then override record/mask/reservation removed. The manager never holds a
 * workspace lease of its own and never guesses a workspace root — the
 * canonical root comes from the registry's `workspaceForScope()` mapping.
 *
 * @module dsh-workspace-overlay/mcp/manager
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { isAbsolute } from 'node:path'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'
import { Config as ConfigSchema, type Config, type StdioConfig } from './config.js'
import { resolveReconnectPolicy, startConnection } from './connection.js'
import type { ConnectionHandle, GenerationNotification } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Workspace-aware MCP namespace manager. */
    workspaceMcp: WorkspaceMcpManager
  }
}

/** The literal a workspace row's `cwd` may use to name its own workspace root. */
export const WORKSPACE_ROOT_TOKEN = '${workspaceRoot}'

/** Short diagnostic identity for one workspace: basename + path hash. */
function describeWorkspace(canonical: string): string {
  const base = canonical.slice(canonical.lastIndexOf('/') + 1) || canonical
  return `${base}#${hashPath(canonical)}`
}

/** Short stable hash of the canonical path, for redacted diagnostics. */
function hashPath(path: string): string {
  let hash = 0
  // Non-cryptographic FNV-1a: diagnostics only, no secret material involved.
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 8)
}

/** One live workspace override of a global server namespace. */
interface WorkspaceOverride {
  /** The workspace scope key (`scopeOf(row ctx)`), the reservation identity. */
  readonly scopeKey: ScopeKey
  /** The canonical workspace root, from the registry's scope mapping. */
  readonly canonical: string
  /**
   * The row context: inject-bearing (or `get()`-capable), tagged with the
   * workspace scope, and owner of every effect `activate()` registers.
   */
  readonly ctx: Context
  /** Public names this workspace's own connection currently owns. */
  readonly ownNames: Set<string>
  /** The live mask disposer (`tools.restrict`), when a mask is installed. */
  maskDisposer?: () => void
  /** Most recent mask rebuild failure; startup checks it before publishing. */
  maskError?: unknown
  /** Set once removal started so a pending chain action skips the record. */
  removed?: boolean
}

export default class WorkspaceMcpManager extends Service {
  /**
   * The tool registry (registrations and masks) and the workspace registry
   * (the only authority mapping workspace scope keys to canonical roots)
   * must both exist before the manager may serve rows.
   */
  static inject = ['tools', 'workspaceCordis']

  /** Provider-owned context; never the traceable caller ctx of a method. */
  private readonly selfCtx: Context
  /** serverName → full public names of the live global generation. */
  private readonly globalNames = new Map<string, string[]>()
  /** serverName → scopeKey → live workspace override. */
  private readonly overrides = new Map<string, Map<ScopeKey, WorkspaceOverride>>()
  /** Global serverNames reserved by manager-owned global rows. */
  private readonly globalReserved = new Set<string>()
  /** Per-workspace serverName reservations, keyed by the workspace scope. */
  private readonly workspaceReserved = new Map<ScopeKey, Set<string>>()
  /** serverName → serialized commit tail for all mask-affecting mutations. */
  private readonly chains = new Map<string, Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'workspaceMcp')
    this.selfCtx = ctx
  }

  /**
   * Serialize one mask-affecting mutation per `serverName`, so a global
   * generation change can never interleave with an override's own rebuild.
   * The chain tail must survive a failed action; the enqueuing caller owns
   * reporting.
   */
  private commit(serverName: string, action: () => void): Promise<void> {
    const tail = this.chains.get(serverName) ?? Promise.resolve()
    const run = tail.then(action)
    this.chains.set(serverName, run.catch(() => {}))
    return run
  }

  /** Wait until every mask mutation already queued for one namespace settles. */
  private awaitCommits(serverName: string): Promise<void> {
    return this.chains.get(serverName) ?? Promise.resolve()
  }

  /**
   * Activate one MCP row: connect the server through the row context and
   * register its tools in that context's layer (global for an unscoped row,
   * the workspace layer for a workspace row), enforce reservations, and for
   * workspace rows build the namespace mask over the live global generation.
   *
   * All effects are registered on `ctx` (the row fiber), so a startup
   * failure — `failOnStartupError: true` is mandatory for workspace rows —
   * rejects the fiber and Cordis unwinds them: connection disposed, then
   * override record/mask/reservation removed. The workspace composition
   * mount therefore fails before any agent is published.
   *
   * @param ctx - the row context; `scopeOf(ctx)` decides global vs workspace.
   * @param rawConfig - row config; validated against the MCP Config schema here
   *   so programmatic rows (and workspace compositions) get the same
   *   validation the loader applies to the plugin entry.
   */
  async activate(ctx: Context, rawConfig: unknown): Promise<void> {
    // The schema callable expects its own input type; raw programmatic config
    // is validated (and rejected) at runtime, so the input widens to `never`.
    const config = ConfigSchema(rawConfig as never)
    const scope = scopeOf(ctx)
    const canonical = scope === undefined ? undefined : this.workspaceRoot(scope, config)
    if (scope !== undefined && canonical === undefined) {
      throw new Error(
        `workspace-mcp(${config.serverName}): row activates under a scope that is not a workspace scope — `
        + 'workspace MCP rows must live in a workspace composition, not a preset or other scoped context',
      )
    }
    const workspace = scope !== undefined && canonical !== undefined
    if (workspace && !config.failOnStartupError) {
      throw new Error(
        `workspace-mcp(${config.serverName}): workspace rows must set failOnStartupError: true — `
        + 'a failed startup must reject the workspace composition before any agent is published',
      )
    }
    const effective = workspace ? resolveWorkspaceConfig(config, canonical!) : config
    const policy = resolveReconnectPolicy(config.reconnect, `workspace-mcp(${config.serverName}): reconnect`)
    this.reserve(scope, config.serverName)

    let connection: ConnectionHandle | undefined
    if (workspace) {
      const record: WorkspaceOverride = {
        scopeKey: scope!,
        canonical: canonical!,
        ctx,
        ownNames: new Set(),
      }
      let byServer = this.overrides.get(config.serverName)
      if (!byServer) {
        byServer = new Map()
        this.overrides.set(config.serverName, byServer)
      }
      byServer.set(scope!, record)
      // The row teardown effect is registered before startConnection; the
      // fiber machinery disposes effects in parallel, so connection disposal
      // and override removal are fused into one sequenced disposer: await
      // connection.dispose, then remove the override/mask/reservation.
      ctx.effect(() => () => this.teardownRow(config.serverName, scope!, connection), 'workspaceMcp.row')
      connection = startConnection(ctx, effective, policy, change => {
        this.onGeneration(config.serverName, scope, change)
      })
    } else {
      ctx.effect(() => () => this.teardownGlobal(config.serverName, connection), 'workspaceMcp.row')
      connection = startConnection(ctx, effective, policy, change => {
        this.onGeneration(config.serverName, scope, change)
      })
    }

    const outcome = await connection.ready
    await this.awaitCommits(config.serverName)
    const maskError = workspace
      ? this.overrides.get(config.serverName)?.get(scope!)?.maskError
      : undefined
    if ((outcome.error !== undefined || maskError !== undefined) && config.failOnStartupError) {
      throw new Error(
        `workspace-mcp(${config.serverName}): initial connection or tool synchronization failed, or namespace masking failed`,
        { cause: outcome.error ?? maskError },
      )
    }
  }

  /** Resolve the canonical workspace root for a scoped row, or undefined. */
  private workspaceRoot(scope: ScopeKey, config: Config): string | undefined {
    const root = this.selfCtx.workspaceCordis.workspaceForScope(scope)
    if (root === undefined) {
      this.selfCtx.logger.error(
        `workspace-mcp(${config.serverName}): scope is not a live workspace entry — row ignored`,
      )
    }
    return root
  }

  /** Dispose a global row, wait for every override mask update, then free its name. */
  private async teardownGlobal(serverName: string, connection: ConnectionHandle | undefined): Promise<void> {
    if (connection !== undefined) await connection.dispose()
    await this.awaitCommits(serverName)
    this.globalReserved.delete(serverName)
  }

  /**
   * One row's teardown, fused into a single disposer: the connection is fully
   * disposed (process closed, tools unregistered) before the override record,
   * mask, and reservation are removed — the fiber machinery disposes effects
   * in parallel, so a separate disposer could not order them.
   */
  private async teardownRow(serverName: string, scopeKey: ScopeKey, connection: ConnectionHandle | undefined): Promise<void> {
    if (connection !== undefined) await connection.dispose()
    await this.removeOverride(serverName, scopeKey)
  }

  /** Reject a duplicate `serverName` within one scope; add the reservation. */
  private reserve(scope: ScopeKey | undefined, serverName: string): void {
    if (scope === undefined) {
      if (this.globalReserved.has(serverName)) {
        throw new Error(
          `workspace-mcp: serverName "${serverName}" is already in use by another workspace-mcp instance in the global scope — pick a unique serverName`,
        )
      }
      this.globalReserved.add(serverName)
      return
    }
    let reserved = this.workspaceReserved.get(scope)
    if (reserved === undefined) {
      reserved = new Set()
      this.workspaceReserved.set(scope, reserved)
    }
    if (reserved.has(serverName)) {
      throw new Error(
        `workspace-mcp: serverName "${serverName}" is already in use by another workspace-mcp instance in this workspace — one row per serverName per workspace`,
      )
    }
    reserved.add(serverName)
  }

  /**
   * One committed generation change. Global changes refresh the tracked full
   * name set and rebuild every live override's mask; workspace changes refresh
   * the override's own names and rebuild its own mask (the deny set is the
   * difference, so an own-name change can widen or shrink the mask).
   */
  private onGeneration(serverName: string, scope: ScopeKey | undefined, change: GenerationNotification): void {
    if (scope === undefined) {
      if (change.status === 'registered') this.globalNames.set(serverName, change.names)
      else this.globalNames.delete(serverName)
      const byServer = this.overrides.get(serverName)
      if (byServer !== undefined) {
        for (const key of [...byServer.keys()]) this.commit(serverName, () => this.rebuildMask(serverName, key))
      }
      return
    }
    const record = this.overrides.get(serverName)?.get(scope)
    if (record === undefined || record.removed) return
    record.ownNames.clear()
    for (const name of change.names) record.ownNames.add(name)
    this.commit(serverName, () => this.rebuildMask(serverName, scope))
  }

  /**
   * Rebuild one override's mask from the current snapshots: dispose the old
   * mask first, then — in the same synchronous step, so no `await` boundary
   * lets the old global generation become visible — create the new
   * restriction when the deny set is non-empty. Without a tracked global
   * generation (or when the deny set is empty) no mask exists.
   */
  private rebuildMask(serverName: string, scopeKey: ScopeKey): void {
    const record = this.overrides.get(serverName)?.get(scopeKey)
    if (record === undefined || record.removed) return
    record.maskDisposer?.()
    record.maskDisposer = undefined
    record.maskError = undefined
    const global = this.globalNames.get(serverName)
    if (global === undefined || global.length === 0) return
    const deny = global.filter(name => !record.ownNames.has(name))
    if (deny.length === 0) return
    try {
      const tools = record.ctx.get('tools')
      /* v8 ignore next -- the manager's inject guarantees the registry exists for every live row */
      if (tools === undefined) {
        this.selfCtx.logger.error(
          `workspace-mcp(${serverName}): tool registry unavailable for workspace ${describeWorkspace(record.canonical)} — mask not applied`,
        )
        return
      }
      record.maskDisposer = tools.restrict({ deny })
    } catch (error) {
      record.maskError = error
      // The deny names must already be known on the workspace's inherited
      // surface; a failure here means the tracked global generation is out of
      // sync with the registry (e.g. a foreign registration squat), and the
      // workspace would leak the global namespace. Refuse to run unmasked.
      this.selfCtx.logger.error(
        `workspace-mcp(${serverName}): mask rebuild failed for workspace ${describeWorkspace(record.canonical)} — `
        + `global tools may leak into this workspace: ${String(error)}`,
      )
    }
  }

  /** Remove one workspace override: dispose its mask, drop records and reservation. */
  private removeOverride(serverName: string, scopeKey: ScopeKey): Promise<void> {
    const byServer = this.overrides.get(serverName)
    const record = byServer?.get(scopeKey)
    if (record === undefined || record.removed) return Promise.resolve()
    record.removed = true
    return this.commit(serverName, () => {
      record.maskDisposer?.()
      record.maskDisposer = undefined
      byServer!.delete(scopeKey)
      if (byServer!.size === 0) this.overrides.delete(serverName)
      const reserved = this.workspaceReserved.get(scopeKey)
      if (reserved !== undefined) {
        reserved.delete(serverName)
        if (reserved.size === 0) this.workspaceReserved.delete(scopeKey)
      }
    })
  }
}

/**
 * Resolve a workspace row's stdio `cwd` to an explicit absolute path. The
 * workspace root comes from the registry's canonical mapping — never from
 * `process.cwd()` or guessed path semantics. Only the empty string, the
 * literal `${workspaceRoot}` token, and absolute paths are accepted; any
 * other relative value is refused at load rather than resolved against a
 * guessed base.
 */
function resolveWorkspaceConfig(config: Config, canonical: string): Config {
  if (config.transport === 'streamable-http') return config
  let cwd: string
  if (config.cwd === '' || config.cwd === WORKSPACE_ROOT_TOKEN) {
    cwd = canonical
  } else if (isAbsolute(config.cwd)) {
    cwd = config.cwd
  } else {
    throw new Error(
      `workspace-mcp(${config.serverName}): relative cwd "${config.cwd}" is not allowed for a workspace row — `
      + `use "${WORKSPACE_ROOT_TOKEN}", an absolute path, or omit cwd to default to the workspace root`,
    )
  }
  return { ...config, cwd } satisfies StdioConfig
}
