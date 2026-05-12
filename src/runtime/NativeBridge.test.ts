import { describe, expect, it } from 'vitest'

import { isNativePortolanRuntime } from './NativeBridge'

describe('isNativePortolanRuntime', () => {
  it('is false for the ordinary browser runtime', () => {
    expect(isNativePortolanRuntime({})).toBe(false)
  })

  it('is true when Tauri injects its internals marker', () => {
    expect(isNativePortolanRuntime({ __TAURI_INTERNALS__: {} })).toBe(true)
  })
})
