import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: TestResizeObserver,
})

Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
  configurable: true,
  value() {},
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete window.nix
})
