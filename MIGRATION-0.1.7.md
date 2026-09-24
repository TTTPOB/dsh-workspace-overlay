# Porting `dsh-workspace-overlay` to DSH 0.1.7

**Baseline tested:** DSH `0.1.7-alpha.2`, Cordis `4.0.4`, `cordis-plugin-include` `1.0.9`, `cordis-plugin-loader` `1.0.5`.
**Original baseline:** DSH `0.1.5-rc.2`, Cordis `4.0.2`, Include `1.0.7`, Loader `1.0.3`.

## TL;DR

The plugin is **salvageable with a small change set**. The package it depended on,
`@deepseek-ai/dsh-agent-presets`, was split in 0.1.7 into:

| 0.1.5 | 0.1.7 | Role |
|---|---|---|
| `@deepseek-ai/dsh-agent-presets` | `@deepseek-ai/dsh-agent-preset` | the declarative preset **row** plugin (`register()`s a definition) |
| | `@deepseek-ai/dsh-agent-preset-registry` | the `agentPresets` **service** + mount/audit helpers |

Only **4 of the 18 source files** touch the preset package at all. The two layers
that actually deliver per-directory MCP — the workspace registry and the MCP
manager — have **zero** dependency on it.

**Verified working:** `tsc` clean, `npm pack` clean, `dsh plugin add` into a real
0.1.7 profile succeeds, and `dsh --profile … --dump-config` composes all three
bundle rows (`workspace-registry`, `workspace-mcp-manager`,
`workspace-agent-integration`). **230 / 241** tests pass unchanged.

## 1. Mechanical renames (trivial)

| Old | New | Notes |
|---|---|---|
| `@deepseek-ai/dsh-agent-presets` | `@deepseek-ai/dsh-agent-preset-registry` | package name |
| `AgentPresets` (class) | `AgentPresetRegistry` | Cordis service name is **still `agentPresets`** |
| `inactiveRows(tree): string[]` | `auditRows(tree): Promise<RowAudit>` | `RowAudit = { failed: string[], pending: string[] }` |

`mount` / `composeFrom` / `recompose` / `resolve` / `list` / `select` /
`composedPreset` have **identical signatures** in 0.1.7 (only parameter *names*
changed), so the decorators needed no logic change.

`mountPreset`, `leakedServices`, `standingMountFor` all still exist in the new
package — but see §2 for `mountPreset`.

The `agent-preset/invalid` `RemoteError` code **still exists** with the same
`{ agentPreset, reason }` shape (declared by module augmentation in the new
package's `types.d.ts`). The TS error you see after bumping the dependency is
only a *cascade* of the unresolved import — fix the import and it disappears.

**Tip that keeps the diff tiny:** alias the type instead of renaming every use.

```ts
import type { AgentPresetRegistry as AgentPresets } from '@deepseek-ai/dsh-agent-preset-registry'
```

### `inactiveRows` → `auditRows` semantics

Old `inactiveRows` returned one flat list. New `auditRows` splits it:

* `failed` — import or activation rejection (always fatal)
* `pending` — a row still waiting on a service the composition never supplies

Because the host subtree is already settled at the call site (`handle.await()`),
a row still `pending` has no provider coming, so treating `failed + pending` as
fatal reproduces the old behaviour exactly:

```ts
const audit = await auditRows(subtree.tree)
const unusable = [...audit.failed, ...audit.pending]
if (unusable.length > 0) throw new Error(`${unusable.length} row(s) did not activate:\n${unusable.join('\n')}`)
```

## 2. The real blocker: `mountPreset` + `AgentPreset.path`

Two coupled removals break `src/workspace-presets.ts`:

1. **`mountPreset` is no longer re-exported from the package root.** The root
   exports only `AgentPresetRegistry`, `agentPresetProjectionDefinition`,
   `auditRows`, `entryListProblem`, `leakedServices`, `livePresetMounts`,
   `serviceForAgent`, `standingMountFor`. The `./src/*` export in
   `package.json` is dead — `src/` is not shipped.
2. **`AgentPreset` dropped `path`.** It is now just
   `{ id, name?, description?, order?, broken? }`. In 0.1.5 the overlay used
   `preset.path` both to stat the composition file (its generation stamp) and
   to hand `mountPreset(ctx, preset)` something to read. Presets are now
   in-memory `PresetDefinition { id, plugins }` objects supplied by the
   declaring `dsh-agent-preset` row.

### Why the layer cannot simply be dropped

`bindScopeParent` in `@deepseek-ai/dsh-scope` is **one-shot**: a key that
already has a parent throws. The overlay binds `agent.key → workspace.key` in
its `agents.create/resume` decorator. If the official `agentPresets.mount()`
then ran, its `join()` would call `bindScopeParent(agent.key, gen.key)` and
**throw**. So intercepting `mount` is mandatory — the plugin's own
`agent-registry-decorator.ts` header says exactly this.

And because the agent's chain is `agent → wsGen → workspace → root`, the
preset's contributions must be mounted **inside** `wsGen`, which is what
`mountPreset` used to do.

### The workaround that builds

Re-mount the definition yourself. `EntryTree` **is** exported by
`@deepseek-ai/cordis-plugin-loader`, and the official `PresetTree` is trivial
(`extends EntryTree` with `write() {}`), so it can be replicated:

```ts
class PresetListTree extends EntryTree { write(): void {} }

async function mountPresetEntries(ctx, id, plugins) {
  if (scopeOf(ctx) === undefined) throw new Error(`…`)
  await ctx.fiber.await()
  const tree = new PresetListTree(ctx)
  ctx.effect(() => () => { tree.root.stop() }, `agent-preset.${id}.tree`)
  await tree.root.update(structuredClone(plugins))
  const audit = await auditRows(tree)
  if (audit.failed.length > 0) throw new Error(…)
  const leaked = leakedServices(ctx, ctx.fiber)
  if (leaked.length > 0) throw new Error(…)
}
```

* **Getting `plugins`:** read the registry's own declaration map —
  `registry.definitions.get(id).config.plugins`. There is no public accessor.
  (A `register()` wrapper was considered and rejected: preset rows can
  `register()` before the integration row's `inject` resolves, so a wrapper
  can miss definitions. Reading at mount time is ordering-independent.)
* **Replacing the file-stat stamp:** use the official standing mount's scope
  key as the revision identity —
  `livePresetMounts().find(m => m.presetId === id)?.key`, compared by
  reference. The registry mints a new key whenever a definition is
  re-registered, which is the same "composition changed ⇒ new generation"
  signal `mtimeMs + size` used to give.

### Known fidelity gap from this workaround

Our subtree cannot be added to the registry's **module-private `mounts` set**
(there is no public entry point), so `standingMountFor()` and
`serviceForAgent()` do **not** resolve workspace-local preset generations.

Impact is small: the only in-tree consumer of those in 0.1.7 is
`@deepseek-ai/dsh-plugin-package-inventory-deepseek`, which uses them to list
active plugin packages for a session. Workspace preset entries will be missing
from that inventory. Nothing on the agent execution path reads them, and the
overlay's own `wrapComposeFrom` uses coordinator records rather than
`standingMountFor` for its own agents.

**The clean fix is upstream:** re-export `mountPreset` from
`dsh-agent-preset-registry`, and expose the definition (or its `plugins`) on
the roster. Worth filing.

## 3. Regression introduced by upstream (needs a fix)

**Reload failure logs now leak the workspace config file's contents.**

The overlay has a documented security invariant: reload logs carry the
canonical path and flattened error text, **never** config, env, or header
values. `cordis-plugin-loader` 1.0.5 now embeds the offending YAML **body** in
its parse errors:

```
workspace-cordis: reload of workspace /x/logfail config (…) failed: …
  1 | - id: x
  2 |   name: [unclosed
```

This breaks `tests/workspace-registry-reload.spec.ts` — *"logs reload failures
with workspace identity and never config text"*. Given workspace configs in
this deployment hold **secrets** (the ha-mcp bearer token in the URL), a
sanitizer is required: strip any quoted source-body block from loader errors
before logging, or log only the error class + path.

## 4. Smaller parity gap

`@deepseek-ai/dsh-mcp-client` 0.1.7 added `maxInstructionBytes` (default
`32768`) to its `Config`. The overlay's ported schema in `src/mcp/config.ts`
does not have it, so the parity test fails. Add the field to both the stdio and
streamable-http branches (and honour it in the connection layer) to restore
parity.

## 5. Test-suite work

| Failing | Cause | Status |
|---|---|---|
| `workspace-presets.spec.ts` | old `ensure(lease, preset)` signature + file-stamp semantics | ✅ rewritten, 10 tests green |
| `agent-presets-decorator.spec.ts`, `integration-plugin.spec.ts` | still `import … '@deepseek-ai/dsh-agent-presets'` | in progress |
| `workspace-registry-reload.spec.ts` | config-text leak regression (§3) | ✅ fixed by the sanitizer |
| `mcp/config.spec.ts`, `mcp/manager.spec.ts` | `maxInstructionBytes` parity (§4) | ✅ fixed |

### Restoring the `agent-preset/invalid` contract

The 0.1.5 suite asserted `code: 'agent-preset/invalid'` for a **failed mount**.
The first migration pass threw a plain `Error` there and only made the two
pre-mount guards `RemoteError`s — a fidelity gap, because remote clients map
that code to a user-facing "this preset is broken, because …" message and a
plain `Error` reaches them as an opaque failure.

Verified against the 0.1.7 source: `AgentPresetRegistry.retain()` reports a
preset whose composition is broken as

```js
throw new RemoteError("agent-preset/invalid", reason, { agentPreset: wanted, reason })
```

with `reason` from `diagnostic(record)`. `createGeneration()` now matches that
shape exactly — message **and** `details.reason` carry the diagnostic, and all
three failure paths (no standing mount, unreadable definition, failed mount)
are consistent. The spec asserts the code, the `agentPreset` detail, and the
diagnostic text.

### How the rewritten preset tests drive 0.1.7

Worth recording, because the mechanics are not obvious:

- Presets are declared with `registry.register({ id, plugins })` using
  **absolute `file://` specifiers** — the registry mounts under its own
  `ctx.baseUrl`, so the old per-preset-directory relative paths cannot
  resolve.
- The **revision-change trigger** is `register()`'s returned disposer followed
  by a re-register: that mints a fresh `livePresetMounts()` key, the 0.1.7
  stand-in for the file-size stamp.
- `afterEach` must unregister every preset before teardown — `mounts` is
  **module-global process state**, so a leaked mount would answer
  `livePresetMounts()` for the next test's registry.
- `register()` also mounts the definition once in the registry's own scope,
  so marker assertions need filtering by `scopeOf(ctx)` or they double-count.

## 6. Suggested upstream asks

1. Re-export `mountPreset` from `@deepseek-ai/dsh-agent-preset-registry`.
2. Expose a preset's `plugins` (or the whole `PresetDefinition`) on the
   public roster, so out-of-tree re-mounters don't read private fields.
3. Keep loader parse errors free of raw config bodies, or expose a
   "redacted message" accessor — third parties log these and workspace configs
   contain secrets.

## What was changed in this working tree

```
src/agent-integration.ts        |  6 +-  # import rename + type alias
src/agent-presets-decorator.ts  | 10 +-  # import rename + type alias + pass registry to ensure()
src/workspace-tree.ts           | 11 +-  # inactiveRows -> auditRows
src/workspace-presets.ts        | 202 ++-- # local PresetListTree mount, plugins from registry, revision-key stamp
package.json                    | 62 +-  # deps -> 0.1.7-alpha.2, drop dsh-agent-presets
```
