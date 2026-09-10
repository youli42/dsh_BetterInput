/**
 * 真 React 渲染测试：用**真的** react / react-dom 渲染本插件的两个组件。
 *
 * 为什么在手写替身的 `test/client.smoke.mjs` 之外还需要这一套：
 *   · 替身只实现了 `createElement` + 三个 hook，测不出"组件是不是合法的 React 组件"——
 *     把孩子传成对象、props 写出非法值、hook 用法在真 dispatcher 下直接抛错，这些都会漏；
 *   · 这里走 SSR（`renderToStaticMarkup`）的**真渲染路径**：真 hook 实现 + React 自己的元素校验，
 *     并把渲染期间的 `console.error`（React 的警告通道）当作失败——未知属性、key 缺失、
 *     非法 DOM 属性这类问题会在这里暴露。
 *
 * 覆盖边界（别高估它）：
 *   · SSR 不执行 effect → 目录拉取、订阅、去抖提示**不**在这里测（由 client.smoke.mjs 覆盖）；
 *   · 没有 DOM → 点击、焦点、预设菜单开合**不**在范围（同上）。
 *   · React 版本：本机只能凑到 19.2.8 这一对（dsh 安装里 hoisted `react` 是 18，而 `react-dom`
 *     只存在于某个包的嵌套目录里；18 + 19 混用会直接抛 "Incompatible React versions"）。
 *     组件只用到 18/19 语义一致的 API（useState/useRef/useEffect/createElement），故此差异不影响结论。
 *
 * 运行：node test/client.react.mjs （`npm test` 会跑）
 */

import assert from 'node:assert/strict'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let passed = 0
const failures = []

/**
 * 跑一个用例，记录失败但不中断其余用例。
 * @param {string} label - 用例名。
 * @param {() => void} body - 用例体。
 * @returns {void}
 */
function test(label, body) {
  try {
    body()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ── 假浏览器环境（仅够 apply 里的样式注入与事件注册），然后加载 bundle ── */

const styles = []
let entry

globalThis.window = {
  setTimeout: () => 0,
  clearTimeout: () => {},
  __ModuleLoader__: {
    load: loaded => {
      entry = loaded
    },
  },
}
globalThis.document = {
  head: {
    append: element => {
      styles.push(element)
    },
  },
  createElement: () => ({ id: '', dataset: {}, textContent: '' }),
  getElementById: id => styles.find(style => style.id === id) ?? null,
  addEventListener: () => {},
  removeEventListener: () => {},
}

await import('../lib/client.js')

/**
 * 用真 React 造一个 require 替身：只允许平台种子模块（与框架的种子表一致）。
 * @param {object} primitives - `@deepseek-ai/dsh-client-ui-primitives` 的内容。
 * @returns {(spec: string) => unknown} require 替身。
 */
function requireShim(primitives = {}) {
  return spec => {
    if (spec === 'react') return React
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require("${spec}")`)
  }
}

/**
 * 造一个假客户端 ctx（只为拿到两个座位条目）。
 * @param {object} scope - 假设置作用域。
 * @returns {{ seat: object[], ctx: object }} ctx 与注册观测点。
 */
function fakeCtx(scope) {
  const seat = []
  const ctx = {
    effect: factory => {
      factory()
      return () => {}
    },
    inject: (_deps, body) => {
      body({
        slots: {
          inject: (_key, callback) => callback(),
          register: (options, component) => {
            seat.push({ key: options.name, options, component })
          },
        },
        settingsScope: { bind: () => scope },
      })
    },
    locale: { register: () => () => {}, bind: () => key => key },
  }
  return { seat, ctx }
}

/** 假设置作用域快照（默认可用可写）。 */
const readySnapshot = {
  status: 'ready',
  value: { systemPrompt: '旧提示词' },
  revision: 3,
  writable: true,
  mode: 'host',
}

/**
 * 取本插件的座位组件。
 * @param {{ primitives?: object, snapshot?: object }} [options] - 选项。
 * @returns {object} 座位条目。
 */
function mount(options = {}) {
  const scope = {
    getSnapshot: () => options.snapshot ?? readySnapshot,
    subscribe: () => () => {},
    mutate: async () => {},
  }
  const fake = fakeCtx(scope)
  entry.factory(requireShim(options.primitives ?? {})).apply(fake.ctx)
  return {
    seat: fake.seat,
    button: fake.seat.find(item => item.key === 'conversation.input.right')?.component,
    settings: fake.seat.find(item => item.key === 'settings.section')?.component,
  }
}

/**
 * 渲染期间捕获 `console.error`：React 的警告全走这个通道，出现即视为失败。
 * @param {() => string} render - 渲染函数。
 * @returns {{ html: string, complaints: string[] }} 渲染结果与收集到的告警。
 */
function renderStrict(render) {
  const complaints = []
  const original = console.error
  console.error = (...args) => {
    complaints.push(args.map(String).join(' '))
  }
  try {
    return { html: render(), complaints }
  } finally {
    console.error = original
  }
}

/**
 * 造按钮组件的 props。
 * @param {{ draft?: string, phase?: string, occurrences?: unknown[], sessionId?: string }} [state] - 输入状态。
 * @returns {object} props。
 */
function buttonProps(state = {}) {
  return {
    t: key => key,
    useInput: selector =>
      selector({
        draft: state.draft ?? '帮我写个脚本',
        phase: state.phase ?? 'plain',
        draftRev: 1,
        occurrences: state.occurrences ?? [],
      }),
    inputActions: { setDraft: () => {} },
    sessionId: state.sessionId ?? 'session-1',
  }
}

console.log('react: 输入框按钮（真 React 渲染）')

test('有草稿时渲染出可用按钮，且不触发任何 React 警告', () => {
  const { button } = mount()
  const { html, complaints } = renderStrict(() => renderToStaticMarkup(React.createElement(button, buttonProps())))
  assert.equal(html.includes('data-dsh-better-input="better-input"'), true)
  assert.equal(html.includes('data-state="idle"'), true)
  assert.equal(html.includes('aria-label="optimize"'), true)
  assert.equal(html.includes('disabled'), false, '有草稿不该禁用')
  assert.deepEqual(complaints, [], 'React 不允许有任何告警')
})

test('空草稿 → 禁用；提交中 → 禁用且提示 busy', () => {
  const { button } = mount()
  const empty = renderStrict(() => renderToStaticMarkup(React.createElement(button, buttonProps({ draft: '   ' }))))
  assert.equal(empty.html.includes('disabled'), true)
  assert.equal(empty.html.includes('title="empty"'), true)

  const busy = renderStrict(() =>
    renderToStaticMarkup(React.createElement(button, buttonProps({ phase: 'submitting' }))),
  )
  assert.equal(busy.html.includes('disabled'), true)
  assert.equal(busy.html.includes('title="busy"'), true)
  assert.deepEqual([...empty.complaints, ...busy.complaints], [])
})

test('primitives 缺失时降级为文字符号（真渲染下也不抛错）', () => {
  const { button } = mount({ primitives: {} })
  const { html, complaints } = renderStrict(() => renderToStaticMarkup(React.createElement(button, buttonProps())))
  assert.equal(html.includes('✨'), true)
  assert.deepEqual(complaints, [])
})

test('草稿含芯片（occurrences 非空）仍能渲染（拦截发生在点击时）', () => {
  const { button } = mount()
  const { html, complaints } = renderStrict(() =>
    renderToStaticMarkup(React.createElement(button, buttonProps({ occurrences: [{ ref: '@a.ts' }] }))),
  )
  assert.equal(html.includes('data-dsh-better-input="better-input"'), true)
  assert.deepEqual(complaints, [])
})

console.log('react: 设置页（真 React 渲染）')

test('可用态渲染出完整表单（字段、动作、生效来源）', () => {
  const { settings } = mount()
  const { html, complaints } = renderStrict(() =>
    renderToStaticMarkup(
      React.createElement(settings, {
        t: key => key,
        settings: {
          getSnapshot: () => readySnapshot,
          subscribe: () => () => {},
          mutate: async () => {},
        },
        catalog: { load: async () => ({}), models: async () => [], check: async () => ({ ok: true }) },
      }),
    ),
  )
  assert.equal(html.includes('data-dsh-bi-settings="ready"'), true)
  for (const field of [
    'customPromptEnabled',
    'systemPrompt',
    'modelProvider',
    'modelId',
    'temperature',
    'maxOutputTokens',
    'timeoutMs',
  ]) {
    assert.equal(html.includes(`data-dsh-bi-field="${field}"`), true, `缺少字段 ${field}`)
  }
  for (const action of ['save', 'test', 'reset']) {
    assert.equal(html.includes(`data-dsh-bi-action="${action}"`), true, `缺少动作 ${action}`)
  }
  assert.equal(html.includes('for="dsh-bi-prompt"'), true, '提示词 textarea 必须有可访问名')
  assert.deepEqual(complaints, [])
})

test('不可用态渲染出提示，并且没有表单控件', () => {
  const { settings } = mount({ snapshot: { status: 'unavailable', writable: false, mode: 'memory' } })
  const { html, complaints } = renderStrict(() =>
    renderToStaticMarkup(
      React.createElement(settings, {
        t: key => key,
        settings: {
          getSnapshot: () => ({ status: 'unavailable', writable: false, mode: 'memory' }),
          subscribe: () => () => {},
          mutate: async () => {},
        },
        catalog: { load: async () => ({}), models: async () => [], check: async () => ({ ok: true }) },
      }),
    ),
  )
  assert.equal(html.includes('data-dsh-bi-settings="unavailable"'), true)
  assert.equal(html.includes('settings.unavailable'), true)
  assert.equal(html.includes('data-dsh-bi-field="systemPrompt"'), false, '不可用态不该有输入控件')
  assert.deepEqual(complaints, [])
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
