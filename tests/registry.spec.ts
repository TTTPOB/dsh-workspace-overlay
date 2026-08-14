import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WorkspaceRegistry, {
  WorkspaceNotFoundError,
  WorkspaceNotDirectoryError,
  type WorkspaceLease,
} from '../src/registry.js'

let ctx: Context
let registry: WorkspaceRegistry
let registryFiber: Fiber
let root: string

async function makeWorkspace(name: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Registers an effect disposer on the lease's scope; the flag turns true on dispose. */
function trackDisposal(lease: WorkspaceLease): () => boolean {
  let disposed = false
  lease.ctx.effect(() => () => {
    disposed = true
  })
  return () => disposed
}

beforeEach(async () => {
  ctx = new Context()
  // The registry injects the loader; a real loader composition also exercises
  // the host base every workspace scope inherits.
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  registryFiber = await ctx.plugin(WorkspaceRegistry)
  registry = ctx.workspaceCordis
  root = await mkdtemp(join(tmpdir(), 'dsh-ws-overlay-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await registryFiber.dispose()
})

describe('WorkspaceRegistry', () => {
  it('registers itself as ctx.workspaceCordis', () => {
    expect(registry.size).toBe(0)
  })

  it('maps a live workspace scope key to its canonical root and nothing else', async () => {
    const dir = await makeWorkspace('mapped')
    const lease = await registry.acquire(dir)

    expect(registry.workspaceForScope(lease.key)).toBe(await realpath(dir))
    // A foreign key is not a workspace scope.
    expect(registry.workspaceForScope({})).toBeUndefined()

    // A fresh entry generation mints a fresh key for the same root; the old
    // key stops resolving as soon as its final lease has disposed the entry.
    await lease.release()
    expect(registry.workspaceForScope(lease.key)).toBeUndefined()
    const again = await registry.acquire(dir)
    expect(again.key).not.toBe(lease.key)
    expect(registry.workspaceForScope(again.key)).toBe(await realpath(dir))
    await again.release()
  })

  it('shares one entry between two acquires of the same directory', async () => {
    const dir = await makeWorkspace('shared')
    const first = await registry.acquire(dir)
    const second = await registry.acquire(dir)

    expect(first.key).toBe(second.key)
    expect(first.ctx).toBe(second.ctx)
    expect(first.canonical).toBe(await realpath(dir))
    expect(registry.size).toBe(1)
    expect(registry.get(first.canonical)?.leases).toBe(2)

    const disposed = trackDisposal(first)
    await first.release()
    expect(disposed()).toBe(false)
    expect(registry.size).toBe(1)

    await second.release()
    expect(disposed()).toBe(true)
    expect(registry.size).toBe(0)
    expect(registry.get(first.canonical)).toBeUndefined()
  })

  it('keeps different directories isolated', async () => {
    const a = await makeWorkspace('a')
    const b = await makeWorkspace('b')
    const leaseA = await registry.acquire(a)
    const leaseB = await registry.acquire(b)

    expect(leaseA.key).not.toBe(leaseB.key)
    expect(leaseA.ctx).not.toBe(leaseB.ctx)
    expect(leaseA.canonical).not.toBe(leaseB.canonical)
    expect(registry.size).toBe(2)
  })

  it('canonicalizes symlinks and shares with the real directory', async () => {
    const dir = await makeWorkspace('real')
    const link = join(root, 'link')
    await symlink(dir, link)

    const viaLink = await registry.acquire(link)
    const viaReal = await registry.acquire(dir)

    expect(viaLink.canonical).toBe(await realpath(dir))
    expect(viaLink.canonical).toBe(viaReal.canonical)
    expect(viaLink.key).toBe(viaReal.key)
    expect(registry.size).toBe(1)
  })

  it('rejects relative, empty, and non-string cwds', async () => {
    await expect(registry.acquire('relative/dir')).rejects.toThrow(TypeError)
    await expect(registry.acquire('')).rejects.toThrow(TypeError)
    await expect(registry.acquire(42 as unknown as string)).rejects.toThrow(TypeError)
    expect(registry.size).toBe(0)
  })

  it('rejects a missing directory and succeeds on retry after it exists', async () => {
    const missing = join(root, 'nope')
    await expect(registry.acquire(missing)).rejects.toBeInstanceOf(WorkspaceNotFoundError)
    expect(registry.size).toBe(0)

    // Failure left no cached state: creating the directory makes retry succeed.
    await mkdir(missing)
    const lease = await registry.acquire(missing)
    expect(lease.canonical).toBe(await realpath(missing))
  })

  it('rejects a path that is not a directory', async () => {
    const file = join(root, 'file')
    await writeFile(file, 'x')
    await expect(registry.acquire(file)).rejects.toBeInstanceOf(WorkspaceNotDirectoryError)
  })

  it('shares one entry across concurrent acquires and disposes on the final release', async () => {
    const dir = await makeWorkspace('concurrent')
    const leases = await Promise.all(Array.from({ length: 10 }, () => registry.acquire(dir)))

    expect(new Set(leases.map((lease) => lease.key)).size).toBe(1)
    expect(registry.size).toBe(1)
    expect(registry.get(leases[0]!.canonical)?.leases).toBe(10)

    const disposed = trackDisposal(leases[0]!)
    await Promise.all(leases.slice(0, 9).map((lease) => lease.release()))
    expect(disposed()).toBe(false)
    expect(registry.size).toBe(1)

    await leases[9]!.release()
    expect(disposed()).toBe(true)
    expect(registry.size).toBe(0)
  })

  it('makes release idempotent', async () => {
    const dir = await makeWorkspace('idempotent')
    const lease = await registry.acquire(dir)
    const disposed = trackDisposal(lease)

    await lease.release()
    await lease.release()
    expect(disposed()).toBe(true)
    expect(registry.size).toBe(0)
  })

  it('disposes the scope on the final release and mints a fresh one afterwards', async () => {
    const dir = await makeWorkspace('final')
    const lease = await registry.acquire(dir)
    const disposed = trackDisposal(lease)

    await lease.release()
    expect(disposed()).toBe(true)

    // The removed entry is gone; a new acquire gets a brand-new opaque key.
    const again = await registry.acquire(dir)
    expect(again.key).not.toBe(lease.key)
    expect(again.ctx).not.toBe(lease.ctx)
  })

  it('defaults trustWorkspaceConfig to true and honors config', async () => {
    const dir = await makeWorkspace('trust')
    const lease = await registry.acquire(dir)
    expect(lease.trustWorkspaceConfig).toBe(true)

    const other = new Context()
    await other.plugin(Loader)
    const otherFiber = await other.plugin(WorkspaceRegistry, { trustWorkspaceConfig: false })
    const otherLease = await other.workspaceCordis.acquire(dir)
    expect(otherLease.trustWorkspaceConfig).toBe(false)
    await otherFiber.dispose()
  })
})
