/**
 * Generic reversible method wrapping for provider-owned service targets.
 *
 * DSH services are consumed through Cordis traceable proxies (`ctx.<name>`);
 * a consumer's proxy is a shadow and must never be mutated. This helper
 * resolves the provider target via `symbols.original`, records how the method
 * was reached (own descriptor or inherited prototype), and defines a
 * configurable own method on the target. Disposal restores the previous state
 * only while the current value is still the installed wrapper, so a successor
 * wrapper installed on top is never clobbered, and a later reassignment is
 * left untouched.
 *
 * @module dsh-workspace-overlay/method-wrapper
 */
import { getPropertyDescriptor, symbols } from '@deepseek-ai/cordis'

/** The installed method wrapper; disposing it reverts the target method. */
export interface MethodWrapperHandle {
  /** Restore the recorded pre-install state. Idempotent; inert for successors. */
  dispose(): void
}

/** A wrapper invoked in place of the original method, with its receiver. */
export type MethodWrapper<T extends object, K extends keyof T> = (
  original: T[K],
  thisArg: T,
  args: unknown[],
) => unknown

/**
 * Install `wrap` as an own method on the provider target behind `value`.
 *
 * `value` may be the raw provider instance or a Cordis traceable proxy (or a
 * shadow receiver) — only the `symbols.original` target is ever modified.
 * `wrap` receives the original method, the exact receiver the call came in on
 * (the traceable shadow, so `this.ctx` still names the caller's context), and
 * the call arguments.
 *
 * @throws TypeError when the method is missing or not a function.
 */
export function installMethodWrapper<T extends object, K extends keyof T>(
  value: T,
  method: K,
  wrap: MethodWrapper<T, K>,
): MethodWrapperHandle {
  const target = (value as T & { [symbols.original]?: T })[symbols.original] ?? value
  const key = method as string | symbol
  const before = getPropertyDescriptor(target, key)
  if (!before || typeof before.value !== 'function') {
    throw new TypeError(`cannot wrap non-function method ${String(method)}`)
  }
  const original = before.value as T[K]
  const hadOwn = Object.prototype.hasOwnProperty.call(target, method)
  const installed = function (this: unknown, ...args: unknown[]): unknown {
    return wrap(original, this as T, args)
  }
  Object.defineProperty(target, method, {
    value: installed,
    writable: true,
    configurable: true,
    enumerable: before.enumerable ?? false,
  })
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      // Only revert while the current value is still this exact wrapper: a
      // successor wrapper or a later reassignment must survive untouched.
      if ((target as Record<PropertyKey, unknown>)[method] !== installed) return
      if (hadOwn && before) {
        Object.defineProperty(target, method, before)
      } else {
        Reflect.deleteProperty(target, method)
      }
    },
  }
}
