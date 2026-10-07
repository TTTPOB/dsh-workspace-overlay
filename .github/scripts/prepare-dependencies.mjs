import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const contract = JSON.parse(readFileSync('.github/release-dependencies.json', 'utf8'))
const workspace = readFileSync('pnpm-workspace.yaml', 'utf8')
for (const [name, dependency] of Object.entries(contract.dependencies)) {
  assert(dependency.source, `Waiting for published asset: ${name} ${dependency.version}`)
  const url = new URL(dependency.source)
  assert(url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.includes('/releases/download/') && url.pathname.endsWith('.tgz'), `Expected immutable Release asset: ${name}`)
  assert(workspace.includes(`${JSON.stringify(name)}: ${JSON.stringify(dependency.source)}`), `Source override differs from release contract: ${name}`)
}
execFileSync('pnpm', ['install', '--frozen-lockfile'], { stdio: 'inherit' })
execFileSync(process.execPath, ['.github/scripts/verify-dependencies.mjs'], { stdio: 'inherit' })
