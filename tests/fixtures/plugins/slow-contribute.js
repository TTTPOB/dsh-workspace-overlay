// A workspace composition row whose activation is deliberately slow, so tests
// can deterministically hold a reload pass inside its mount and interleave a
// lease release with the in-flight mount. Like contribute.js, state is
// published through globalThis because the Loader imports this file through
// Node's internal ESM loader, whose module registry is separate from the test
// runner's.
export const name = 'ws-slow-contribute'

export async function apply(ctx, config) {
  // Signal activation synchronously — before the delay — so a test can
  // observe that the mount has started, then wait out the delay before the
  // effect (and its marker) registers.
  const record = globalThis.__WS_FIXTURE__ ??= { markers: [], contexts: [], disposed: 0, pending: [] }
  record.pending.push(config.marker)
  await new Promise((resolve) => setTimeout(resolve, config.delayMs ?? 100))
  ctx.effect(() => {
    record.markers.push(config.marker)
    record.contexts.push(ctx)
    return () => {
      record.disposed += 1
    }
  })
}
