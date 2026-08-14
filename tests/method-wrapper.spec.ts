import { describe, expect, it } from 'vitest'
import { symbols } from '@deepseek-ai/cordis'
import { installMethodWrapper } from '../src/method-wrapper.js'

class Greeter {
  greet(name: string): string {
    return `hello ${name}`
  }

  own(): string {
    return 'own-original'
  }
}

describe('installMethodWrapper', () => {
  it('wraps an inherited prototype method as a configurable own property and restores the prototype on dispose', () => {
    const greeter = new Greeter()
    const calls: string[] = []

    const handle = installMethodWrapper(greeter, 'greet', (original, thisArg, args) => {
      expect(thisArg).toBe(greeter)
      calls.push(...(args as [string]))
      return original.call(thisArg, ...(args as [string]))
    })

    expect(Object.hasOwn(greeter, 'greet')).toBe(true)
    const own = Object.getOwnPropertyDescriptor(greeter, 'greet')!
    expect(own.configurable).toBe(true)
    expect(own.writable).toBe(true)
    expect(greeter.greet('world')).toBe('hello world')
    expect(calls).toEqual(['world'])

    handle.dispose()
    expect(Object.hasOwn(greeter, 'greet')).toBe(false)
    // The inherited prototype method is reachable again.
    expect(greeter.greet('again')).toBe('hello again')
  })

  it('restores an exact own descriptor when the method was already own', () => {
    const greeter = new Greeter()
    greeter.own = function own() {
      return 'own-original'
    }
    const before = Object.getOwnPropertyDescriptor(greeter, 'own')!

    const handle = installMethodWrapper(greeter, 'own', (original, thisArg) =>
      original.call(thisArg),
    )

    expect(Object.getOwnPropertyDescriptor(greeter, 'own')!.value).not.toBe(before.value)
    handle.dispose()
    expect(Object.getOwnPropertyDescriptor(greeter, 'own')).toEqual(before)
    expect(greeter.own()).toBe('own-original')
  })

  it('leaves a successor wrapper untouched when an older disposer runs', () => {
    const greeter = new Greeter()
    const first = installMethodWrapper(greeter, 'greet', (original, thisArg, args) =>
      `first(${original.call(thisArg, ...(args as [string]))})`,
    )
    const second = installMethodWrapper(greeter, 'greet', (original, thisArg, args) =>
      `second(${original.call(thisArg, ...(args as [string]))})`,
    )
    // The chain composes: second wraps first, which wraps the original.
    expect(greeter.greet('x')).toBe('second(first(hello x))')

    // Disposing the first wrapper must not clobber the second one installed on top.
    first.dispose()
    expect(greeter.greet('x')).toBe('second(first(hello x))')

    // Disposing the second restores what it recorded: the first wrapper.
    second.dispose()
    expect(greeter.greet('x')).toBe('first(hello x)')
  })

  it('makes dispose idempotent', () => {
    const greeter = new Greeter()
    const handle = installMethodWrapper(greeter, 'greet', (original, thisArg, args) =>
      original.call(thisArg, ...(args as [string])),
    )
    handle.dispose()
    handle.dispose()
    expect(Object.hasOwn(greeter, 'greet')).toBe(false)
    expect(greeter.greet('x')).toBe('hello x')
  })

  it('does not restore over a later reassignment', () => {
    const greeter = new Greeter()
    const handle = installMethodWrapper(greeter, 'greet', (original, thisArg, args) =>
      original.call(thisArg, ...(args as [string])),
    )
    greeter.greet = () => 'replaced'
    handle.dispose()
    expect(greeter.greet('x')).toBe('replaced')
  })

  it('rejects a missing or non-function method', () => {
    const greeter = new Greeter()
    expect(() =>
      installMethodWrapper(greeter, 'missing' as keyof Greeter, () => undefined),
    ).toThrow(TypeError)
    greeter.greet = 42 as unknown as Greeter['greet']
    expect(() => installMethodWrapper(greeter, 'greet', () => undefined)).toThrow(TypeError)
  })

  it('operates on the symbols.original target, never on the traceable carrier', () => {
    const greeter = new Greeter()
    const carrier = { [symbols.original]: greeter }
    const handle = installMethodWrapper(carrier as unknown as Greeter, 'greet', (
      original,
      thisArg,
      args,
    ) => original.call(thisArg, ...(args as [string])))

    expect(Object.hasOwn(greeter, 'greet')).toBe(true)
    expect(Object.hasOwn(carrier, 'greet')).toBe(false)
    expect(greeter.greet('via-target')).toBe('hello via-target')

    handle.dispose()
    expect(Object.hasOwn(greeter, 'greet')).toBe(false)
  })
})
