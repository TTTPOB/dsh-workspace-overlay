// Publishes a service with no `isolate` realm, so it lands in the ROOT realm
// and the mount audit must reject it; with an `isolate` row option the same
// provider is accepted because the service stays behind a realm-private
// symbol.
export const name = 'ws-global-service'

export function apply(ctx, config) {
  ctx.effect(() => ctx.reflect.provide(config.service, { label: config.label }))
}
