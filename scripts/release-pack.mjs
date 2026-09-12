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
const repository = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
writeFileSync(join(destination, 'release-notes.md'), [
  `Prebuilt ${pkg.name} ${pkg.version}.`,
  '',
  'Validated against DSH service packages 0.1.5-rc.2 and Cordis 4.0.2. Shared DSH/Cordis peers must resolve to the Host module instances.',
  '',
  'Install with the installed DSH CLI (install overlay before envrc):',
  '',
  '```sh',
  `dsh plugin --profile web add ${repository}/releases/download/${tag}/${filename}`,
  'dsh --profile web --dump-config',
  '```',
  '',
  'Keep dsh-workspace-overlay before dsh-workspace-envrc in dsh.profile.bundles. Restart the Host after installation.',
  '',
].join('\n'))
console.log(`Verified ${tarball}: ${entries.length} entries, SHA-256 ${digest}`)
