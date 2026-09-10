/**
 * better-input 浏览器半冒烟测试：不起浏览器、不装 React，用测试替身检查
 * 「bundle 包装 → 座位注册 → 组件契约」这条链。
 *
 * 为什么不装 React 跑真渲染：本工作区没有 react/react-dom 依赖，而这里的风险点不在
 * React 本身，而在「对框架注入 props 的假设」与「座位注册参数」——一个最小 React 替身
 * （createElement + 三个 hook）就足以把它们钉住。
 *
 * 运行：node test/client.smoke.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
const failures = []

/** 假的 React hook 槽位：跨「渲染」保留，模拟 React 的 hook 语义。 */
const hookSlots = []

/**
 * 跑一个用例：每个用例前清空 hook 槽位，避免状态串味。
 * @param {string} label - 用例名。
 * @param {() => (void | Promise<void>)} body - 用例体。
 * @returns {Promise<void>} 完成。
 */
async function test(label, body) {
  hookSlots.length = 0
  try {
    await body()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ── 假的 React：只实现本插件用到的四个 API ─────────────────────────────── */

let cursor = 0

const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    const index = cursor++
    hookSlots[index] ??= typeof initial === 'function' ? initial() : initial
    return [hookSlots[index], next => { hookSlots[index] = next }]
  },
  useRef(initial) {
    const index = cursor++
    hookSlots[index] ??= { current: initial }
    return hookSlots[index]
  },
  useEffect() {
    cursor += 1
  },
}

/**
 * 展开 children，过滤掉 false/null（对齐 React 的渲染语义）。
 * @param {object} node - createElement 产物。
 * @returns {object[]} 子节点。
 */
function childrenOf(node) {
  return node.children.flat(Infinity).filter(child => child !== false && child !== null && child !== undefined)
}

/* ── 假的浏览器环境，然后加载 bundle ──────────────────────────────────── */

const appendedStyles = []
let entry

globalThis.window = {
  setTimeout: () => 0,
  __ModuleLoader__: { load: (loaded) => { entry = loaded } },
}
globalThis.document = {
  head: { append: (element) => { appendedStyles.push(element) } },
  createElement: () => ({ id: '', textContent: '' }),
  getElementById: (id) => appendedStyles.find(style => style.id === id) ?? null,
}

await import('../lib/client.js')

/** 造一个 require 替身：只允许平台种子模块。 */
const requireShim = (primitives) => (spec) => {
  if (spec === 'react') return fakeReact
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives ?? {}
  throw new Error(`unexpected require("${spec}")`)
}

/* ── 假 ctx：捕获词典与座位注册 ───────────────────────────────────────── */

/**
 * 造一个假客户端 ctx。
 * @returns {{ ctx: object, seat: object[], dictionaries: object[] }} ctx 与观测点。
 */
function fakeCtx() {
  const seat = []
  const dictionaries = []
  const ctx = {
    effect(factory) {
      return factory()
    },
    inject(_deps, body) {
      body({
        slots: {
          inject: (_key, callback) => callback(),
          register: (options, component) => { seat.push({ key: options.name, options, component }) },
        },
      })
    },
    locale: {
      register: (namespace, dictionary) => { dictionaries.push({ namespace, dictionary }); return () => {} },
    },
  }
  return { ctx, seat, dictionaries }
}

const SEAT = 'conversation.input.right'
const ROUTE = '/api/dsh-input-optimizer/optimize'

/**
 * 渲染一次按钮组件（复用 hook 槽位 = 重渲染）。
 * 图标是在 bundle 工厂执行时从平台种子模块取的，所以这里每次都走一遍
 * factory + apply，才能覆盖「图标存在 / 缺失」两条路径。
 * @param {{ draft?: string, phase?: string, primitives?: object }} options - 渲染参数。
 * @returns {{ node: object, button: object, written: string[] }} 渲染结果。
 */
function render(options = {}) {
  const { ctx, seat } = fakeCtx()
  entry.factory(requireShim(options.primitives ?? {})).apply(ctx)
  const state = {
    draft: options.draft ?? '帮我写个脚本',
    phase: options.phase ?? 'plain',
    draftRev: 3,
    occurrences: [],
  }
  const written = []
  cursor = 0
  const node = seat[0].component({
    t: (key) => key,
    useInput: (selector) => selector(state),
    inputActions: { setDraft: (text) => { written.push(text) } },
    sessionId: 'session-test',
    input: state,
  })
  const button = childrenOf(node).find(child => child.type === 'button')
  assert.ok(button !== undefined, '组件必须渲染出一个 <button>')
  return { node, button, written }
}

console.log('client half: bundle 包装与插件契约')
await test('bundle id 必须等于包名，factory 返回 apply/inject', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(entry !== undefined, 'window.__ModuleLoader__.load 未被调用')
  assert.equal(entry.id, pkg.name, 'bundle id 必须等于包名')
  const exports = entry.factory(requireShim({}))
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['slots', 'locale'])
})
await test('apply 注册词典、注入样式、把条目注册进模型左侧座位', () => {
  const { ctx, seat, dictionaries } = fakeCtx()
  entry.factory(requireShim({})).apply(ctx)
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'inputOptimizer')
  assert.deepEqual(Object.keys(dictionaries[0].dictionary), ['zh', 'en'])
  assert.equal(appendedStyles.length, 1, '样式应注入一次')
  assert.equal(seat.length, 1)
  assert.equal(seat[0].key, SEAT, '必须注册进 conversation.input.right（模型紧左边）')
  assert.equal(typeof seat[0].component, 'function')
  const options = seat[0].options
  assert.equal(options.id, 'better-input', 'list 座位必须给 id')
  assert.equal(typeof options.order, 'number')
  assert.equal(options.locale, 'inputOptimizer')
  // 幂等：重复 apply 不应再插第二个 style 标签，但会各自注册一条条目（各自由 fiber 回收）
  entry.factory(requireShim({})).apply(fakeCtx().ctx)
  assert.equal(appendedStyles.length, 1)
})

console.log('client half: 组件契约')
await test('有草稿时按钮可用，标记与无障碍属性齐全', () => {
  const { button } = render({ draft: '帮我写个脚本' })
  assert.equal(button.props.type, 'button')
  assert.equal(button.props.className, 'dsh-better-input')
  assert.equal(button.props['data-dsh-better-input'], 'better-input')
  assert.equal(button.props['data-state'], 'idle')
  assert.equal(button.props['aria-label'], 'optimize')
  assert.equal(button.props.title, 'optimize')
  assert.equal(button.props.disabled, false)
  assert.equal(typeof button.props.onMouseDown, 'function', '必须阻止 mousedown 抢焦点')
})
await test('空草稿禁用；提交/裁决中禁用', () => {
  assert.equal(render({ draft: '   ' }).button.props.disabled, true)
  assert.equal(render({ draft: '   ' }).button.props.title, 'empty')
  assert.equal(render({ draft: 'x', phase: 'submitting' }).button.props.disabled, true)
  assert.equal(render({ draft: 'x', phase: 'claimed' }).button.props.disabled, true)
  assert.equal(render({ draft: 'x', phase: 'submitting' }).button.props.title, 'busy')
})
await test('提交中显示 running 态与 loading 图标', () => {
  const loading = () => null
  const { button } = render({ draft: 'x', phase: 'submitting', primitives: { IconLoadingOutline16: loading } })
  assert.equal(button.props['data-state'], 'running')
  assert.equal(childrenOf(button)[0].type, loading)
})
await test('图标缺失时降级为文字符号，不抛错', () => {
  const { button } = render({ draft: 'x', primitives: {} })
  assert.equal(childrenOf(button)[0], '✨')
})
await test('点击当前是 P0 占位：提示待接线，绝不改草稿', () => {
  const logs = []
  const original = console.info
  console.info = (...args) => { logs.push(args.join(' ')) }
  try {
    const { button, written } = render({ draft: 'x' })
    button.props.onClick()
    assert.equal(logs.length, 1)
    assert.equal(logs[0].includes(ROUTE), true, '提示里应带出宿主路由路径')
    assert.equal(written.length, 0, 'P0 阶段不得写入草稿')
  } finally {
    console.info = original
  }
})
await test('点击后重渲染出现「待接线」提示与 title', () => {
  const first = render({ draft: 'x' })
  first.button.props.onClick()
  const { node, button } = render({ draft: 'x' })
  const note = childrenOf(node).find(child => child.type === 'span')
  assert.ok(note !== undefined, '应出现提示文本节点')
  assert.deepEqual(childrenOf(note), ['pending'])
  assert.equal(button.props.title, 'pending')
})

console.log('')
if (failures.length > 0) {
  console.error(`${String(failures.length)} 个用例失败，${String(passed)} 个通过`)
  for (const { label, error } of failures) {
    console.error(`- ${label}: ${error instanceof Error ? error.stack : String(error)}`)
  }
  process.exit(1)
}
console.log(`全部通过：${String(passed)} 个用例`)
