# Workspace composition hot reload plan

Status: accepted implementation plan for the existing decorator-based architecture.

## 1. Objective

Add automatic live reload for each trusted workspace's top-level `<workspace>/.dsh/cordis.yml` while preserving the current out-of-tree architecture and public behavior.

The reload unit is the complete `WorkspaceTree` composition, not an MCP-specific row. Correctly effect-owned workspace contributions—tools, prompt sections, skills, commands, scoped listeners, MCP connections, and other workspace resources—must unload and remount together.

This work does not replace the official `AgentPresets` provider, migrate to a custom Agent provider, or implement preset-file watching.

## 2. User-visible semantics

### 2.1 Step boundary

A live Agent remains alive across a workspace reload. A model request already assembled or streaming keeps its frozen request header and tool schemas. The next model step runs `systemPrompt.assemble()` again and observes the current scoped registries.

A tool call generated from the old schema can race with removal and return `UNKNOWN_TOOL`. This matches the existing global composition HMR boundary and is accepted in v1; the reload controller does not drain arbitrary in-flight third-party operations.

### 2.2 Reload transaction

For one workspace:

```text
file add/change/unlink
  -> debounce
  -> serialize behind the workspace's current reload
  -> dispose the old WorkspaceTree subtree and await quiescence
  -> stat the top-level config
  -> absent: publish an empty workspace layer
  -> present: mount and audit a fresh WorkspaceTree subtree
  -> publish status
```

Reloads of different workspaces may run concurrently. Reloads of the same workspace never overlap. A change arriving during a reload schedules one following pass and coalesces additional changes.

### 2.3 Failure behavior

Initial acquire remains strict: if a trusted existing config fails to mount, `acquire()` rejects and leaves no cached workspace.

A live reload is recoverable:

- the old subtree has already been disposed;
- a failed new subtree is fully unwound;
- the workspace scope and live Agents remain alive;
- workspace contributions are temporarily absent;
- the failure is logged without dumping config, environment, or header values;
- the watcher remains active and retries after the next file event.

This deliberately follows the operational model of DSH global patch HMR instead of implementing a parallel candidate generation that may collide with the live composition.

### 2.4 File coverage

V1 watches only the exact top-level path:

```text
<canonical-workspace>/.dsh/cordis.yml
```

It reacts to add, change, and unlink, including editor atomic-save patterns. It does not automatically watch:

- preset `agent.cordis.yml` files;
- JavaScript or package modules imported by the workspace composition;
- nested included YAML files;
- the whole `.dsh` directory.

Touching or saving the top-level file triggers a complete remount after dependent files have been edited.

### 2.5 Trust and lifetime

`trustWorkspaceConfig: false` means no parse, import, mount, or watcher. The workspace remains an empty scoped layer.

The first lease creates the workspace runtime and watcher. The final lease release:

1. marks the entry disposed and removes it from lookup;
2. stops accepting watcher events;
3. cancels any pending debounce;
4. closes the watcher;
5. awaits the current reload chain;
6. disposes the workspace scope and all remaining child resources.

No watcher or timer survives the workspace entry.

## 3. Configuration

Extend `WorkspaceRegistryConfig`:

```ts
interface WorkspaceRegistryConfig {
  trustWorkspaceConfig: boolean
  watchWorkspaceConfig: boolean
  reloadDebounceMs: number
}
```

Defaults:

```ts
{
  trustWorkspaceConfig: true,
  watchWorkspaceConfig: true,
  reloadDebounceMs: 150,
}
```

Rules:

- `watchWorkspaceConfig` has no effect when trust is false.
- `reloadDebounceMs` is a non-negative finite integer with a documented upper bound compatible with Node timers.
- These options belong only to the `workspace-registry` provider row. The integration and MCP manager rows do not duplicate them.

## 4. Internal design

### 4.1 `WorkspaceReloadController`

Add a focused internal controller, owned by one `WorkspaceEntry`.

Responsibilities:

- create and close the chokidar watcher;
- accept only add/change/unlink events for the exact config path;
- debounce event bursts;
- serialize reload passes;
- coalesce events that arrive while reloading;
- stop, cancel, and quiesce idempotently;
- contain callback rejections so chokidar never creates an unhandled rejection;
- report lifecycle events through callbacks without owning Registry maps.

The controller accepts injected callbacks for `reload()` and diagnostics, allowing deterministic unit tests with a fake watcher boundary. It does not know Cordis, Agent, MCP, or preset semantics.

### 4.2 Registry-owned reload

`WorkspaceRegistry` remains the authority for:

- canonical identity;
- workspace scope;
- current `MountedWorkspaceTree`;
- `configured` status;
- watcher/controller lifetime;
- public debug snapshot.

The current composition field becomes mutable. A registry reload pass:

1. checks entry liveness;
2. disposes the current composition fiber and clears the field;
3. checks whether the config exists;
4. updates `configured`;
5. mounts a new tree when present and trusted;
6. increments a successful reload generation or records a failed status.

The workspace scope itself is not recreated during live reload, so Agent and preset parent keys remain stable.

### 4.3 Observability

Extend `WorkspaceInfo` with a read-only reload snapshot when watching is enabled:

```ts
interface WorkspaceReloadInfo {
  watching: boolean
  status: 'idle' | 'scheduled' | 'reloading' | 'failed' | 'stopped'
  successfulReloads: number
}
```

Do not expose raw error objects or config text through this debug API. Log diagnostics with canonical workspace identity and flattened error messages already produced by `WorkspaceMountError`; MCP/env/header values must not be logged.

A lease's `configured` field remains the creation-time snapshot for compatibility. Live state is read through `workspaceCordis.get(canonical)`.

### 4.4 Composition disposal

`MountedWorkspaceTree` must expose or retain an idempotent awaited disposer for its exact subtree. Reload uses that disposer rather than disposing the parent workspace scope. Final workspace disposal remains the final ownership boundary and may safely encounter an already-disposed former subtree.

## 5. Implementation blocks and commits

Each implementation block is delegated to `opencode-go/deepseek-v4-flash` with `max` reasoning. Subagents may edit files and run tests but must not commit. The main agent reviews, fixes, runs focused gates, and commits each block.

### Block A — watcher/reload controller

- Add chokidar runtime dependency.
- Implement the independent debounce/serialization/quiescence controller.
- Add fake-watcher unit tests for add/change/unlink, burst coalescing, event-during-reload, callback failure containment, and stop during pending/running work.
- No Registry behavior change yet.

Suggested commit: `feat: add workspace reload controller`

### Block B — Registry and WorkspaceTree integration

- Add Config fields/schema/defaults.
- Add exact subtree disposer to `MountedWorkspaceTree`.
- Make workspace composition/status mutable.
- Start one controller per trusted live entry.
- Implement strict initial mount and recoverable live reload.
- Ensure final release closes and drains the controller before scope disposal.
- Add deterministic Registry integration tests.

Suggested commit: `feat: reload workspace compositions`

### Block C — real filesystem and capability integration

- Add real chokidar tests with bounded waits.
- Verify add/change/unlink and editor-style atomic replacement.
- Verify live scoped tools or equivalent registry contributions change without replacing the workspace/Agent key.
- Verify workspace MCP process replacement, namespace mask rebuild, bad config recovery, and no child-process residue.
- Verify trust false creates no watcher and never imports.

Suggested commit: `test: cover live workspace reload`

### Block D — documentation, packaging, and final audit

- Update Chinese and English READMEs.
- Link this plan from both READMEs.
- Document step-boundary behavior, failure behavior, watched-file scope, and preset/import/include exclusions.
- Verify `pnpm pack`, built exports, isolated `DSH_HOME` bundle installation, final composition rows, and existing GUI health without changing the user's profile.
- Run the complete test/typecheck/build/audit gates and inspect for watcher/process residue.

Suggested commit: `docs: document workspace hot reload`

## 6. Test matrix

### Controller unit tests

- add/change/unlink schedule reload;
- unrelated path ignored;
- burst coalesces to one pass;
- event during reload produces exactly one following pass;
- reload rejection is contained and a later event retries;
- stop before debounce cancels work;
- stop during reload awaits settlement;
- repeated stop is idempotent;
- watcher error is logged without terminating the controller.

### Registry integration tests

- initial valid config remains strict and active;
- initial invalid config rejects acquire;
- valid -> valid replaces contributions and disposes old row once;
- valid -> invalid removes old contributions, reports failed, keeps scope/lease alive;
- invalid -> valid recovers on the next event;
- valid -> absent yields an empty workspace layer;
- absent -> valid mounts while the lease is live;
- multiple leases share one watcher/reload controller;
- final release closes watcher, cancels debounce, drains reload, and leaves no entry;
- trust false neither watches nor imports;
- two workspaces reload independently.

### Capability/e2e tests

- a live Agent or equivalent descendant scope sees changed workspace tools on the next assembly/view;
- workspace MCP row restart replaces its process and tools;
- global namespace masking remains correct after workspace MCP reload;
- broken MCP startup yields failed workspace reload without killing the Agent/workspace;
- fixing the file restarts the row successfully;
- no fixture MCP process, watcher, timer, tool, or restriction remains after final release.

## 7. Explicit non-goals

- Preset file watchers or automatic rebind of live Agents to a new preset generation.
- Imported module or nested include dependency tracking.
- Candidate/blue-green WorkspaceTree generations or preservation of the previous good tree after a failed reload.
- Draining arbitrary in-flight third-party tool executions before reload.
- HMR of the structural `workspace-agent-integration` or `workspace-mcp-manager` provider while live Agents exist.
- Support for synchronous `AgentLoop.create()` or direct factory bypasses.

## 8. Completion criteria

The feature is complete when editing, adding, deleting, or atomically replacing a live workspace's top-level `.dsh/cordis.yml` causes exactly one serialized composition reload after debounce; live Agents retain their workspace identity and observe the new scoped capabilities on subsequent steps; failures remain retryable without killing the workspace; final lease release leaves no watcher, timer, composition, tool, mask, or child process; all focused and complete gates pass against installed DSH rc.6 using only a repository-local isolated `DSH_HOME`.
