# dsh-workspace-overlay

> **Languages / docs**: this is the English version of the project README; the Chinese original is [`../README.md`](../README.md). The implementation plan (in Chinese) is at [`workspace-cordis-plan.md`](./workspace-cordis-plan.md).

Out-of-tree DSH plugin that provides a shared Cordis scope (`workspaceCordis` service) per canonical workspace path. Every consumer of the same workspace (sessions, agents) leases the same scope; the scope is disposed when the last lease is released. Optionally, the first lease mounts `<workspace>/.dsh/cordis.yml` as that workspace's Cordis composition; the bundle also wires up Agent integration: `ctx.agents.create/resume` are wrapped with workspace binding, and decorators route the official `agentPresets` `mount`/`composeFrom`/`recompose` methods through workspace-local preset generations (see "Agent integration" below). The `./mcp` subpath provides the MCP core ported from the official rc.6 `@deepseek-ai/dsh-mcp-client` (transport / tool sync / connection supervisor), plus a workspace-aware MCP manager and plugin entry (global rows: one process per `serverName`; workspace overrides: one process per workspace; workspaces inheriting the global instance: zero extra processes; same-named namespaces are wholly shadowed — see "MCP manager").

Target DSH: `0.1.0-rc.6`. Runtime peers include `@deepseek-ai/cordis` 4.0.1, `@deepseek-ai/dsh-scope` 0.1.0-rc.6, `@deepseek-ai/cordis-plugin-include` 1.0.6, `@deepseek-ai/cordis-plugin-loader` 1.0.2, `@deepseek-ai/dsh-agent-presets` 0.1.0-rc.6, and the DSH service packages the code actually imports; all versions match the installed release. `@deepseek-ai/dsh-mcp-client` 0.1.0-rc.6 is a dev dependency only, used for Config parity tests.

## API (`./registry`)

- `WorkspaceRegistry extends Service`: default export; registered as `ctx.workspaceCordis` (so it does not clash with DSH Web's persistent workspace-entity service `ctx.workspaceRegistry`). `static inject = ['loader']`: the provider activates only when a Host Loader exists, and workspace scopes inherit the Host base so bare package specifiers resolve.
- `Config`: `trustWorkspaceConfig: boolean`, default `true` (whether `<workspace>/.dsh/cordis.yml` is trusted).
- `acquire(cwd)`: `cwd` must be an absolute path to an existing directory; the canonical identity is `realpath(resolve(cwd))` (symlinks normalized). The same canonical path shares one entry via a Map + single-flight; concurrent acquires mount only once; failures leave no cached state and are retryable.
- On first entry creation: `<root>/.dsh/cordis.yml` missing → empty workspace scope (inherits global, starts nothing); present and `trustWorkspaceConfig` → the composition is mounted and `acquire` resolves only after every row is usable; present but `trust=false` → stat only, never read/parse/import, yet an empty scope is still established.
- lease: `key` (opaque `ScopeKey`), `ctx` (scope-owned context), `canonical`, `trustWorkspaceConfig`, `configured`, `composition` (`{ path, active }`, present only when mounted); `release()` is idempotent, and the last release `await scope.dispose()` and removes the entry from the Map — the composition subtree is owned by the scope and is fully unwound by the scope dispose (including effect disposers, such as the fixtures').
- `size` / `get(canonical)`: read-only debug views including the `configured` and `composition` state.

## Mount semantics (`./workspace-tree`)

- `WorkspaceTree extends Include`: the config file is fixed at `<canonical>/.dsh/cordis.yml`; `write()` is a no-op (a workspace config is an input; Loader teardown never writes it back).
- Specifier resolution matches the official `PresetTree`: `./`/`../` resolve against the `.dsh` directory; absolute paths become file URLs; bare package names resolve from the Host dependency tree via the pre-mount captured Host base + `ctx.loader.internal.import` (no reading of arbitrary workspace `node_modules`).
- `mountWorkspaceTree(scopeCtx, workspace)`: after `await handle.await()`, reuses the `inactiveRows` / `leakedServices` exports of `@deepseek-ai/dsh-agent-presets` to audit the mount — rows that never activated or are missing injects are rejected, and rows that publish a service into the root realm are rejected (publishing inside an isolate realm is legal). On failure the subtree is disposed and a `WorkspaceMountError` is thrown (carrying the workspace path).
- No chokidar / live reload: this round only performs the initial mount and a full dispose; config hot reload (watcher, quiescent generation switching) is left for later.

## Installation (bundle)

```sh
dsh plugin --profile web add /path/to/dsh-workspace-overlay
```

The package's `dsh.bundle.patch` (`cordis.patch.yml`) inserts three rows: `workspace-registry` (`workspaceCordis` provider), `workspace-mcp-manager` (`workspaceMcp` provider) and `workspace-agent-integration` (`dsh-workspace-overlay/integration-plugin`, AgentRegistry + agentPresets decorator wiring, see below). The manager row configures no default MCP servers: global MCP rows are added by profile patch as needed (see the "MCP manager" example), and workspace MCP rows are written into each workspace's `.dsh/cordis.yml`.

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
