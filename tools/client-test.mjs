// Client-half smoke test: executes the real plugin client bundle with a fake
// module loader, fake React, and a fake cordis client context, then checks that
// every surface registers.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const captured = []
globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } }

function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) } }
}
const ReactFake = {
  createElement,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: false }),
}
const requireFake = (name) => {
  if (name === 'react') return ReactFake
  throw new Error('unexpected require: ' + name)
}

const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')
new Function('require', 'window', source)(requireFake, globalThis.window)

const assert = (condition, message) => {
  if (!condition) throw new Error('ASSERT FAILED: ' + message)
  console.log('ok -', message)
}

assert(captured.length === 1, 'client bundle registers exactly one factory')
const spec = captured[0]
assert(spec.id === 'dsh-plugin-team-balancer', 'factory id is the package name')
const pluginModule = spec.factory(requireFake)
assert(pluginModule.id === 'dsh-plugin-team-balancer', 'module exports its id')
assert(typeof pluginModule.apply === 'function', 'module exports apply')

const registrations = []
const effects = []
const ctx = {
  locale: {
    bind: () => (key) => key,
    register: () => () => {},
  },
  effect: (callback) => {
    const dispose = callback()
    effects.push(dispose)
    return dispose
  },
  slots: {
    inject: (slot, callback) => {
      const dispose = callback()
      registrations.push(slot)
      return dispose
    },
    register: (options, component) => {
      registrations.push({ slot: options.name, options, component })
      return () => {}
    },
  },
}
pluginModule.apply(ctx)

const slots = registrations.filter((entry) => entry && typeof entry === 'object' && entry.slot !== undefined).map((entry) => entry.slot)
assert(slots.includes('main'), 'registers the main panel')
assert(slots.includes('sidebar.panellist'), 'registers the sidebar panel icon')
assert(slots.includes('plugins.bundle.config'), 'registers the bundle configuration page')

const panel = registrations.find((entry) => entry.slot === 'main')
assert(panel.options.key === 'team-balancer', 'main panel key matches the sidebar id')
const sidebar = registrations.find((entry) => entry.slot === 'sidebar.panellist')
assert(sidebar.options.id === 'team-balancer', 'sidebar entry id matches the main panel key')
assert(typeof sidebar.options.label === 'function' && sidebar.options.label() === 'panelTitle', 'sidebar label resolves through the locale dictionary')
const iconElement = sidebar.component({ size: 20, active: true })
const iconSvg = typeof iconElement.type === 'function' ? iconElement.type(iconElement.props) : iconElement
assert(iconSvg && iconSvg.type === 'svg', 'sidebar component renders the balance icon')
const bundleConfig = registrations.find((entry) => entry.slot === 'plugins.bundle.config')
assert(bundleConfig.options.key === 'dsh-plugin-team-balancer', 'bundle config page is keyed by the package name')

for (const dispose of effects.splice(0)) if (typeof dispose === 'function') dispose()
console.log('\nALL CLIENT CHECKS PASSED')
