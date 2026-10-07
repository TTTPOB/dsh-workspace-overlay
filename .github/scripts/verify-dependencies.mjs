import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const contract = JSON.parse(readFileSync('.github/release-dependencies.json', 'utf8'))
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const lock = readFileSync('pnpm-lock.yaml', 'utf8')
const root = createRequire(resolve('package.json'))
function packageAt(name, requireFrom) {
  for (const dir of requireFrom.resolve.paths(name) ?? []) {
    const path = join(dir, name, 'package.json')
    if (existsSync(path)) return { path: realpathSync(path), manifest: JSON.parse(readFileSync(path, 'utf8')) }
  }
  throw new Error(`Unresolved dependency: ${name}`)
}
const consumers = [root]
for (const name of Object.keys(pkg.devDependencies).filter(name => name.startsWith('@deepseek-ai/dsh-') || name === 'dsh-workspace-overlay')) {
  const dependency = packageAt(name, root)
  assert.equal(dependency.manifest.version, contract.dependencies[name]?.version ?? pkg.devDependencies[name], `Source baseline for ${name}`)
  assert(existsSync(root.resolve(name)), `Missing built dependency entry: ${name}`)
  consumers.push(createRequire(dependency.path))
}
for (const [name, dependency] of Object.entries(contract.dependencies)) {
  assert(dependency.source, `Waiting for published asset: ${name}`)
  assert(lock.includes(dependency.source), `Lockfile does not contain source: ${name}`)
  const consumer = consumers.find(requireFrom => {
    const manifest = JSON.parse(readFileSync(requireFrom.resolve('./package.json'), 'utf8'))
    return manifest.dependencies?.[name] || manifest.peerDependencies?.[name] || manifest.devDependencies?.[name]
  })
  assert(consumer, `No actual consumer for ${name}`)
  const installed = packageAt(name, consumer)
  assert.equal(installed.manifest.version, dependency.version, name)
  for (const consumer of consumers) {
    const manifest = JSON.parse(readFileSync(consumer.resolve('./package.json'), 'utf8'))
    if (manifest.dependencies?.[name] || manifest.peerDependencies?.[name]) {
      assert.equal(packageAt(name, consumer).manifest.version, dependency.version, `${manifest.name} resolves ${name}`)
    }
  }
  console.log(`${name} ${dependency.version}: ${installed.path}`)
}
const cordis = realpathSync(root.resolve('@deepseek-ai/cordis'))
for (const name of Object.keys(pkg.devDependencies).filter(name => name.startsWith('@deepseek-ai/') || name === 'dsh-workspace-overlay')) {
  const dependency = packageAt(name, root)
  if (dependency.manifest.peerDependencies?.['@deepseek-ai/cordis']) {
    assert.equal(realpathSync(createRequire(dependency.path).resolve('@deepseek-ai/cordis')), cordis, `Duplicate Cordis for ${name}`)
  }
}
console.log(`Verified DSH ${contract.baseline} source dependency combination and shared Cordis`)
