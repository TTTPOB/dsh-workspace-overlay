import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = `v${pkg.version}`
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, tag, 'Tag must match package.json version')
}
const destination = '.artifacts/release'
mkdirSync(destination, { recursive: true })
execFileSync('pnpm', ['pack', '--pack-destination', destination], { stdio: 'inherit' })
const filename = `${pkg.name}-${pkg.version}.tgz`
const tarball = join(destination, filename)
const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n')
assert(!entries.some(entry => /^package\/(node_modules|src|tests|\.artifacts|\.github)\//.test(entry)), 'Archive contains development files')
const packed = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
assert.equal(packed.name, pkg.name)
assert.equal(packed.version, pkg.version)
for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
  for (const [name, version] of Object.entries(packed[section] ?? {})) {
    assert(!/^(file:|link:|workspace:)/.test(version), `Nonportable dependency: ${name}`)
  }
}
for (const target of [packed.main, packed.dsh.bundle.patch, ...Object.values(packed.exports).flatMap(value => typeof value === 'string' ? [value] : Object.values(value))]) {
  assert(entries.includes(`package/${target.replace(/^\.\//, '')}`), `Missing published entry: ${target}`)
}
const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
writeFileSync(join(destination, 'SHA256SUMS'), `${digest}  ${filename}\n`)
writeFileSync(join(destination, 'release-notes.md'), [
  `Prebuilt ${pkg.name} ${pkg.version}.`,
  '',
  'Validated against DSH 0.1.7-rc.2, Agent/preset-registry fork1, Cordis 4.0.4 and Schemastery 3.18.4.',
  '',
  'Install this independent plugin as an ordinary dependency in the resolving profile (autoInstallPeers: false); declare shared workspace rows in $DSH_HOME/cordis.patch.yml before envrc rows.',
  'Keep daily bundles to official base/Web app; do not auto-append this bundle beside the shared rows.',
  '',
].join('\n'))
console.log(`Verified ${tarball}: ${entries.length} entries, SHA-256 ${digest}`)
