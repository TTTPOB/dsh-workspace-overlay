import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const contract = JSON.parse(readFileSync('.github/release-dependencies.json', 'utf8'))
const root = resolve('.artifacts/consumer')
const host = join(root, 'host')
const home = join(root, 'home')
const profile = join(home, 'profiles', 'test')
for (const dir of [host, profile]) mkdirSync(dir, { recursive: true })
const overrides = Object.fromEntries(Object.entries(contract.dependencies).map(([name, dependency]) => {
  assert(dependency.source, `Waiting for published asset: ${name}`)
  return [name, dependency.source]
}))
const hostDependencies = Object.fromEntries(Object.entries(pkg.devDependencies).filter(([name]) => name.startsWith('@deepseek-ai/')))
hostDependencies['@deepseek-ai/schemastery'] = '3.18.4'
for (const [name, dependency] of Object.entries(contract.dependencies)) {
  if (name.startsWith('@deepseek-ai/')) hostDependencies[name] = dependency.version
}
if (pkg.name === 'dsh-workspace-envrc') {
  const rootRequire = createRequire(resolve('package.json'))
  const overlayManifestPath = rootRequire.resolve.paths('dsh-workspace-overlay')
    .map(dir => join(dir, 'dsh-workspace-overlay', 'package.json')).find(existsSync)
  assert(overlayManifestPath, 'Source overlay consumer is missing')
  const overlay = JSON.parse(readFileSync(overlayManifestPath, 'utf8'))
  for (const [name, version] of Object.entries(overlay.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/') && !overlay.peerDependenciesMeta?.[name]?.optional) hostDependencies[name] ??= version
  }
}
const profileDependencies = { [pkg.name]: `file:${resolve('.artifacts/release', `${pkg.name}-${pkg.version}.tgz`)}` }
if (pkg.name === 'dsh-workspace-envrc') profileDependencies['dsh-workspace-overlay'] = overrides['dsh-workspace-overlay']
writeFileSync(join(host, 'package.json'), JSON.stringify({ name: 'release-host-fixture', private: true, type: 'module', dependencies: hostDependencies }, null, 2) + '\n')
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'release-profile-fixture', private: true, type: 'module', dependencies: profileDependencies, dsh: { profile: { bundles: pkg.name === 'dsh-workspace-envrc' ? ['dsh-workspace-overlay', pkg.name] : [pkg.name] } } }, null, 2) + '\n')
for (const dir of [host, profile]) {
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), JSON.stringify({ autoInstallPeers: dir === host, verifyDepsBeforeRun: false, overrides, allowBuilds: { esbuild: true } }, null, 2) + '\n')
  execFileSync('pnpm', ['install', '--ignore-scripts'], { cwd: dir, stdio: 'inherit' })
}
const runner = `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { loadProfileDirectory, createRuntimeResolution, PluginPackages, composeEntries, setProfileVersionExemption } from '@deepseek-ai/dsh-app-boot'
import Loader from '@deepseek-ai/cordis-plugin-loader'
const profileDir = ${JSON.stringify(profile)}
const anchor = ${JSON.stringify(join(host, 'package.json'))}
const pkgName = ${JSON.stringify(pkg.name)}
const pkgVersion = ${JSON.stringify(pkg.version)}
const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
assert(!Object.keys(profileManifest.dependencies).some(name => name.startsWith('@deepseek-ai/')))
const identities = pkgName === 'dsh-workspace-envrc' ? ['dsh-workspace-overlay@0.2.0', pkgName + '@' + pkgVersion] : [pkgName + '@' + pkgVersion]
for (const identity of identities) await setProfileVersionExemption(profileDir, identity, '0.1.7-rc.2', false, false)
let profile = loadProfileDirectory('release-smoke', profileDir, anchor)
if (pkgName !== 'dsh-progressive-tools') {
  assert.equal(profile.skippedBundles.length, identities.length, 'Fork-only peers must fail official Host admission without informed consent')
  for (const identity of identities) await setProfileVersionExemption(profileDir, identity, '0.1.7-rc.2', true, true)
  profile = loadProfileDirectory('release-smoke', profileDir, anchor)
}
assert.deepEqual(profile.skippedBundles, [])
const resolution = await createRuntimeResolution({ installAnchor: anchor, profile, home: ${JSON.stringify(home)} })
const ctx = new Context()
await ctx.plugin(PluginPackages, { resolution })
try {
  const parentURL = pathToFileURL(join(profileDir, 'smoke.mjs')).href
  const installed = ctx.pluginPackages.packageOf(pkgName, parentURL)
  assert.equal(installed.version, pkgVersion)
  const manifest = installed.manifest
  const requireFromHost = createRequire(anchor)
  for (const pluginName of Object.keys(profileManifest.dependencies)) {
    const plugin = ctx.pluginPackages.packageOf(pluginName, parentURL)
    const requireFromPlugin = createRequire(plugin.manifestPath)
    for (const peer of Object.keys(plugin.manifest.peerDependencies ?? {})) {
      if (plugin.manifest.peerDependenciesMeta?.[peer]?.optional) continue
      const actual = ctx.pluginPackages.packageOf(peer, pathToFileURL(plugin.manifestPath).href)
      assert(actual, 'Missing shared peer ' + peer)
      if (peer.startsWith('@deepseek-ai/')) {
        assert.equal(realpathSync(requireFromPlugin.resolve(peer)), realpathSync(requireFromHost.resolve(peer)), 'Shared Host peer ' + peer)
        assert(!existsSync(join(profileDir, 'node_modules', peer)), 'Profile owns Host peer ' + peer)
      }
    }
  }
  for (const [entry, target] of Object.entries(manifest.exports)) {
    if (entry.endsWith('.yml') || entry.endsWith('package.json')) continue
    const module = await import(pathToFileURL(join(installed.dir, typeof target === 'string' ? target : target.default)).href)
    if (entry === '.') assert(Object.keys(module).length > 0, 'Empty built plugin entry')
  }
  ctx.baseUrl = pathToFileURL(profileDir).href + '/'
  await ctx.plugin(Loader)
  if (pkgName === 'dsh-progressive-tools') {
    for (const service of ['system-prompt', 'llm', 'tools']) await ctx.plugin((await import('@deepseek-ai/dsh-' + service)).default)
  } else if (pkgName === 'dsh-workspace-envrc') {
    await ctx.plugin((await import('@deepseek-ai/dsh-agent')).default)
    await ctx.loader.create({ id: 'overlay-provider', name: 'dsh-workspace-overlay', config: { trustWorkspaceConfig: false, watchWorkspaceConfig: false } })
  }
  await ctx.loader.create({ id: 'built-entry', name: pkgName, config: pkgName === 'dsh-workspace-overlay' ? { trustWorkspaceConfig: false, watchWorkspaceConfig: false } : {} })
  await ctx.loader.await()
  assert(ctx.get(pkgName === 'dsh-workspace-overlay' ? 'workspaceCordis' : pkgName === 'dsh-workspace-envrc' ? 'workspaceEnvrc' : 'tools'), 'Built provider did not activate')
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  assert(entries.length > 0, 'Bundle did not contribute rows')
  console.log(JSON.stringify({ package: pkgName, version: pkgVersion, profileDependencies: Object.keys(profileManifest.dependencies), rows: entries.map(row => row.id), peers: Object.keys(manifest.peerDependencies) }, null, 2))
} finally {
  await ctx.fiber.dispose()
}
`
writeFileSync(join(host, 'smoke.mjs'), runner)
execFileSync(process.execPath, [join(host, 'smoke.mjs')], { cwd: host, stdio: 'inherit' })
