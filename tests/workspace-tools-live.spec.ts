/**
 * Live scope-aware tool capability tests.
 *
 * A workspace composition row (the `tool-contribute.js` fixture) registers a
 * tool into the workspace layer through the real ToolRuntime + SystemPrompt
 * composition. The tests prove that live reloads swap the workspace's tools
 * WITHOUT replacing the workspace scope key or a live descendant
 * (Agent-like) scope: the same keys observe the new tool surface on the next
 * `ctx.tools.schemas()` view, an invalid config temporarily empties the
 * workspace's tool surface while the scope and lease stay alive, and fixing
 * the file restores a new tool. No LLM or API is involved — only the real
 * tool registry views.
 */
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope, scopeOf, scopeParentOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rm, writeFile } from 'node:fs/promises'
import {
  harness,
  makeWorkspace,
  seedPlugins,
  teardown,
  writeConfig,
  type Harness,
} from './helpers.js'

const DEBOUNCE_MS = 50

/** A one-row composition whose single row registers one workspace tool. */
function toolRow(toolName: string, marker: string): string {
  return [
    '- id: tool',
    '  name: ./plugins/tool-contribute.js',
    '  config:',
    `    toolName: ${toolName}`,
    `    marker: ${marker}`,
    '',
  ].join('\n')
}

/** Every public tool name one scope views, sorted. */
async function viewNames(scopeCtx: import('@deepseek-ai/cordis').Context, scope: ScopeKey | undefined): Promise<string[]> {
  const viewer = await scopeCtx.plugin({ name: 'viewer', inject: ['tools'], apply() {} })
  try {
    return viewer.ctx.tools.schemas(scope).map(schema => schema.name).sort()
  } finally {
    await viewer.dispose()
  }
}

let host: Harness

beforeEach(async () => {
  host = await harness({ reloadDebounceMs: DEBOUNCE_MS })
  await host.ctx.plugin(SystemPrompt)
  await host.ctx.plugin(ToolRuntime)
})

afterEach(async () => {
  await teardown(host)
})

describe('live workspace tools', () => {
  it('replaces workspace tools on a valid->valid reload while workspace and descendant keys stay identical', async () => {
    const ws = await makeWorkspace(host.root, 'tools')
    await seedPlugins(ws, ['tool-contribute.js'])
    const configPath = await writeConfig(ws, toolRow('alpha_tool', 'alpha'))
    const lease = await host.registry.acquire(ws)
    const workspaceKey = lease.key

    // A live descendant (Agent-like) scope under the workspace.
    const agentKey: ScopeKey = {}
    const agent = createScope(lease.ctx, agentKey, { parent: workspaceKey })

    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).toContain('alpha_tool')
    }, { timeout: 5000 })
    // The descendant sees the workspace layer's tool too.
    expect(await viewNames(agent.ctx, agentKey)).toContain('alpha_tool')

    // valid -> valid: the old tool disappears, the new one appears, and both
    // scope keys are unchanged.
    await writeFile(configPath, toolRow('beta_tool', 'beta'))
    await vi.waitFor(async () => {
      const names = await viewNames(lease.ctx, lease.key)
      expect(names).not.toContain('alpha_tool')
      expect(names).toContain('beta_tool')
    }, { timeout: 5000 })
    await vi.waitFor(async () => {
      const names = await viewNames(agent.ctx, agentKey)
      expect(names).not.toContain('alpha_tool')
      expect(names).toContain('beta_tool')
    }, { timeout: 5000 })
    // Reload replaced only the WorkspaceTree subtree: the workspace key and
    // the descendant's scope/parent relationship remain unchanged.
    expect(lease.key).toBe(workspaceKey)
    expect(scopeOf(agent.ctx)).toBe(agentKey)
    expect(scopeParentOf(agentKey)).toBe(workspaceKey)
    expect(host.registry.workspaceForScope(workspaceKey)).toBe(lease.canonical)
    // The tool itself is effect-owned: exactly one reload per generation.
    await vi.waitFor(() => {
      expect(host.registry.get(lease.canonical)?.reload?.successfulReloads).toBe(1)
    }, { timeout: 5000 })
  })

  it('invalid config empties the workspace tool surface, keeps the scope and lease live, and recovers', async () => {
    const ws = await makeWorkspace(host.root, 'tools-fail')
    await seedPlugins(ws, ['tool-contribute.js'])
    const configPath = await writeConfig(ws, toolRow('gamma_tool', 'gamma'))
    const lease = await host.registry.acquire(ws)
    const agentKey: ScopeKey = {}
    const agent = createScope(lease.ctx, agentKey, { parent: lease.key })
    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).toContain('gamma_tool')
    }, { timeout: 5000 })

    // Break the config: the reload fails, the workspace's tools vanish from
    // both the workspace and the descendant view, and the status reports
    // failed — but the scope/lease/descendant all stay live.
    await writeFile(configPath, '- id: x\n  name: [unclosed\n')
    await vi.waitFor(() => {
      expect(host.registry.get(lease.canonical)?.reload?.status).toBe('failed')
    }, { timeout: 5000 })
    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).not.toContain('gamma_tool')
    }, { timeout: 5000 })
    expect(await viewNames(agent.ctx, agentKey)).not.toContain('gamma_tool')
    expect(host.registry.get(lease.canonical)?.composition).toBeUndefined()
    expect(host.registry.workspaceForScope(lease.key)).toBe(lease.canonical)
    let scopeDisposed = false
    lease.ctx.effect(() => () => {
      scopeDisposed = true
    })

    // Fix the file: the next event mounts a fresh composition and the new
    // tool is visible to the workspace and the descendant again.
    await writeFile(configPath, toolRow('delta_tool', 'delta'))
    await vi.waitFor(async () => {
      const names = await viewNames(lease.ctx, lease.key)
      expect(names).toContain('delta_tool')
      expect(names).not.toContain('gamma_tool')
    }, { timeout: 5000 })
    expect(await viewNames(agent.ctx, agentKey)).toContain('delta_tool')
    expect(host.registry.get(lease.canonical)?.reload?.status).toBe('idle')

    await lease.release()
    expect(scopeDisposed).toBe(true)
  })

  it('unlink removes the workspace tools while the descendant scope survives', async () => {
    const ws = await makeWorkspace(host.root, 'tools-unlink')
    await seedPlugins(ws, ['tool-contribute.js'])
    const configPath = await writeConfig(ws, toolRow('epsilon_tool', 'epsilon'))
    const lease = await host.registry.acquire(ws)
    const agentKey: ScopeKey = {}
    const agent = createScope(lease.ctx, agentKey, { parent: lease.key })
    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).toContain('epsilon_tool')
    }, { timeout: 5000 })

    await rm(configPath)
    await vi.waitFor(async () => {
      expect(await viewNames(lease.ctx, lease.key)).not.toContain('epsilon_tool')
      expect(host.registry.get(lease.canonical)?.configured).toBe(false)
    }, { timeout: 5000 })
    expect(await viewNames(agent.ctx, agentKey)).not.toContain('epsilon_tool')
    expect(host.registry.workspaceForScope(lease.key)).toBe(lease.canonical)
    expect(scopeOf(agent.ctx)).toBe(agentKey)
    expect(scopeParentOf(agentKey)).toBe(lease.key)
  })
})
