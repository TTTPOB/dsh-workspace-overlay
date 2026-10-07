import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const inputs = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const source = process.cwd()
const destination = resolve('.artifacts/local-source')
mkdirSync(destination, { recursive: true })
for (const name of readdirSync(source)) {
  if (['.git', 'node_modules', '.artifacts', 'dist', 'lib'].includes(name)) continue
  cpSync(join(source, name), join(destination, name), {
    recursive: true,
    filter: path => !['node_modules', '.artifacts'].includes(basename(path)),
  })
}
const contractPath = join(destination, '.github/release-dependencies.json')
const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
for (const [name, dependency] of Object.entries(contract.dependencies)) {
  const tarball = resolve(inputs[name])
  assert(existsSync(tarball), `Missing local tarball: ${name}`)
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
  assert.equal(manifest.name, name)
  assert.equal(manifest.version, dependency.version)
  dependency.source = `file:${tarball}`
}
writeFileSync(contractPath, JSON.stringify(contract, null, 2) + '\n')
const overrides = Object.fromEntries(Object.entries(contract.dependencies).map(([name, dependency]) => [name, dependency.source]))
writeFileSync(join(destination, 'pnpm-workspace.yaml'), JSON.stringify({ overrides, verifyDepsBeforeRun: false, allowBuilds: { esbuild: true } }, null, 2) + '\n')
execFileSync('pnpm', ['install', '--no-frozen-lockfile'], { cwd: destination, stdio: 'inherit' })
execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: destination, stdio: 'inherit' })
execFileSync('pnpm', ['verify:dependencies'], { cwd: destination, stdio: 'inherit' })
console.log(`Local-only source fixture: ${destination}; not releasable until published URLs replace its local sources`)
