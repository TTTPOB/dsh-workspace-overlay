// Disposes itself once active. The Loader treats a self-disposing entry as a
// config change and writes the tree back through `EntryTree.write()`, which
// is the exact path that once rewrote a preset composition file; the
// workspace tree's no-op `write()` must keep the authored config intact.
export const name = 'ws-self-dispose'

export function apply(ctx) {
  globalThis.__WS_SELF_DISPOSED__ = new Promise((resolve) => {
    setTimeout(() => {
      ctx.fiber.dispose()
      resolve(undefined)
    }, 0)
  })
}
