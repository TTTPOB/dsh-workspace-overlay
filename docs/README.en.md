# dsh-workspace-overlay

> **Languages / docs**: this is the English version of the project README; the Chinese original is [`../README.md`](../README.md). The implementation plans (in Chinese) are at [`workspace-cordis-plan.md`](./workspace-cordis-plan.md) and [`workspace-hot-reload-plan.md`](./workspace-hot-reload-plan.md) (workspace composition hot reload, status: implemented).

Out-of-tree DSH plugin that provides a shared Cordis scope (`workspaceCordis` service) per canonical workspace path. Every consumer of the same workspace (sessions, agents) leases the same scope; the scope is disposed when the last lease is released. Optionally, the first lease mounts `<workspace>/.dsh/cordis.yml` as that workspace's Cordis composition and, by default, watches that top-level config file — editing and saving it hot-reloads the whole composition (see "Workspace hot reload"); the bundle also wires up Agent integration: `ctx.agents.create/resume` are wrapped with workspace binding, and decorators route the official `agentPresets` `mount`/`composeFrom`/`recompose` methods through workspace-local preset generations (see "Agent integration" below). The `./mcp` subpath provides the MCP core ported from the official rc.6 `@deepseek-ai/dsh-mcp-client` (transport / tool sync / connection supervisor), plus a workspace-aware MCP manager and plugin entry (global rows: one process per `serverName`; workspace overrides: one process per workspace; workspaces inheriting the global instance: zero extra processes; same-named namespaces are wholly shadowed — see "MCP manager").

Target DSH: `0.1.0-rc.6`. Runtime peers include `@deepseek-ai/cordis` 4.0.1, `@deepseek-ai/dsh-scope` 0.1.0-rc.6, `@deepseek-ai/cordis-plugin-include` 1.0.6, `@deepseek-ai/cordis-plugin-loader` 1.0.2, `@deepseek-ai/dsh-agent-presets` 0.1.0-rc.6, and the DSH service packages the code actually imports; all versions match the installed release. `@deepseek-ai/dsh-mcp-client` 0.1.0-rc.6 is a dev dependency only, used for Config parity tests.

## API (`./registry`)

- `WorkspaceRegistry extends Service`: default export; registered as `ctx.workspaceCordis` (so it does not clash with DSH Web's persistent workspace-entity service `ctx.workspaceRegistry`). `static inject = ['loader']`: the provider activates only when a Host Loader exists, and workspace scopes inherit the Host base so bare package specifiers resolve.
- `Config`: `trustWorkspaceConfig: boolean`, default `true` (whether `<workspace>/.dsh/cordis.yml` is trusted); `watchWorkspaceConfig: boolean`, default `true` (whether to watch that file and hot-reload the composition on changes; no effect when trust is disabled); `reloadDebounceMs: number`, default `150` (debounce window in milliseconds for file-event bursts; a non-negative finite integer, upper-bounded by `MAX_TIMER_DELAY_MS`).
- `acquire(cwd)`: `cwd` must be an absolute path to an existing directory; the canonical identity is `realpath(resolve(cwd))` (symlinks normalized). The same canonical path shares one entry via a Map + single-flight; concurrent acquires mount only once; failures leave no cached state and are retryable.
- On first entry creation: `<root>/.dsh/cordis.yml` missing → empty workspace scope (inherits global, starts nothing); present and `trustWorkspaceConfig` → the composition is mounted and `acquire` resolves only after every row is usable; present but `trust=false` → stat only, never read/parse/import, yet an empty scope is still established. With watching enabled, the initial stat/mount runs after the watcher reports `ready`, and a watcher that fails during startup rejects `acquire`.
- lease: `key` (opaque `ScopeKey`), `ctx` (scope-owned context), `canonical`, `trustWorkspaceConfig`, `configured` (**a creation-time snapshot** — read the live state through `get(canonical)`), `composition` (`{ path, active }`, present only when mounted); `release()` is idempotent, and the last release first removes the entry from the Map, stops the watcher, cancels debounce, closes and drains the reload controller, then `await scope.dispose()` — the current composition subtree is owned by the scope and is fully unwound by the scope dispose (including effect disposers, such as the fixtures').
- `size` / `get(canonical)`: read-only debug views including the live `configured` and `composition` state, plus the `reload` snapshot when watching is enabled (`{ watching, status, successfulReloads }` with `status` ∈ `starting`/`idle`/`scheduled`/`reloading`/`failed`/`stopped`; the debug API never exposes raw error objects or config text).
- `./workspace-reload-controller` export: `WorkspaceReloadController` (a watcher + debounce + serialized reload controller for one top-level config file) and the `WorkspaceReloadStatus`/`WorkspaceReloadSnapshot`/`WorkspaceWatcher`/`WorkspaceTimer` types; deliberately framework-free (it knows nothing of Cordis, Agent, MCP, or presets), with injectable reload callbacks, watch factory, and timer for deterministic fake-watcher tests; the default factory is chokidar v4.

## Mount semantics (`./workspace-tree`)

- `WorkspaceTree extends Include`: the config file is fixed at `<canonical>/.dsh/cordis.yml`; `write()` is a no-op (a workspace config is an input; Loader teardown never writes it back).
- Specifier resolution matches the official `PresetTree`: `./`/`../` resolve against the `.dsh` directory; absolute paths become file URLs; bare package names resolve from the Host dependency tree via the pre-mount captured Host base + `ctx.loader.internal.import` (no reading of arbitrary workspace `node_modules`).
- `mountWorkspaceTree(scopeCtx, workspace)`: after `await handle.await()`, reuses the `inactiveRows` / `leakedServices` exports of `@deepseek-ai/dsh-agent-presets` to audit the mount — rows that never activated or are missing injects are rejected, and rows that publish a service into the root realm are rejected (publishing inside an isolate realm is legal). On failure the subtree is disposed and a `WorkspaceMountError` is thrown (carrying the workspace path).
- `MountedWorkspaceTree.dispose()`: an idempotent, awaited exact-subtree disposer — it tears down only that subtree (which is what live reload uses to swap the whole tree) while the workspace scope and its other children survive; the scope's final dispose remains the fallback owner and safely tolerates an already-disposed subtree. Watcher and hot-reload semantics are described in the "Workspace hot reload" section.

## Workspace hot reload (`./workspace-reload-controller`)

By default (`watchWorkspaceConfig: true`), every live entry owns exactly one reload controller that watches — and only watches — the top-level `<canonical>/.dsh/cordis.yml` (`add` / `change` / `unlink`, including editor atomic-save rename patterns):

- **Watch anchor**: the watcher is attached to the canonical workspace root (a directory that is guaranteed to exist at acquire time) rather than to the config path itself — chokidar v4 cannot reliably report a nested path that appears after watching started, and `.dsh/` may not exist yet at acquire; the controller still accepts only exact-config-path events. A `depth: 2` cap plus an `ignored` predicate keep the scan/watch scope to the anchor, `.dsh`, and the config file itself — it never recurses into the rest of the project tree, and it never creates `.dsh` inside the user's workspace just to watch.
- **Readiness**: the registry awaits the controller's `ready` (watcher ready) before its strict initial stat/mount, so a watcher that errors during startup rejects `acquire`; events that arrive before `ready` only mark the controller dirty, and `activate()` replays them as exactly one reconcile pass — the pass re-stats the file and skips the mount when nothing observably changed (same mtime/size/inode), avoiding a pointless second mount.
- **Reload transaction**: file-event bursts are debounced (default 150 ms), then the pass for one workspace is strictly serialized — events arriving while a pass runs are coalesced into exactly one following pass, so continuous edits keep catching up — while reloads of different workspaces run in parallel. A pass disposes the old `MountedWorkspaceTree` subtree and awaits quiescence, then re-stats the top-level file: missing → publish the empty workspace layer; present → mount and audit a fresh subtree. Because the whole tree is replaced, every correctly effect-owned workspace contribution — tools, prompt sections, skills, commands, scoped listeners, MCP connections, and other resources — unloads and remounts together; there is never a half-old/half-new composition.
- **Step boundary**: a live Agent stays alive across a reload. A model request already assembled or streaming keeps its frozen request header and tool schemas; the next model step runs `systemPrompt.assemble()` again and observes the current scoped registries. A tool call generated from the old schema can race with removal and return `UNKNOWN_TOOL` (the same boundary as the global composition HMR; v1 does not drain arbitrary in-flight third-party tool calls).
- **Failure semantics**: the initial mount stays strict (`acquire()` rejects and leaves nothing cached); a live reload is recoverable — the old subtree is already disposed, a failed new subtree is fully unwound, the workspace scope/lease/Agents all stay alive, workspace contributions are temporarily absent (an MCP row exits its process and lifts its mask), the status becomes `failed`, and the log carries only the canonical path and flattened error messages (never config, env, or header values); the next file event retries.
- **MCP interaction**: a workspace MCP row is replaced wholesale on reload — the old process exits, a fresh one starts with the workspace's own cwd/env, and the mask over the global same-named namespace is rebuilt on the serial commit chain. One mask rebuild installs the replacement restriction before removing the old restriction; however, the full WorkspaceTree reload first unloads the old row and mask and creates the new mask only after the fresh connection is ready, so the workspace may briefly inherit the global same-named namespace in between. A broken MCP startup fails the reload without killing the Agent/workspace, and fixing the file recovers on the next event.
- **Final lease**: the last lease release marks the entry disposed and removes it from lookup, then stops the controller — reject new events → cancel any pending debounce → close the watcher → drain the running pass (it may finish but never starts a following pass) — before `scope.dispose()`; no watcher, timer, composition, tool, mask, or child process survives. The registry's fiber unload (provider HMR / Host teardown) takes the same path for every live entry.
- **trust=false / watch=false**: with `trustWorkspaceConfig: false` there is no parse, import, mount, or watcher — still an empty scoped layer; with `watchWorkspaceConfig: false` the workspace is mounted once and later file changes produce no reaction.

### Explicitly not watched / not done (limitations)

- No preset `agent.cordis.yml` watchers, and no automatic rebind of live Agents to a new preset generation.
- No watching of JavaScript/package modules imported by the composition, no watching of nested included YAML, and no dependency tracking of either — after editing a dependency, touch or re-save the top-level `cordis.yml` to trigger one complete remount (the top-level file is the reload unit).
- No draining of arbitrary in-flight third-party tool executions, and no extra mount timeout around third-party row `apply()` / dispose lifecycles; a permanently pending third-party lifecycle leaves the current reload and final lease release waiting for it to settle.
- No blue-green: no parallel candidate tree is generated, and the previous good tree is not preserved after a failed reload (consistent with the DSH global patch HMR operating model).
- No live HMR of the structural `workspace-agent-integration` / `workspace-mcp-manager` providers themselves (same level as the decorators; developing them requires disposing all live Agents or restarting the Host).

The detailed design, readiness details, and the full test matrix are in [`workspace-hot-reload-plan.md`](./workspace-hot-reload-plan.md).

## Installation (bundle)

```sh
dsh plugin --profile web add /path/to/dsh-workspace-overlay
```

The package's `dsh.bundle.patch` (`cordis.patch.yml`) inserts three rows: `workspace-registry` (`workspaceCordis` provider), `workspace-mcp-manager` (`workspaceMcp` provider) and `workspace-agent-integration` (`dsh-workspace-overlay/integration-plugin`, AgentRegistry + agentPresets decorator wiring, see below). The `workspace-registry` row's patch config states `trustWorkspaceConfig: true` / `watchWorkspaceConfig: true` / `reloadDebounceMs: 150` explicitly — a patch row replaces the target row's whole config, so stating the deployed values (which match the schema defaults) keeps them visible in `dsh --dump-config`. The manager row configures no default MCP servers: global MCP rows are added by profile patch as needed (see the "MCP manager" example), and workspace MCP rows are written into each workspace's `.dsh/cordis.yml`.

## MCP core (`./mcp` subpath)

`src/mcp/` is the MCP core ported from the official rc.6 `@deepseek-ai/dsh-mcp-client` (MIT, Copyright (c) 2026 DeepSeek — see the `deepseek-harness` repository), verified against the installed rc.6 `lib/types/*.d.ts` and `lib/index.js` bundle behavior; the package retains the MIT source attribution comments:

- `./mcp/types`: public types — the discriminated union `Config` (`stdio` / `streamable-http`), `serverName`, `toolCallTimeoutMs`, `failOnStartupError`, the `reconnect` policy, `McpResult`, `ConnectionHandle`, etc.
- `./mcp/config`: the Schemastery `Config` schema (defaults match the official ones: `toolCallTimeoutMs=60000`, `failOnStartupError=false`, `reconnect` defaults to `{enabled:true, initialDelayMs:500, maxDelayMs:30000, maxAttempts:10}`).
- `./mcp/transport`: `createTransport(config)`. stdio builds on `dsh-subprocess`'s `scrubbedParentEnv()` and merges the explicit `env`, spawns via argv (SDK `shell:false`), and supports `cwd`; streamable-http passes URL/headers. No path ever logs env/header values.
- `./mcp/tools`: `publicToolName` (`mcp__<serverName>__<rawName>`; overlong/illegal names get a 12-hex-char SHA-256 identity hash appended, with known-answer values derived from the installed rc.6 bundle), paginated `listTools`, transactional two-phase `syncTools` (a fetch failure keeps the previous good generation; a swap conflict rolls the whole generation back), `callTool` timeout/cancellation, and `McpResult` mapping (including `isError` → throw, legacy `toolResult`, content block projection).
- `./mcp/connection`: `RECONNECT_DEFAULTS`, `resolveReconnectPolicy` (reusing `MAX_TIMER_DELAY_MS`), and the `startConnection` supervisor — startup failure strategy, re-sync on `list_changed`, exponential backoff with an attempt budget (the stability window resets the budget), and a dispose that closes the client/transport and waits for tool unregistration, leaving no child processes behind.
- `./mcp`: an entry isomorphic with the official `name`/`inject`/`Config`/`apply` (including the `serverName` reservation), kept for standalone global use with official semantics; workspace-aware rows always go through `./mcp/workspace-client`.

Two intentional differences from official rc.6 (both commented in the source):

1. **Input schema assertion**: the fetch phase runs `assertSupportedJsonSchema` on `tool.inputSchema`; an unsupported vocabulary fails that whole sync (keeping the previous good generation). The official code only asserts the output schema (falling back to `JsonValue` when unsupported) and passes input schemas through.
2. **Generation-change notification**: `ToolBridgeOptions.onGeneration({serverName, names, status})` and `startConnection(ctx, config, policy, onGeneration?)` notify synchronously after each committed generation change (registration success / whole-generation rollback / give-up / dispose); the workspace manager consumes the notifications to maintain the global/own name sets and rebuild masks (next section).

Dependency strategy: `@modelcontextprotocol/sdk` and `zod` are pure SDKs and live in `dependencies`; `@deepseek-ai/dsh-tools`, `dsh-subprocess` and `dsh-timeout` involve Host singletons or runtime APIs and are declared as `peerDependencies` + `devDependencies` (versions matching the installed rc.6). `@deepseek-ai/dsh-mcp-client` is a dev dependency only, used for Config parity tests; the ported code never imports it at runtime.

**Wired-in manager / bundle**: `cordis.patch.yml` adds the `workspace-mcp-manager` provider row (`workspaceMcp` service), but **inserts no MCP server by default** — there are no default servers, so enabling the bundle starts no MCP processes. Global and workspace MCP rows are both declared through the same entry `dsh-workspace-overlay/mcp/workspace-client`, and the manager decides the semantics from the row's scope. Per-workspace MCP server orchestration (process model, `tools.restrict` mask, lifecycle) is described in the next section.

## MCP manager (`./mcp/manager` + `./mcp/workspace-client`)

`./mcp/manager` is the `workspaceMcp` service (default-exported `Service` subclass, `static inject = ['tools', 'workspaceCordis']`); `./mcp/workspace-client` is a named-export function plugin (no default export) that reuses the current MCP `Config` schema, declares `inject = ['tools', 'workspaceMcp']`, and whose `apply` only hands the row config to `manager.activate(rowCtx, config)`.

### Process count contract

- **Global rows** (`workspace-client` rows in the host composition): one process per `serverName`, shared by the whole app.
- **Workspace override rows** (same-named `workspace-client` rows in `<workspace>/.dsh/cordis.yml`): one process per workspace, using that workspace's own cwd/env.
- **Inheriting workspaces** (no same-named override): zero extra processes; they keep using the global instance.
- Multiple Agents / multiple leases of the same workspace share that workspace's entry and this one process (the composition mounts once per workspace).

For example, global `a` + ws1/ws2 overrides of `a` + ws3 inheriting = **3 processes**. Disposing ws1 does not affect the global instance or ws2; when the workspace scope is finally released, its MCP process closes with the row fiber.

### Whole-namespace masking (mask)

When a workspace declares a `serverName`, the entire inherited global `mcp__<serverName>__*` namespace is shadowed — there is no mixed view of "own tools + leftover global tools"; other global namespaces are unaffected. The implementation is a `ctx.tools.restrict({ deny })` on the workspace scope, with `deny = current global full public names − the workspace's own registered names`. The subtraction is required by the rc.6 `view()` semantics: a restriction filters every name on the inherited surface, while tools registered in the workspace's own layer are exempt only for that scope's own view — to an Agent under the workspace (a descendant scope) they still count as inherited, so including them in `deny` would hide the workspace's own tools from its Agents; the subtracted names are shadowed naturally by the workspace's own registrations, which is exactly "replacement".

The manager maintains full name sets from the generation notifications of every connection (global and workspace alike); when a global generation swaps, gives up or disposes, or a workspace's own tool list changes (`list_changed`), it rebuilds the masks of all live workspace overrides of that `serverName` on their per-namespace serial commit chain. The replacement restriction is installed before the old one is disposed, in the same synchronous step; a failed rebuild keeps the last good mask, and there is no window between awaits where the mask is fully lifted. A workspace override with no global generation needs no mask. `restrict()` requires a scoped ctx and deny names already known on the inherited surface — both are guaranteed by the "register first, build the mask later" ordering.

### Lifecycle and failure semantics

- The manager never holds a workspace lease of its own; the row fiber is held by the workspace scope through the composition. Last agent lease release → workspace scope dispose → the row fiber's effects in sequence: `await connection.dispose()` (close the process, unregister tools) → remove override/mask/reservation.
- **Workspace rows must set `failOnStartupError: true`**, otherwise the row fails explicitly at load; an initial connection/sync failure rejects the whole workspace composition mount and `acquire()` throws — no Agent is ever published on a bad server. After a failure, reservation/mask/process are all rolled back; fix `.dsh/cordis.yml` and retry.
- **Live reload**: a workspace row is replaced wholesale when the top-level config hot-reloads — the old row fiber's effects run `await connection.dispose()` (close the process, unregister tools) before removing override/mask/reservation, and the new row mounts from the current file content and rebuilds the mask; the reload-time failure/recovery semantics are in the "Workspace hot reload" section.
- A duplicate `serverName` within the same scope (global or one workspace) fails at load; the same name across workspaces is allowed. One reservation per (scope, serverName).

### cwd and safety

- Workspace stdio row `cwd`: `''` or the literal `'${workspaceRoot}'` → the canonical workspace root (resolved through the registry's `workspaceForScope`, never guessing `process.cwd()`); absolute paths are used as-is; any other relative path is rejected at load. Global rows keep the official cwd semantics.
- The child process env reuses the official `scrubbedParentEnv()` (credential-shaped and stale `DSH_*` names stripped) and then merges the row's explicit `env`; logs/errors contain only the serverName, scope kind, and workspace basename + path hash — never env/header values.

### Same-name rules with the official `@deepseek-ai/dsh-mcp-client`

The official plugin keeps `serverName` in its own module-level reservation (the manager cannot share it):

- **Do not** declare the **same `serverName` as a global row** in both the official form and a `workspace-client` row within one profile: both would register same-named tools to the global layer, and the latter fails safely on the registration conflict (the row load fails with `failOnStartupError: true`; otherwise the whole generation rolls back and is logged) — but this is a configuration error.
- Official global row + manager workspace override: the workspace row shadows the same-named global tools, but the manager does not know the official global's name set and will **not** build a mask — unshadowed global tools leak in, forming a mixed view. Global rows that you intend to be overridden must also be managed through the `workspace-client` entry.

### YAML examples

Global row (the profile's `cordis.patch.yml`):

```yaml
- insert:
    - id: global-db-mcp
      name: dsh-workspace-overlay/mcp/workspace-client
      config:
        serverName: db
        transport: stdio
        command: my-db-mcp
        args: []
        cwd: ''
        failOnStartupError: true
```

Workspace row (`<workspace>/.dsh/cordis.yml`):

```yaml
- id: ws-db-mcp
  name: dsh-workspace-overlay/mcp/workspace-client
  config:
    serverName: db
    transport: stdio
    command: my-db-mcp
    args: []
    cwd: '${workspaceRoot}'
    env:
      DATABASE_URL: 'postgres://localhost/a'
    failOnStartupError: true
```

### Support boundaries

- Only scope-aware registry/event contributions are supported (tool registration and `tools.restrict` masks); an MCP row's `isolate`/root-service publication is rejected by the mount audit.
- No promise of live HMR for the manager provider row itself while workspace rows are live (it is a startup-structure plugin at the same level as the decorators); workspace rows dispose normally with their workspace scope.
- streamable-http rows are equally supported (no cwd semantics); workspace rows equally enforce `failOnStartupError: true`.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`dist/` is built by `tsc`; the built-entry smoke test verifies that the package name resolves in the target installed DSH's profile dependency tree. Tests bootstrap through real Loader composition: relative specifiers, bare specifiers (vitest has no Node internal loader, so tests record routing with a stub resolver and load real fixture packages), the mount audit, trust, single-flight, failure retry and dispose are all covered (fixture plugins under `tests/fixtures/plugins/` are imported through the Node internal loader, and tests observe their state via `globalThis`). MCP core tests (`tests/mcp/`) cover: known-answer naming (derived against the installed rc.6 bundle), duplicate/illegal schemas, pagination, `list_changed` good-generation replacement and failure keeping the old generation, stdio env scrub/cwd (canary secrets must not leak), startup failure true/false, reconnect/give-up, call timeout/cancel, dispose closing the child process and unregistering tools, and streamable-http end-to-end (server-side header assertions); the fixture server (`tests/fixtures/mcp/fixture-server.ts`) is spawned and disposed within each test process's lifecycle — no long-lived background jobs. MCP manager tests cover the mock-SDK state machine (`manager.spec.ts` — same-scope duplicate reservation / cross-workspace allowed, workspace rows enforcing `failOnStartupError`, cwd resolution, real ScopedLayers mask semantics (global a t1..t5 + ws a t1..t3 + global b → the ws view is only a t1..t3 with b kept), global generation swap rebuild / clear-on-release, own-list change rebuild, startup rollback and teardown) and the real composition + fixture process (`manager-integration.spec.ts` — global a + ws1/ws2 overrides + ws3 inheriting = 3 processes, two leases of one workspace sharing one process, `cwd:''` / `${workspaceRoot}` end-to-end, a bad server blocking `acquire` with fix-and-retry, and logs without canary secrets).

Workspace hot reload adds four more suites: deterministic fake-watcher Registry integration (`workspace-registry-reload.spec.ts` — strict initial mount behind the watcher readiness gate, valid→valid/invalid/absent in every direction, invalid leaving the scope/lease alive with recovery on the next event, multiple leases of one workspace sharing one watcher, final-release convergence, trust/watch=false); the real filesystem with real chokidar and temp directories (`workspace-live-reload.spec.ts` — change / atomic rename / unlink→add, a config created only after `.dsh` appears, two workspaces reloading independently, no reaction to writes after release, and no `.dsh` created inside the user workspace); live capability views (`workspace-tools-live.spec.ts` — the next `tools.schemas()` view observes the new tool surface without replacing the workspace/Agent keys, an invalid config temporarily empties the workspace's tool surface and fixing the file restores it); and MCP live reload (`tests/mcp/manager-live-reload.spec.ts` — reload replacing the workspace MCP process and tools while the global mask stays correct, a broken server failing the reload while the scope/lease stay alive and recovering after a fix, and no process/tool/mask residue after the final release).

## Agent integration (enabled in the bundle)

`cordis.patch.yml` inserts three rows: `workspace-registry` (provider), `workspace-mcp-manager` (provider) and `workspace-agent-integration` (`dsh-workspace-overlay/integration-plugin`). The official `agent-presets` row stays untouched; the integration row waits via `inject = ['agents', 'agentPresets', 'workspaceCordis']` until all three services are ready, then reversibly wraps the provider-owned `ctx.agents.create/resume` and `ctx.agentPresets.mount/composeFrom/recompose` (sharing one `AgentBindingCoordinator` and one `WorkspacePresetRegistry`; dispose restores all five method descriptors in reverse order).

### Supported agent creation entry points

- **Web and every consumer of the public async `ctx.agents.create/resume`** (ACP, SDK/headless, in-process subagent driver): the combined setup first `acquire(cwd)` then `bind(agentKey, lease.key)`; afterwards the official `agentPresets.mount` inside the caller's setup is taken over by the decorator: resolve + broken check → ensure a workspace-local preset generation keyed by `(workspace, preset, file stat stamp)` (the official `mountPreset()` mounted under a `createScope(lease.ctx, genKey, { parent: lease.key })`; multiple Agents of the same workspace share one generation, a stamp change mints a new generation, and an old superseded generation is disposed when its joined count reaches zero) → rebind the agent to the generation key and balance the joined counts. A subagent's synchronous `composeFrom` inherits the parent's exact generation (no I/O, no remount; a parent without a record in this coordinator stays rosterless unless it holds an official standing mount, in which case inheritance is rejected, and a cross-workspace parent is explicitly rejected); blank-session `recompose` likewise switches generation within the workspace.
- The agent's direct parent is the generation key registered by `mountPreset()`, so the official `standingMountFor()` / `composedPreset()` / `serviceFor()` resolve `agent → workspace-local preset` without any wrapping (proven by the integration tests).
- The agent scope's effect disposer uniformly goes through `coordinator.unbind()`: leave the preset generation first, then release the workspace lease.

### Explicitly unsupported paths

- **Synchronous bypass**: `AgentLoop.create(id, options, meta)` and direct-factory `createAgent/resume` have no awaited setup seam and get no workspace binding — profiles enabling this bundle must not contain config-driven synchronous Agent entries.
- **Live HMR of the decorators themselves**: decorators are startup-structure plugins; developing them requires disposing all live Agents or restarting the Host. Host teardown and a fiber dispose without live Agents fully restore the five methods and clean the registry (tested).
- **Cold transcript resume**: `standingKeyFor()` keeps going through the official global standing, without a workspace parameter.
