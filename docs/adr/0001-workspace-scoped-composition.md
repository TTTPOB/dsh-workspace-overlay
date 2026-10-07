# ADR 0001: Workspace-scoped composition as an out-of-tree bundle

- Status: Accepted
- Date: 2026-08-14

## Context

DSH composes configuration at two levels: a Host-wide profile tree (bundles, `cordis.patch.yml`, `--patch` overlays) and Agent-level presets. Both are resolved before any session exists, so neither can express "this project declares a service, and only sessions in this project see it".

The gap is most visible with MCP. A profile MCP row is one long-lived instance whose `cwd` and `env` are fixed at plugin load, whose tools register in the root `ctx.tools` layer, and which is therefore visible to every session in the Host regardless of `session.header.cwd`. DSH Web hosts concurrent sessions from unrelated workspaces, so a project-sensitive server can read or modify the wrong repository, and a project environment (virtualenv, direnv, database URL, credential) cannot be injected without leaking into unrelated sessions.

The same missing scope blocks workspace-owned environment overlays, LSP processes, code indexes, terminals, and file watchers. A separate fix per consumer would duplicate workspace identity, lifetime, reload, and disposal logic.

Prior art: OpenCode's server mode multiplexes directory-bound instances from a single process, merging global and project configuration per instance and keeping MCP, LSP, and tool state separate. The architectural lesson taken from it is the existence of a workspace runtime between the global server and individual sessions, not its configuration format.

## Decision

Provide workspace scope as an out-of-tree DSH bundle, `dsh-workspace-overlay`.

1. **Identity.** A workspace is `realpath(session.header.cwd)` — exact and normalized, with no Git-root or symlink-ancestor resolution. An unresolvable or unreadable cwd rejects Agent creation.
2. **Scope order.** `global → workspace → workspace-local preset → agent`. A workspace owns exactly one runtime and one set of workspace MCP processes, shared by all sessions and inherited subagents in that workspace.
3. **No Host environment mutation.** A workspace environment is a per-workspace snapshot applied at child-process spawn boundaries. The Host's `process.env` is never modified.
4. **Configuration.** A workspace is configured by `<workspace>/.dsh/cordis.yml`, using the same Cordis plugin-row dialect as preset composition.
5. **Lifetime.** The runtime is mounted on the first lease and disposed when the last lease is released, with an awaited, exact-subtree teardown.
6. **Trust.** `trustWorkspaceConfig` defaults to `true`, and only a profile that explicitly enables the bundle reads project configuration. Once enabled, `!!js` expressions and project plugin rows execute by default. Content-hash approval is deferred; `.envrc` does not inherit this trust.
7. **No core changes.** DSH and Cordis internals are not modified. Host integration goes through profile patch rows plus an `AgentRegistry` decorator and an `agentPresets` decorator; the official preset provider keeps ownership of discovery, settings, and authoring.

## Rejected alternatives

- **Retrofitting workspace scope onto profile composition.** Profile layers are resolved once at Host startup and shared by every session, so there is no Host-side value to key a project on.
- **Selecting a preset per workspace.** A preset is an Agent capability composition, not a workspace runtime: it is not discovered from `session.header.cwd`, is not shared as a canonical instance across a workspace's sessions, and does not derive MCP `cwd`/`env` from the workspace.
- **The narrower declarative schema proposed in the original RFC** (`<workspace>/.dsh/config.jsonc` limited to MCP-shaped fields). Rejected because workspace-local composition needs preset-level expressiveness, and maintaining a second, restricted dialect alongside Cordis rows would diverge over time.
- **Mutating `process.env` from `.envrc`.** Unbounded cross-session leakage: the last writer wins for every subsequently spawned Host service, and variable removal has no representation.
- **A per-consumer environment adapter.** Each of Bash, PTY, MCP, and LSP would independently need workspace-root resolution, trust state, caching, set/unset semantics, change detection, reload, and disposal.
- **Adding RPC, a remote protocol, or a Web API, and patching `@deepseek-ai/cordis`.** The capability is a local composition concern and does not need a wire protocol.

## Deferred, not rejected

`.envrc` execution and Bash/PTY/LSP environment injection; a full trust UI; a worktree/monorepo/symlink identity model beyond normalized absolute paths; `disabled: true`-only disabling of a global MCP row without a replacement instance; interruption-free transactional hot reload; exact restoration of workspace-local custom tool presenters for a cold session that does not resume its Agent.

## Consequences

- A project can declare workspace-local services without exposing them to sessions in other workspaces.
- Unrelated workspaces may use the same `serverName`; a workspace override shadows the whole inherited namespace of that name.
- Workspace configuration is project code, so enabling the bundle is a trust decision taken at profile level.
- Workspace runtime additions must be effect-owned, so that a hot reload or a final lease release leaves no watcher, timer, process, tool registration, or mask behind.

## References

- [Workspace composition implementation plan](../workspace-cordis-plan.md) — full design, phases, and acceptance matrix.
- [Workspace hot reload plan](../workspace-hot-reload-plan.md).
- [dsh-workspace-envrc ADR 0001](../../../dsh-workspace-envrc/docs/adr/0001-no-persistent-shell.md) — the sibling bundle's decision to leave persistent shells to the preset.
- [README](../../README.md) — current behavior and public API.
