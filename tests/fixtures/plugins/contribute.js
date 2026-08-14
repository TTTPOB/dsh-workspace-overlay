// A workspace composition row: records one observable marker on the workspace
// scope it mounts into, then removes it when the scope is disposed. The
// recorded context lets the test prove the registrations landed in the
// workspace scope via `scopeOf`. State is published through globalThis because
// the Loader imports this file through Node's internal ESM loader, whose
// module registry is separate from the test runner's — only process-global
// state is shared.
export const name = 'ws-contribute'

export function apply(ctx, config) {
  const record = globalThis.__WS_FIXTURE__ ??= { markers: [], contexts: [], disposed: 0 }
  ctx.effect(() => {
    record.markers.push(config.marker)
    record.contexts.push(ctx)
    return () => {
      record.disposed += 1
    }
  })
}
