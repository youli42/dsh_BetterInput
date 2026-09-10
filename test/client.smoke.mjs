/**
 * better-input 浏览器半冒烟测试：不起浏览器、不装 React，用测试替身检查
 * 「bundle 包装 → 座位注册 → 组件契约 → 优化接线（P2）→ 撤销栈（P3）」。
 *
 * 为什么不装 React 跑真渲染：本工作区没有 react/react-dom 依赖，而这里的风险不在
 * React 本身，而在「对框架注入 props 的假设」「座位注册参数」「CAS/撤销语义」——
 * 一个最小 React 替身（createElement + 三个 hook）+ 会更新快照的 harness 就够钉住。
 *
 * 关键建模：框架给座位组件的是**点快照** owner props（`InputZone.input`）。
 * harness 因此把「真值 truth」与「每次渲染生成的新快照」分开——只有 `view()` 才刷新
 * 交给组件的快照，这样才能真实复现「往返期间草稿被改 → CAS 失败」这条路径。
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

/* ── 假的 React：只实现本插件用到的 API ────────────────────────────────── */

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

/* ── fetch 替身：可悬挂、可结算、可取消 ────────────────────────────────── */

/**
 * 装一个可手动结算的 fetch 替身。
 * @returns {object} 门面：calls / pendingCount / respond / fail。
 */
function installFetch() {
  const calls = []
  const entries = []
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    const record = {
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    }
    calls.push(record)
    /** 只允许结算一次，并记录已结算（取消也走这里）。 */
    const entry = {
      settled: false,
      settle: (settleWith, value) => {
        if (entry.settled) return
        entry.settled = true
        settleWith(value)
      },
    }
    entries.push(entry)
    if (init?.signal !== undefined) {
      const onAbort = () => entry.settle(reject, new DOMException('aborted', 'AbortError'))
      if (init.signal.aborted) onAbort()
      else init.signal.addEventListener('abort', onAbort)
    }
    entry.resolve = (value) => entry.settle(resolve, value)
    entry.reject = (error) => entry.settle(reject, error)
  })
  /** 取最后一个未结算的请求条目。 */
  const pendingEntry = () => {
    const last = entries.findLast(item => !item.settled)
    assert.ok(last !== undefined, '没有待结算的请求')
    return last
  }
  return {
    calls,
    get pendingCount() { return entries.filter(item => !item.settled).length },
    /**
     * 结算最后一次请求。
     * @param {{ status?: number, data?: unknown }} options - 响应内容。
     * @returns {void}
     */
    respond(options = {}) {
      const status = options.status ?? 200
      pendingEntry().resolve({ ok: status >= 200 && status < 300, status, json: async () => options.data ?? {} })
    },
    /**
     * 让最后一次请求抛错（网络层失败）。
     * @param {Error} error - 抛出的错误。
     * @returns {void}
     */
    fail(error) {
      pendingEntry().reject(error)
    },
  }
}

/* ── harness：真值 + 点快照 + 渲染 ─────────────────────────────────────── */

let sessionCounter = 0
/** 每个用例用独立 sessionId，等价于「干净会话」→ 撤销栈天然隔离。 */
const nextSessionId = () => `session-${String(++sessionCounter)}`

/**
 * 挂载一次组件：模块 → apply → 座位条目 → 组件。
 * @param {{ draft?: string, phase?: string, sessionId?: string, primitives?: object }} options - 初始状态。
 * @returns {object} harness。
 */
function mount(options = {}) {
  const truth = {
    draft: options.draft ?? '帮我写个脚本',
    phase: options.phase ?? 'plain',
    draftRev: 1,
    occurrences: [],
  }
  const sessionId = options.sessionId ?? nextSessionId()
  const { ctx, seat } = fakeCtx()
  entry.factory(requireShim(options.primitives ?? {})).apply(ctx)
  const component = seat[0].component
  const written = []

  /** 渲染一次：从真值生成新快照（模拟框架给组件的 owner props 点快照）。 */
  const view = () => {
    const snapshot = { ...truth, occurrences: [...truth.occurrences] }
    const props = {
      t: (key) => key,
      useInput: (selector) => selector(snapshot),
      inputActions: {
        setDraft: (text) => {
          written.push(text)
          truth.draft = text
          truth.draftRev += 1
        },
      },
      sessionId,
      input: snapshot,
    }
    cursor = 0
    const node = component(props)
    const buttons = childrenOf(node).filter(child => child.type === 'button')
    const note = childrenOf(node).find(child => child.type === 'span')
    return {
      node,
      optimize: buttons.find(button => button.props['data-dsh-better-input'] !== undefined),
      undo: buttons.find(button => button.props['data-dsh-better-input-undo'] !== undefined) ?? null,
      /** 提示正文（无提示时为 null）。 */
      get noteText() { return note === undefined ? null : childrenOf(note)[0] },
      get noteTone() { return note === undefined ? null : note.props['data-tone'] },
    }
  }

  return {
    truth,
    sessionId,
    written,
    /** 改真值（模拟用户打字并被框架提交）。 */
    type(text) { truth.draft = text; truth.draftRev += 1 },
    setOccurrences(list) { truth.occurrences = list },
    view,
  }
}

const SEAT = 'conversation.input.right'
const ROUTE = '/api/dsh-input-optimizer/optimize'

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
  assert.deepEqual(
    Object.keys(dictionaries[0].dictionary.zh).sort(),
    Object.keys(dictionaries[0].dictionary.en).sort(),
    '中英词典必须同键',
  )
  assert.equal(appendedStyles.length, 1, '样式应注入一次')
  assert.equal(seat.length, 1)
  assert.equal(seat[0].key, SEAT, '必须注册进 conversation.input.right（模型紧左边）')
  const options = seat[0].options
  assert.equal(options.id, 'better-input', 'list 座位必须给 id')
  assert.equal(typeof options.order, 'number')
  assert.equal(options.locale, 'inputOptimizer')
  entry.factory(requireShim({})).apply(fakeCtx().ctx)
  assert.equal(appendedStyles.length, 1, '样式注入必须幂等')
})

console.log('client half: 按钮状态与无障碍')
await test('有草稿时按钮可用，标记与无障碍属性齐全', () => {
  const { optimize } = mount({ draft: '帮我写个脚本' }).view()
  assert.equal(optimize.props.type, 'button')
  assert.equal(optimize.props.className, 'dsh-better-input')
  assert.equal(optimize.props['data-dsh-better-input'], 'better-input')
  assert.equal(optimize.props['data-state'], 'idle')
  assert.equal(optimize.props['aria-label'], 'optimize')
  assert.equal(optimize.props.title, 'optimize')
  assert.equal(optimize.props.disabled, false)
  assert.equal(typeof optimize.props.onMouseDown, 'function', '必须阻止 mousedown 抢焦点')
})
await test('空草稿禁用；提交/裁决中禁用', () => {
  assert.equal(mount({ draft: '   ' }).view().optimize.props.disabled, true)
  assert.equal(mount({ draft: '   ' }).view().optimize.props.title, 'empty')
  assert.equal(mount({ draft: 'x', phase: 'submitting' }).view().optimize.props.disabled, true)
  assert.equal(mount({ draft: 'x', phase: 'claimed' }).view().optimize.props.title, 'busy')
})
await test('没有撤销记录时不渲染撤销按钮', () => {
  assert.equal(mount({ draft: 'x' }).view().undo, null)
})
await test('图标缺失时降级为文字符号，不抛错', () => {
  const { optimize } = mount({ draft: 'x', primitives: {} }).view()
  assert.equal(childrenOf(optimize)[0], '✨')
})

console.log('client half: P2 接线')
await test('成功路径：POST 到宿主路由并 setDraft，随后出现撤销按钮', async () => {
  const network = installFetch()
  const harness = mount({ draft: '帮我写个脚本' })
  const pending = harness.view().optimize.props.onClick()
  assert.equal(network.calls.length, 1)
  assert.equal(network.calls[0].url, ROUTE)
  assert.equal(network.calls[0].method, 'POST')
  assert.equal(network.calls[0].headers['content-type'], 'application/json')
  assert.deepEqual(network.calls[0].body, { text: '帮我写个脚本', sessionId: harness.sessionId })

  network.respond({ data: { text: '请把脚本改写成……' } })
  await pending

  assert.deepEqual(harness.written, ['请把脚本改写成……'])
  const after = harness.view()
  assert.equal(after.noteText, 'done')
  assert.equal(after.noteTone, 'ok')
  assert.notEqual(after.undo, null, '成功替换后应出现撤销按钮')
  assert.equal(after.undo.props['data-state'], 'clean')
})
await test('生成中再点 = 取消：不提示失败，回到 idle', async () => {
  const network = installFetch()
  const harness = mount({ draft: 'x' })
  const first = harness.view().optimize.props.onClick()
  const running = harness.view()
  assert.equal(running.optimize.props['data-state'], 'running')
  assert.equal(running.optimize.props['aria-label'], 'cancel')
  assert.equal(running.optimize.props.disabled, false, '生成中必须可点（=取消）')

  await running.optimize.props.onClick()   // 取消
  await first

  assert.equal(network.pendingCount, 0)
  const settled = harness.view()
  assert.equal(settled.optimize.props['data-state'], 'idle')
  assert.deepEqual(harness.written, [], '取消不得写入草稿')
})
await test('CAS：往返期间草稿被改 → 丢弃结果，不覆盖输入', async () => {
  const network = installFetch()
  const harness = mount({ draft: '原文' })
  const pending = harness.view().optimize.props.onClick()
  harness.type('用户自己又改了')   // 用户继续打字
  harness.view()                  // 框架把新快照推给组件

  network.respond({ data: { text: '模型结果' } })
  await pending

  assert.deepEqual(harness.written, [], '草稿已变化时不得写入')
  const settled = harness.view()
  assert.equal(settled.noteText, 'staleResult')
  assert.equal(settled.noteTone, 'warn')
  assert.equal(settled.undo, null, '被丢弃的结果不入撤销栈')
})
await test('宿主错误：优先展示宿主 message；403/404 有专门文案', async () => {
  const network = installFetch()
  const harness = mount({ draft: 'x' })
  const pending = harness.view().optimize.props.onClick()
  network.respond({ status: 400, data: { error: 'text-too-long', message: '草稿 9001 字，超过上限 8000 字' } })
  await pending
  assert.equal(harness.view().noteText, '草稿 9001 字，超过上限 8000 字')
  assert.equal(harness.view().noteTone, 'error')
  assert.deepEqual(harness.written, [])

  const forbidden = installFetch()
  const second = mount({ draft: 'x' })
  const pendingTwo = second.view().optimize.props.onClick()
  forbidden.respond({ status: 403, data: { error: 'forbidden' } })
  await pendingTwo
  assert.equal(second.view().noteText, 'forbidden')

  const missing = installFetch()
  const third = mount({ draft: 'x' })
  const pendingThree = third.view().optimize.props.onClick()
  missing.respond({ status: 404, data: null })
  await pendingThree
  assert.equal(third.view().noteText, 'notMounted')
})
await test('网络失败与空结果都有可读文案，且不入栈', async () => {
  const network = installFetch()
  const harness = mount({ draft: 'x' })
  const pending = harness.view().optimize.props.onClick()
  network.fail(new TypeError('Failed to fetch'))
  await pending
  assert.equal(harness.view().noteText, 'network')
  assert.equal(harness.view().undo, null)

  const second = installFetch()
  const other = mount({ draft: 'x' })
  const pendingTwo = other.view().optimize.props.onClick()
  second.respond({ data: { text: '   ' } })
  await pendingTwo
  assert.equal(other.view().noteText, 'emptyResult')
})
await test('截断结果仍替换，但提示换成 truncated 文案', async () => {
  const network = installFetch()
  const harness = mount({ draft: 'x' })
  const pending = harness.view().optimize.props.onClick()
  network.respond({ data: { text: '半截', truncated: true } })
  await pending
  assert.deepEqual(harness.written, ['半截'])
  assert.equal(harness.view().noteText, 'doneTruncated')
})
await test('草稿含芯片时拒绝发请求（整体替换会丢引用）', async () => {
  const network = installFetch()
  const harness = mount({ draft: '看下 @a.ts' })
  harness.setOccurrences([{ occurrenceId: 1 }])
  await harness.view().optimize.props.onClick()
  assert.equal(network.calls.length, 0, '不得发起请求')
  assert.equal(harness.view().noteText, 'chips')
  assert.deepEqual(harness.written, [])
})

console.log('client half: P3 撤销栈')
await test('撤销恢复原文并弹栈（按钮消失）', async () => {
  const network = installFetch()
  const harness = mount({ draft: '原文' })
  const pending = harness.view().optimize.props.onClick()
  network.respond({ data: { text: '优化后' } })
  await pending
  assert.equal(harness.truth.draft, '优化后')

  await harness.view().undo.props.onClick()
  assert.equal(harness.truth.draft, '原文', '撤销必须回到优化前的草稿')
  assert.equal(harness.written.at(-1), '原文')
  const after = harness.view()
  assert.equal(after.undo, null, '栈空后撤销按钮消失')
  assert.equal(after.noteText, 'undone')
})
await test('连续两次优化可逐层撤销', async () => {
  const harness = mount({ draft: 'A' })
  for (const [input, output] of [['A', 'B'], ['B', 'C']]) {
    assert.equal(harness.truth.draft, input)
    const network = installFetch()
    const pending = harness.view().optimize.props.onClick()
    network.respond({ data: { text: output } })
    await pending
  }
  assert.equal(harness.truth.draft, 'C')

  await harness.view().undo.props.onClick()
  assert.equal(harness.truth.draft, 'B', '第一层撤销 → 上一次的输入')
  assert.notEqual(harness.view().undo, null, '还有一层可撤')
  await harness.view().undo.props.onClick()
  assert.equal(harness.truth.draft, 'A', '第二层撤销 → 最初的草稿')
  assert.equal(harness.view().undo, null)
})
await test('撤销前草稿被手改：第一次点击只警告，第二次强制还原', async () => {
  const network = installFetch()
  const harness = mount({ draft: '原文' })
  const pending = harness.view().optimize.props.onClick()
  network.respond({ data: { text: '优化后' } })
  await pending

  harness.type('用户又改了')   // 撤销 CAS 失败
  const dirty = harness.view()
  assert.equal(dirty.undo.props['data-state'], 'dirty')
  await dirty.undo.props.onClick()
  assert.equal(harness.truth.draft, '用户又改了', '第一次点击不得直接覆盖')
  assert.equal(harness.view().noteText, 'undoDirty')

  await harness.view().undo.props.onClick()   // 第二次 = 强制
  assert.equal(harness.truth.draft, '原文')
  assert.equal(harness.view().noteText, 'undoneForced')
  assert.equal(harness.view().undo, null)
})
await test('撤销栈深度上限 10（最旧的被丢弃）', async () => {
  const harness = mount({ draft: 'd0' })
  for (let index = 1; index <= 12; index += 1) {
    const network = installFetch()
    const pending = harness.view().optimize.props.onClick()
    network.respond({ data: { text: `d${String(index)}` } })
    await pending
  }
  assert.equal(harness.truth.draft, 'd12')
  let depth = 0
  while (harness.view().undo !== null && depth < 20) {
    await harness.view().undo.props.onClick()
    depth += 1
  }
  assert.equal(depth, 10, '只保留最近 10 层')
  assert.equal(harness.truth.draft, 'd2', '超出深度的最旧记录已丢弃')
})
await test('不同会话的撤销栈互不干扰', async () => {
  const network = installFetch()
  const first = mount({ draft: 'A 会话原文' })
  const pending = first.view().optimize.props.onClick()
  network.respond({ data: { text: 'A 会话优化后' } })
  await pending
  assert.equal(first.view().undo !== null, true)

  const second = mount({ draft: 'B 会话原文' })
  assert.equal(second.view().undo, null, 'B 会话不该看到 A 的撤销记录')
  assert.equal(second.truth.draft, 'B 会话原文', 'B 会话草稿不得被 A 的撤销影响')
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
