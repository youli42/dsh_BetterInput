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
    // 支持函数式更新（组件里 setForm(current => ...) / setStackVersion(v => v + 1) 都靠它）。
    return [hookSlots[index], next => { hookSlots[index] = typeof next === 'function' ? next(hookSlots[index]) : next }]
  },
  useRef(initial) {
    const index = cursor++
    hookSlots[index] ??= { current: initial }
    return hookSlots[index]
  },
  /**
   * 带 deps 的 useEffect 替身：首次渲染跑一次，deps 变化时重跑并先执行上一次的清理。
   * （不是 React 的提交语义，但足以驱动订阅/拉目录这类挂载副作用，并让「切 provider 重拉模型」
   * 这类依赖驱动的行为可测。）
   */
  useEffect(effect, deps) {
    const index = cursor++
    const slot = hookSlots[index] ??= { deps: undefined, cleanup: undefined }
    const previous = slot.deps
    const changed = deps === undefined || previous === undefined || deps.length !== previous.length
      || deps.some((value, position) => value !== previous[position])
    if (!changed) return
    if (typeof slot.cleanup === 'function') slot.cleanup()
    slot.deps = deps
    slot.cleanup = effect() ?? undefined
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
  clearTimeout: () => {},
  __ModuleLoader__: { load: (loaded) => { entry = loaded } },
}
globalThis.document = {
  head: { append: (element) => { appendedStyles.push(element) } },
  // 真 DOM 的元素一定有 `dataset`（插件用它给自己的 <style> 打 data-plugin 归属标记），
  // 替身少这一层就会掩盖「样式会被别的插件认领走」这类问题。
  createElement: () => ({ id: '', textContent: '', dataset: {} }),
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
 * 造一个假设置作用域（对齐 ctx.settingsScope.bind 的契约）。
 * @param {object} options - 替身参数。
 * @returns {object} 假 scope。
 */
function makeFakeScope(options = {}) {
  const mutations = []
  const listeners = []
  let snapshot = {
    status: options.settingsStatus ?? 'ready',
    value: options.settingsValue,
    base: {},
    user: {},
    revision: options.settingsRevision ?? 7,
    writable: options.writable !== false,
    mode: options.mode ?? 'host',
  }
  return {
    mutations,
    /** 直接改快照（模拟远端提交），并通知订阅者。 */
    publish(next) {
      snapshot = { ...snapshot, ...next }
      for (const listener of listeners) listener()
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.push(listener)
      return () => {
        const at = listeners.indexOf(listener)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
    /**
     * 对齐真实的 `SettingsScopeController.mutate`：
     * **宿主拒绝时不 reject**——它内部 `recover()`（重读宿主状态）之后正常返回；
     * 只有装配错误（arity/未挂载方法/缺 Context adapter）才会抛。
     * 所以这里分两个开关：`mutateRefuse` 模拟宿主拒绝（静默、值不变），
     * `mutateFail` 模拟装配错误（抛）。
     * @param {Array<object>} ops - path ops。
     * @param {number} revision - 期望版本。
     * @returns {Promise<void>} 完成。
     */
    async mutate(ops, revision) {
      mutations.push({ ops, revision })
      if (options.mutateFail !== undefined) throw options.mutateFail
      if (options.mutateRefuse === true) {
        // 宿主拒绝：值不动，只把最新宿主状态重读一遍通知订阅者。
        for (const listener of listeners) listener()
        return
      }
      // 模拟宿主机接受：把 ops 落到 value 上并推进 revision（供「保存后回到已保存态」验证）。
      const value = { ...(snapshot.value ?? {}) }
      for (const op of ops) {
        const field = op.path[0]
        if (op.op === 'set') value[field] = op.value
        else delete value[field]
      }
      const next = { ...snapshot, value, revision: snapshot.revision + 1 }
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

/**
 * 造一个假客户端 ctx。
 * @param {object} options - 替身参数（透传给假设置作用域）。
 * @returns {{ ctx: object, seat: object[], dictionaries: object[], binds: object[], scope: object }} ctx 与观测点。
 */
function fakeCtx(options = {}) {
  const seat = []
  const dictionaries = []
  const binds = []
  const scope = makeFakeScope(options)
  const ctx = {
    effect(factory) {
      return factory()
    },
    inject(_deps, body) {
      body({
        slots: {
          inject: (_key, callback) => callback(),
          register: (registerOptions, component) => { seat.push({ key: registerOptions.name, options: registerOptions, component }) },
        },
        settingsScope: {
          bind(spec) {
            binds.push(spec)
            return scope
          },
        },
      })
    },
    locale: {
      register: (namespace, dictionary) => { dictionaries.push({ namespace, dictionary }); return () => {} },
      bind: () => (key) => key,
    },
  }
  return { ctx, seat, dictionaries, binds, scope }
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
 * 让微任务队列跑空：驱动「拉取目录/模型」这类挂载副作用的落地。
 * @param {number} rounds - 轮数。
 * @returns {Promise<void>} 完成。
 */
async function tick(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

/**
 * 挂载一次组件：模块 → apply → 座位条目 → 组件。
 * 座位条目有两个（输入框按钮 + 设置页分区），这里按座位 key 取需要的那个。
 *
 * `options.shared` 用来复用**同一个 factory 作用域**（= 同一份模块级撤销栈）挂多个会话：
 * 传同一个空对象进多次 mount 即可。不传时每次 mount 都是新模块实例（默认，最贴近"页面重载"）。
 * @param {{ draft?: string, phase?: string, sessionId?: string, primitives?: object, inputZone?: boolean,
 *   settings?: object, shared?: object }} options - 初始状态（settings 透传给假设置作用域）。
 * @returns {object} harness。
 */
function mount(options = {}) {
  // 每次挂载都是新实例：hook 槽位必须清空，否则同一用例里第二次 mount 会读到上一个组件的状态。
  hookSlots.length = 0
  cursor = 0
  const truth = {
    draft: options.draft ?? '帮我写个脚本',
    phase: options.phase ?? 'plain',
    draftRev: 1,
    occurrences: [],
  }
  const sessionId = options.sessionId ?? nextSessionId()
  const shared = options.shared ?? {}
  if (shared.component === undefined) {
    const fake = fakeCtx(options.settings ?? {})
    entry.factory(requireShim(options.primitives ?? {})).apply(fake.ctx)
    shared.component = fake.seat.find(item => item.key === SEAT)?.component
    shared.section = fake.seat.find(item => item.key === 'settings.section')
    shared.scope = fake.scope
    shared.binds = fake.binds
    shared.seat = fake.seat
  }
  const composerEntry = shared.component === undefined ? undefined : { component: shared.component }
  const sectionEntry = shared.section
  assert.ok(composerEntry !== undefined, 'composer 座位条目必须注册')
  const component = composerEntry.component
  const written = []

  /** 渲染一次：从真值生成新快照（模拟框架给组件的会话标准道具）。 */
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
      // 默认**不**提供 owner props：已安装版本（0.1.2-rc.1）对 conversation.input.left/right
      // 调的是 renderSlot(name, {})，props.input 必然是 undefined；只有新版本源码才传 InputZone。
      ...options.inputZone === true ? { input: snapshot, session: { sessionId } } : {},
    }
    cursor = 0
    const node = component(props)
    const buttons = childrenOf(node).filter(child => child.type === 'button')
    const note = childrenOf(node).find(child => child.type === 'span')
    return {
      node,
      props,
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
    seat: shared.seat,
    binds: shared.binds,
    scope: shared.scope,
    section: sectionEntry,
    /** 改真值（模拟用户打字并被框架提交）。 */
    type(text) { truth.draft = text; truth.draftRev += 1 },
    setOccurrences(list) { truth.occurrences = list },
    view,
  }
}

const SEAT = 'conversation.input.right'
const ROUTE = '/api/dsh-input-optimizer/optimize'
const ROUTE_CATALOG = '/api/dsh-input-optimizer/catalog'
const ROUTE_CATALOG_MODELS = '/api/dsh-input-optimizer/catalog/models'
const ROUTE_CHECK = '/api/dsh-input-optimizer/check'
const SETTINGS_NAMESPACE = 'better-input'

/* ── 设置页 harness：假 scope + 假目录路由 ─────────────────────────────── */

/**
 * 装一个按路径应答的 fetch 替身（设置页用）。
 * @param {{ catalog?: object, models?: object[], check?: object, failCatalog?: boolean }} options - 响应内容。
 * @returns {{ calls: object[] }} 观测点。
 */
function installSettingsFetch(options = {}) {
  const calls = []
  const respond = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
  globalThis.fetch = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    })
    if (url.startsWith(ROUTE_CATALOG_MODELS)) return respond({ models: options.models ?? [{ id: 'm1', name: 'M1' }] })
    if (url === ROUTE_CATALOG) {
      if (options.failCatalog === true) return respond({}, 500)
      return respond(options.catalog ?? {
        namespace: SETTINGS_NAMESPACE,
        settings: { available: true, section: {} },
        providers: [{ id: 'acme', name: 'Acme' }, { id: 'deepseek-official', name: 'DeepSeek' }],
        effective: {
          provider: null,
          model: null,
          temperature: null,
          maxOutputTokens: 1024,
          timeoutMs: 30000,
          sources: { prompt: 'default', model: 'none', temperature: 'default', limits: 'default' },
        },
      })
    }
    if (url === ROUTE_CHECK) return respond(options.check ?? { ok: true, provider: 'acme', model: 'm1', name: 'Acme M1' })
    return respond({}, 404)
  }
  return { calls }
}

/**
 * 把设置页组件渲染出来（走真实注册路径拿组件与注入面）。
 * @param {{ settingsValue?: object, settingsStatus?: string, writable?: boolean, mutateFail?: Error,
 *   mode?: string, catalog?: object, models?: object[], check?: object, failCatalog?: boolean }} options - 参数。
 * @returns {object} 视图与观测点。
 */
function mountSettings(options = {}) {
  const network = installSettingsFetch(options)
  const harness = mount({
    settings: {
      settingsValue: options.settingsValue,
      settingsStatus: options.settingsStatus,
      writable: options.writable,
      mode: options.mode,
      mutateFail: options.mutateFail,
      mutateRefuse: options.mutateRefuse,
    },
  })
  assert.ok(harness.section !== undefined, '设置分区条目必须注册')
  const face = harness.section.options.inject()

  /** 渲染一次（允许调用多次模拟重渲染）。 */
  const view = () => {
    cursor = 0
    const node = harness.section.component(face)
    const inputs = new Map()
    const buttons = []
    const notes = []
    const errors = []
    const datalists = new Map()
    /** 递归收集（元素是嵌套的：按钮在 .dsh-bi-actions 里，datalist 在 fieldset 里）。 */
    const walk = (element) => {
      if (element === null || typeof element !== 'object') return
      const className = typeof element.props?.className === 'string' ? element.props.className : ''
      if (element.props?.['data-dsh-bi-field'] !== undefined) inputs.set(element.props['data-dsh-bi-field'], element)
      if (element.props?.['data-dsh-bi-action'] !== undefined) buttons.push(element)
      if (className.includes('dsh-bi-note')) notes.push(element)
      if (className === 'dsh-bi-error') errors.push(childrenOf(element)[0])
      if (element.type === 'datalist' && typeof element.props.id === 'string') datalists.set(element.props.id, element)
      for (const child of childrenOf(element)) walk(child)
    }
    walk(node)
    return {
      node,
      face,
      buttons,
      inputs,
      errors,
      notes,
      datalists,
      noteText: notes.length === 0 ? null : childrenOf(notes[notes.length - 1])[0],
      noteTone: notes.length === 0 ? null : notes[notes.length - 1].props['data-tone'],
      action(name) {
        const button = buttons.find(item => item.props['data-dsh-bi-action'] === name)
        assert.ok(button !== undefined, `action ${name} must exist`)
        return button
      },
    }
  }

  return { harness, network, view, face, scope: harness.scope, binds: harness.binds }
}

console.log('client half: bundle 包装与插件契约')
await test('bundle id 必须等于包名，factory 返回 apply/inject', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(entry !== undefined, 'window.__ModuleLoader__.load 未被调用')
  assert.equal(entry.id, pkg.name, 'bundle id 必须等于包名')
  const exports = entry.factory(requireShim({}))
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['slots', 'locale', 'settingsScope'])
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
  // 样式标签必须自带归属标记：不打标的话下一个物化的插件会在 claimStyles 里把它认领走，
  // 那个插件 HMR 重载时按 style[data-plugin] 删除，本插件的样式就被顺手删掉。
  assert.equal(appendedStyles[0].dataset.plugin, 'dsh-better-input')
  assert.equal(appendedStyles[0].dataset.pluginCss, 'dsh-better-input/style.css')
  assert.deepEqual(
    seat.map(item => item.key).sort(),
    [SEAT, 'settings.section'].sort(),
    '两个条目：输入框按钮 + 设置页分区',
  )
  const options = seat.find(item => item.key === SEAT).options
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

console.log('client half: owner props 缺失（已安装版本形状）')
await test('无 owner props 时读取全走 useInput，点击不抛错', async () => {
  const network = installFetch()
  const harness = mount({ draft: '我的草稿' })
  const view = harness.view()
  assert.equal(view.props.input, undefined, '本用例必须模拟「没有 InputZone owner props」')
  assert.equal(view.props.session, undefined)
  // 组件渲染只依赖 useInput / inputActions / sessionId / t
  assert.equal(view.optimize.props.disabled, false)
  const pending = view.optimize.props.onClick()   // 同步段不得抛错（旧版曾在此读 props.input.phase）
  assert.equal(network.calls.length, 1)
  assert.deepEqual(network.calls[0].body, { text: '我的草稿', sessionId: harness.sessionId })
  network.respond({ data: { text: '优化后的草稿' } })
  await pending
  assert.deepEqual(harness.written, ['优化后的草稿'])
})
await test('新版本形状（带 InputZone owner props）行为一致', async () => {
  const network = installFetch()
  const harness = mount({ draft: '我的草稿', inputZone: true })
  const view = harness.view()
  assert.notEqual(view.props.input, undefined, '本用例必须带上 owner props')
  const pending = view.optimize.props.onClick()
  network.respond({ data: { text: '优化后的草稿' } })
  await pending
  assert.deepEqual(harness.written, ['优化后的草稿'])
  assert.notEqual(harness.view().undo, null)
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
await test('宿主错误：优先展示宿主 message；403/404/405 有专门文案', async () => {
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

  // 真机上宿主半没挂载时 POST 拿到的是 **405 空体**（SPA fallback 先拦非 GET/HEAD，
  // 再去找文件），所以 405 必须和 404 一样映射到「路由未挂载」。
  const unmounted = installFetch()
  const fourth = mount({ draft: 'x' })
  const pendingFour = fourth.view().optimize.props.onClick()
  unmounted.respond({ status: 405, data: null })
  await pendingFour
  assert.equal(fourth.view().noteText, 'notMounted')

  // 插件自己的 405 带 JSON message（"只接受 POST"），必须优先展示它而不是兜底文案。
  const methodNotAllowed = installFetch()
  const fifth = mount({ draft: 'x' })
  const pendingFive = fifth.view().optimize.props.onClick()
  methodNotAllowed.respond({ status: 405, data: { error: 'method-not-allowed', message: '只接受 POST' } })
  await pendingFive
  assert.equal(fifth.view().noteText, '只接受 POST')
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
await test('撤销栈按会话数上限淘汰（会话被删时没有任何通知能到达插件）', async () => {
  const SESSIONS = 21   // 超过 MAX_UNDO_SESSIONS(20)
  // 同一个 factory 作用域（共享模块级撤销栈），每个会话一个组件实例。
  const shared = {}
  const first = mount({ draft: 's0 原文', sessionId: 's-0', shared })
  const firstNetwork = installFetch()
  const firstPending = first.view().optimize.props.onClick()
  firstNetwork.respond({ data: { text: 's0 优化后' } })
  await firstPending
  assert.equal(first.view().undo !== null, true)

  for (let index = 1; index < SESSIONS; index += 1) {
    const session = mount({ draft: `s${String(index)} 原文`, sessionId: `s-${String(index)}`, shared })
    const network = installFetch()
    const pending = session.view().optimize.props.onClick()
    network.respond({ data: { text: `s${String(index)} 优化后` } })
    await pending
  }
  // 最久未使用的会话被淘汰：它的栈不再存在，撤销按钮消失（草稿本身不受影响）。
  assert.equal(first.view().undo, null, '超出会话数上限后最旧的撤销栈应被丢弃')
  assert.equal(first.truth.draft, 's0 优化后', '淘汰只影响撤销记录，不碰草稿')
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
  // 必须共用同一个 factory 作用域（shared）：各自 mount 一个模块实例的话，
  // 隔离只是"两个模块各自有一张 Map"这种平凡结论，测不出按会话分栈的逻辑。
  const shared = {}
  const network = installFetch()
  const first = mount({ draft: 'A 会话原文', sessionId: 'session-A', shared })
  const pending = first.view().optimize.props.onClick()
  network.respond({ data: { text: 'A 会话优化后' } })
  await pending
  assert.equal(first.view().undo !== null, true)

  const second = mount({ draft: 'B 会话原文', sessionId: 'session-B', shared })
  assert.equal(second.view().undo, null, 'B 会话不该看到 A 的撤销记录')
  assert.equal(second.truth.draft, 'B 会话原文', 'B 会话草稿不得被 A 的撤销影响')

  // A 撤销只动 A 的草稿。
  await first.view().undo.props.onClick()
  assert.equal(first.truth.draft, 'A 会话原文')
  assert.equal(second.truth.draft, 'B 会话原文')
})

console.log('client half: 设置页')
await test('注册进 settings.section，并按命名空间绑定设置作用域', () => {
  const harness = mount({})
  assert.deepEqual(harness.binds, [{ namespace: SETTINGS_NAMESPACE }])
  assert.equal(harness.section.options.id, 'better-input')
  assert.equal(typeof harness.section.options.order, 'number')
  assert.equal(harness.section.options.label(), 'settings.nav', 'label 必须是可解析的 thunk')
  const face = harness.section.options.inject()
  assert.equal(face.settings, harness.scope, '注入面必须给出绑定的设置作用域')
  assert.equal(typeof face.catalog.load, 'function')
  assert.equal(typeof face.catalog.models, 'function')
  assert.equal(typeof face.catalog.check, 'function')
})
await test('未配置时表单显示为空，且不报错（回落到默认）', () => {
  const page = mountSettings({ settingsValue: undefined })
  const view = page.view()
  assert.equal(view.inputs.get('customPromptEnabled').props.checked, false)
  assert.equal(view.inputs.get('systemPrompt').props.value, '')
  assert.equal(view.inputs.get('modelProvider').props.value, '')
  assert.equal(view.inputs.get('modelId').props.value, '')
  assert.equal(view.errors.length, 0, '未配置不该有校验错误')
  assert.equal(view.action('save').props.disabled, false)
  // 首屏拉了目录，并展示「当前生效」一行
  assert.equal(page.network.calls.some(call => call.url === ROUTE_CATALOG), true)
})
await test('已保存的配置会被回填（刷新页面后仍然显示）', () => {
  const page = mountSettings({
    settingsValue: {
      customPromptEnabled: true,
      systemPrompt: '我的提示词',
      modelProvider: 'acme',
      modelId: 'm1',
      temperature: 0.4,
      maxOutputTokens: 2048,
      timeoutMs: 15000,
    },
  })
  const view = page.view()
  assert.equal(view.inputs.get('customPromptEnabled').props.checked, true)
  assert.equal(view.inputs.get('systemPrompt').props.value, '我的提示词')
  assert.equal(view.inputs.get('modelProvider').props.value, 'acme')
  assert.equal(view.inputs.get('modelId').props.value, 'm1')
  assert.equal(view.inputs.get('temperature').props.value, '0.4')
  assert.equal(view.inputs.get('maxOutputTokens').props.value, '2048')
  assert.equal(view.inputs.get('timeoutMs').props.value, '15000')
})
await test('改动后保存：只发变化的字段，带 revision，原子提交', async () => {
  const page = mountSettings({ settingsValue: { modelProvider: 'acme', modelId: 'm1' } })
  let view = page.view()
  view.inputs.get('systemPrompt').props.onChange({ target: { value: '新提示词' } })
  view.inputs.get('customPromptEnabled').props.onChange({ target: { checked: true } })
  view.inputs.get('temperature').props.onChange({ target: { value: '0.2' } })
  view = page.view()
  await view.action('save').props.onClick()

  assert.equal(page.scope.mutations.length, 1)
  const { ops, revision } = page.scope.mutations[0]
  assert.equal(revision, 7, '必须带读到的 revision（版本栅栏）')
  assert.deepEqual(ops, [
    { op: 'set', path: ['customPromptEnabled'], value: true },
    { op: 'set', path: ['systemPrompt'], value: '新提示词' },
    { op: 'set', path: ['temperature'], value: 0.2 },
  ])
  assert.equal(page.view().noteText, 'settings.saved')
  assert.equal(page.view().noteTone, 'ok')
})
await test('没有改动时保存不发请求，只提示', async () => {
  const page = mountSettings({ settingsValue: { systemPrompt: '不变的' } })
  await page.view().action('save').props.onClick()
  assert.equal(page.scope.mutations.length, 0)
  assert.equal(page.view().noteText, 'settings.noChange')
})
await test('校验失败：不保存、逐字段给可读提示', async () => {
  const page = mountSettings({ settingsValue: undefined })
  let view = page.view()
  view.inputs.get('customPromptEnabled').props.onChange({ target: { checked: true } })   // 开了开关但没写内容
  view.inputs.get('modelProvider').props.onChange({ target: { value: 'acme' } })          // 只填了 provider
  view.inputs.get('temperature').props.onChange({ target: { value: '9' } })               // 越界
  view.inputs.get('maxOutputTokens').props.onChange({ target: { value: '1.5' } })         // 非整数
  view.inputs.get('timeoutMs').props.onChange({ target: { value: '10' } })                // 太小
  view = page.view()
  await view.action('save').props.onClick()

  assert.equal(page.scope.mutations.length, 0, '校验不通过绝不能写')
  const after = page.view()
  assert.deepEqual(after.errors, [
    'settings.err.promptEmpty',
    'settings.err.modelPair',
    'settings.err.modelPair',
    'settings.err.temperature',
    'settings.err.maxOutputTokens',
    'settings.err.timeoutMs',
  ])
  assert.equal(after.noteText, 'settings.invalid')
  assert.equal(after.noteTone, 'error')
})
await test('校验含上界（与宿主 validate 同值），超界在客户端就拦下', async () => {
  // 旧客户端镜像只查下界：填 700000 会先过预校验、再由宿主拒绝，而 mutate 静默失败
  // → 界面假报"已保存"。这里钉住上界必须在客户端也被拦住。
  const page = mountSettings({ settingsValue: undefined })
  let view = page.view()
  view.inputs.get('timeoutMs').props.onChange({ target: { value: '700000' } })            // 超过 600000
  view.inputs.get('maxOutputTokens').props.onChange({ target: { value: '200001' } })      // 超过 200000
  view = page.view()
  await view.action('save').props.onClick()

  assert.equal(page.scope.mutations.length, 0, '超界不得发起写入')
  assert.deepEqual(page.view().errors, ['settings.err.maxOutputTokens', 'settings.err.timeoutMs'])
  assert.equal(page.view().noteText, 'settings.invalid')
})
await test('宿主拒绝写入时**不得**假报已保存（mutate 不会 reject）', async () => {
  // 真实契约：宿主拒绝（revision 冲突 / schema+validate 不过）时 mutate 只是 recover 后返回，
  // 既不抛错也不返回值。旧代码直接 await 就 flash('已保存')，用户以为存上了其实没有。
  const page = mountSettings({
    settingsValue: { systemPrompt: '旧' },
    mutateRefuse: true,
  })
  const view = page.view()
  view.inputs.get('systemPrompt').props.onChange({ target: { value: '新' } })
  await page.view().action('save').props.onClick()

  assert.equal(page.scope.mutations.length, 1, '确实发起了写入')
  const after = page.view()
  assert.equal(after.noteTone, 'error', '未生效必须是错误语气')
  assert.equal(after.noteText.includes('settings.saveFailed'), true)
  assert.equal(after.noteText.includes('settings.err.notApplied'), true)
  assert.equal(after.noteText.includes('settings.saved'), false, '绝不能出现"已保存"')
  assert.equal(after.inputs.get('systemPrompt').props.value, '新', '用户的编辑要保留，好让他重试')
})
await test('宿主拒绝恢复默认时同样不假报成功', async () => {
  const page = mountSettings({
    settingsValue: { systemPrompt: '旧' },
    mutateRefuse: true,
  })
  await page.view().action('reset').props.onClick()
  const after = page.view()
  assert.equal(after.noteTone, 'error')
  assert.equal(after.noteText.includes('settings.resetDone'), false)
  assert.equal(after.noteText.includes('settings.err.notApplied'), true)
})
await test('装配错误（真 reject）时把错误消息带出来', async () => {
  const page = mountSettings({
    settingsValue: { systemPrompt: '旧' },
    mutateFail: new Error('settings scope is not mounted'),
  })
  const view = page.view()
  view.inputs.get('systemPrompt').props.onChange({ target: { value: '新' } })
  await page.view().action('save').props.onClick()
  const note = page.view().noteText
  assert.equal(note.includes('settings.saveFailed'), true)
  assert.equal(note.includes('settings scope is not mounted'), true)
})
await test('恢复默认：对所有字段发 unset，回到默认与组合配置', async () => {
  const page = mountSettings({
    settingsValue: { customPromptEnabled: true, systemPrompt: 'x', modelProvider: 'acme', modelId: 'm1' },
  })
  await page.view().action('reset').props.onClick()
  assert.equal(page.scope.mutations.length, 1)
  const { ops } = page.scope.mutations[0]
  assert.equal(ops.length, 7)
  assert.equal(ops.every(op => op.op === 'unset'), true)
  assert.deepEqual(ops.map(op => op.path[0]).sort(), [
    'customPromptEnabled', 'maxOutputTokens', 'modelId', 'modelProvider', 'systemPrompt', 'temperature', 'timeoutMs',
  ].sort())
  assert.equal(page.view().noteText, 'settings.resetDone')
})
await test('远端提交后（未在编辑）表单会同步成新值', async () => {
  const page = mountSettings({ settingsValue: { systemPrompt: '旧值' } })
  assert.equal(page.view().inputs.get('systemPrompt').props.value, '旧值')
  page.scope.publish({ value: { systemPrompt: '远端改了' } })
  assert.equal(page.view().inputs.get('systemPrompt').props.value, '远端改了')
})
await test('可写性/可用性两态都有明确说明', () => {
  const readOnly = mountSettings({ settingsValue: {}, writable: false })
  const readOnlyView = readOnly.view()
  assert.equal(readOnlyView.action('save').props.disabled, true)
  assert.equal(readOnlyView.inputs.get('systemPrompt').props.disabled, true)
  assert.equal(readOnlyView.notes.some(note => childrenOf(note)[0] === 'settings.readonly'), true)

  const unavailable = mount({ settings: { settingsStatus: 'unavailable', mode: 'memory' } })
  cursor = 0
  const node = unavailable.section.component(unavailable.section.options.inject())
  const texts = []
  const collect = (element) => {
    if (element === null || typeof element !== 'object') return
    if (typeof element.props?.className === 'string' && element.props.className.includes('dsh-bi-note')) {
      texts.push(childrenOf(element)[0])
    }
    for (const child of childrenOf(element)) collect(child)
  }
  collect(node)
  assert.equal(texts.includes('settings.unavailable'), true)
  assert.equal(texts.includes('settings.readonly'), true)
  assert.equal(node.props['data-dsh-bi-settings'], 'unavailable')
})
await test('不可用态要把宿主侧的原因一并显示（否则无从排查）', async () => {
  const page = mountSettings({
    settingsStatus: 'unavailable',
    catalog: {
      namespace: SETTINGS_NAMESPACE,
      settings: { available: false, reason: 'settings: namespace conflict' },
      providers: [],
      effective: { provider: null, model: null, temperature: null, maxOutputTokens: 1024, timeoutMs: 30000 },
    },
  })
  page.view()
  await tick()                       // 目录请求落地
  const view = page.view()
  const texts = view.notes.map(note => childrenOf(note)[0])
  assert.equal(texts.includes('settings.unavailable'), true, '笼统提示必须保留')
  assert.equal(
    texts.some(text => typeof text === 'string' && text.includes('settings.unavailableReason')
      && text.includes('settings: namespace conflict')),
    true,
    '宿主给的原因必须照实显示出来',
  )
  assert.equal(view.node.props['data-dsh-bi-settings'], 'unavailable')
})
await test('模型目录：切 provider 会去拉该 provider 的模型，失败只提示不阻断', async () => {
  const page = mountSettings({ models: [{ id: 'm9', name: 'M9' }] })
  let view = page.view()
  view.inputs.get('modelProvider').props.onChange({ target: { value: 'acme' } })
  view = page.view()   // 依赖变化 → 触发拉取（异步）
  await tick()
  view = page.view()   // 拉取落地后的重渲染
  const url = page.network.calls.map(call => call.url).find(item => item.startsWith(ROUTE_CATALOG_MODELS))
  assert.equal(url, `${ROUTE_CATALOG_MODELS}?provider=acme`)
  const datalist = view.datalists.get('dsh-bi-models')
  assert.ok(datalist !== undefined, '模型下拉候选必须渲染')
  assert.equal(childrenOf(datalist)[0].props.value, 'm9')

  const broken = mountSettings({ failCatalog: true })
  broken.view()
  await tick()                 // 目录失败是异步落地
  const brokenView = broken.view()
  assert.equal(brokenView.errors.includes('settings.err.loadCatalog'), true, '目录失败要提示且可手填')
  assert.equal(brokenView.inputs.get('modelId').props.disabled, false, '手填仍然可用')
})
await test('测试按钮：走宿主试调路由，成功失败都有可读结论', async () => {
  const okPage = mountSettings({ settingsValue: { modelProvider: 'acme', modelId: 'm1' } })
  await okPage.view().action('test').props.onClick()
  const checkCall = okPage.network.calls.find(call => call.url === ROUTE_CHECK)
  assert.deepEqual(checkCall.body, { provider: 'acme', model: 'm1' })
  assert.equal(okPage.view().noteText.includes('settings.model.testOk'), true)

  const badPage = mountSettings({
    settingsValue: { modelProvider: 'acme', modelId: 'nope' },
    check: { ok: false, message: 'unknown model' },
  })
  await badPage.view().action('test').props.onClick()
  const badNote = badPage.view().noteText
  assert.equal(badNote.includes('settings.model.testFail'), true)
  assert.equal(badNote.includes('unknown model'), true)
  assert.equal(badPage.view().noteTone, 'error')

  const missingPage = mountSettings({ settingsValue: {} })
  await missingPage.view().action('test').props.onClick()
  assert.equal(missingPage.network.calls.some(call => call.url === ROUTE_CHECK), false, '缺字段不该发请求')
  assert.equal(missingPage.view().noteText, 'settings.err.modelPair')
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
