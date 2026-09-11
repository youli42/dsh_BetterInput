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

import {
  SETTINGS_FIELD_KEYS,
  STYLE_IDS as HOST_STYLE_IDS,
  STYLE_PROMPT_FIELDS,
} from '../lib/policy.js'

/** 宿主的逐风格提示词字段清单（用来钉住客户端那份镜像没有漂移）。 */
const HOST_STYLE_FIELDS = Object.values(STYLE_PROMPT_FIELDS)

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
    // 注意别写成 `hookSlots[index] ??= {...}`：那属于"赋值出现在表达式里"，语义上也没必要。
    if (hookSlots[index] === undefined) hookSlots[index] = { deps: undefined, cleanup: undefined }
    const slot = hookSlots[index]
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

/**
 * document 上的监听器登记表。
 *
 * 必须是**真的**登记表（而不是空函数）：菜单"点外面关闭"和"点菜单内部不关"是两个真实分支，
 * 用空实现当替身会让"勾选风格时菜单被关掉"这种缺陷永远测不出来。
 */
const documentListeners = new Map()

/**
 * 触发一次 document 级的 mousedown（模拟真实 DOM 的冒泡结果）。
 * @param {object | null} target - 事件目标；`null` 表示点在菜单外面。
 * @returns {number} 被调用到的监听器数。
 */
function dispatchMouseDown(target) {
  let called = 0
  for (const listener of documentListeners.get('mousedown') ?? []) {
    listener({ type: 'mousedown', target })
    called += 1
  }
  return called
}

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
  // 预设菜单打开时会挂"点外面/Esc 关闭"的全局监听（真 DOM 一定有这两个方法）。
  addEventListener: (type, listener) => {
    const bucket = documentListeners.get(type) ?? []
    bucket.push(listener)
    documentListeners.set(type, bucket)
  },
  removeEventListener: (type, listener) => {
    const bucket = documentListeners.get(type) ?? []
    const at = bucket.indexOf(listener)
    if (at >= 0) bucket.splice(at, 1)
  },
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
 *
 * 覆盖三条路径：
 *   · `GET /catalog` → 立即结算（预设/风格/区间）；
 *   · `POST /optimize/stream` → 默认**回 404**，于是所有既有用例都在测"回退到一次性 JSON"这条路；
 *     传 `{ streaming: true }` 时改为返回一个**可控 SSE 流**（`facade.stream`），用来测流式回填；
 *   · `POST /optimize` → 可悬挂、可手动结算、可取消（原行为）。
 *
 * `respond({data})` 会结算"当前待结算的请求"；若此刻还没有请求（例如流式刚拿到 404、回退请求还没发出），
 * 就先**记下来**等下一个 POST 请求到达时自动结算——否则用例得依赖微任务时序，很脆。
 * @param {{ presets?: object[], styles?: object[], limits?: object, catalog?: object, failCatalog?: boolean, streaming?: boolean }} [options] - 替身参数。
 * @returns {object} 门面：calls / optimizeCalls / catalogCalls / pendingCount / respond / fail / stream。
 */
function installFetch(options = {}) {
  const calls = []
  const entries = []
  const encoder = new TextEncoder()
  /** 已记下但还没发出的响应（见上面 respond 的说明）。 */
  let armed
  /** 流式响应状态：controller 非空表示客户端已经拿到流。 */
  const streamState = { controller: undefined, closed: false }

  /**
   * 结算一个条目（只允许一次）。
   * @param {object} entry - 条目。
   * @param {object} response - 响应内容 `{ status, data, error }`。
   * @returns {void}
   */
  const settleEntry = (entry, response) => {
    // 注意：**不要**在这里先置 `entry.settled`——`entry.resolve/reject` 内部会检查它并自己是幂等的，
    // 先置会导致"看起来结算了、其实 promise 永远挂着"。
    if (entry.settled) return
    if (response.error !== undefined) {
      entry.reject(response.error)
      return
    }
    const status = response.status ?? 200
    if (entry.kind === 'stream') {
      // 非 2xx：按"路由层面失败"结算，客户端会走它自己的状态码分支（与 JSON 路径一致）。
      if (status >= 300) {
        entry.resolve({ ok: false, status, json: async () => response.data ?? {} })
        return
      }
      // 2xx：默认只发 `done` 帧（等价于"模型一口气给完"），需要增量请用 facade.stream.push(...)。
      streamState.controller?.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify(response.data ?? {})}\n\n`))
      streamState.controller?.close()
      streamState.closed = true
      entry.resolve({ ok: true, status: 200, body: entry.body })
      return
    }
    entry.resolve({ ok: status >= 200 && status < 300, status, json: async () => response.data ?? {} })
  }

  globalThis.fetch = (url, init) => {
    const record = {
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    }
    calls.push(record)
    if (url === ROUTE_CATALOG) {
      const data = options.catalog ?? {
        namespace: SETTINGS_NAMESPACE,
        settings: { available: true, section: {} },
        providers: [],
        limits: options.limits ?? {
          maxInputChars: 8000,
          temperature: { min: 0, max: 2 },
          maxOutputTokens: { min: 1, max: 200000 },
          timeoutMs: { min: 1000, max: 600000 },
        },
        presets: options.presets ?? [],
        styles: [],
        profiles: options.profiles ?? [
          { id: 'concise', name: '精简', source: 'default', builtIn: true },
          { id: 'spec', name: '转规格', source: 'default', builtIn: true },
        ],
        defaults: { systemPrompt: '内置默认提示词' },
        effective: {
          profileId: options.activeProfileId ?? null,
          provider: null, model: null, temperature: null, maxOutputTokens: 1024, timeoutMs: 30000,
        },
      }
      const status = options.failCatalog === true ? 500 : 200
      return Promise.resolve({ ok: status === 200, status, json: async () => data })
    }
    if (url === ROUTE_STREAM && options.streaming === false) {
      // 模拟"旧宿主/不支持流式"：这条路由不存在（404），客户端应回退到一次性 JSON。
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
    }

    return new Promise((resolve, reject) => {
      /** 只允许结算一次，并记录已结算（取消也走这里）。 */
      const entry = {
        kind: url === ROUTE_STREAM ? 'stream' : 'json',
        settled: false,
        settle: (settleWith, value) => {
          if (entry.settled) return
          entry.settled = true
          settleWith(value)
        },
      }
      entries.push(entry)
      if (init?.signal !== undefined) {
        const onAbort = () => {
          if (entry.kind === 'stream' && entry.settled) {
            // 真实 fetch 在 signal 中止时会取消 body：让客户端的 `reader.read()` 立刻结束
            // （否则它会一直等下一个 chunk，取消用例就永远挂着）。
            streamState.controller?.error(new DOMException('aborted', 'AbortError'))
            streamState.closed = true
            return
          }
          entry.settle(reject, new DOMException('aborted', 'AbortError'))
        }
        if (init.signal.aborted) onAbort()
        else init.signal.addEventListener('abort', onAbort)
      }
      entry.resolve = (value) => entry.settle(resolve, value)
      entry.reject = (error) => entry.settle(reject, error)
      if (entry.kind === 'stream') {
        entry.body = new ReadableStream({
          start(controller) { streamState.controller = controller },
        })
        streamState.entry = entry
      }
      if (armed !== undefined) {
        const pending = armed
        armed = undefined
        settleEntry(entry, pending)
      }
    })
  }

  /**
   * 打开流式响应：手工喂帧前必须先让 `fetch` 结算，否则客户端还在 `await fetch(...)`，根本不会去读流。
   * @returns {void}
   */
  const openStream = () => {
    const entry = streamState.entry
    assert.ok(entry !== undefined, '客户端还没发出流式请求（先点击优化）')
    if (!entry.settled) entry.resolve({ ok: true, status: 200, body: entry.body })
  }

  return {
    calls,
    /**
     * 所有"发起优化"的 POST（流式或回退的 JSON）。
     * 多数用例只关心"发了一次、请求体是什么"，不该绑死在具体走哪条路由上——那是路由选择用例的事。
     */
    get postCalls() { return calls.filter(call => call.method === 'POST' && (call.url === ROUTE || call.url === ROUTE_STREAM)) },
    /** 只看一次性 JSON 优化请求（回退路径）。 */
    get optimizeCalls() { return calls.filter(call => call.method === 'POST' && call.url === ROUTE) },
    /** 只看流式请求。 */
    get streamCalls() { return calls.filter(call => call.method === 'POST' && call.url === ROUTE_STREAM) },
    get catalogCalls() { return calls.filter(call => call.url === ROUTE_CATALOG) },
    get pendingCount() { return entries.filter(item => !item.settled).length },
    /**
     * 流式控制器：手工喂帧（`push` 发一个 delta；`done` / `error` 收尾；`raw` 发任意文本）。
     * 只有 `{ streaming: true }` 时才有实际作用。
     */
    stream: {
      /** 发一个文本增量（会先"打开响应"，让客户端开始读流）。 */
      push(text) {
        openStream()
        streamState.controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`))
      },
      /** 发任意原始帧文本（用于测解析器容错，例如注释帧/坏 JSON）。 */
      raw(text) {
        openStream()
        streamState.controller.enqueue(encoder.encode(text))
      },
      /** 正常收尾：done 帧 + 关闭。 */
      done(data) {
        openStream()
        streamState.controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify(data)}\n\n`))
        streamState.controller.close()
        streamState.closed = true
      },
      /** 异常收尾：error 帧 + 关闭。 */
      error(data) {
        openStream()
        streamState.controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(data)}\n\n`))
        streamState.controller.close()
        streamState.closed = true
      },
      /** 直接掐断流（模拟网络中断）。 */
      break() {
        openStream()
        streamState.controller.error(new TypeError('stream broken'))
        streamState.closed = true
      },
      get closed() { return streamState.closed },
    },
    /**
     * 结算"当前待结算的请求"；此刻还没有请求时先记下来，等下一个 POST 请求到达再自动结算
     * （流式拿到 404 之后回退请求是下一个微任务才发出的，用例不该依赖这个时序）。
     * @param {{ status?: number, data?: unknown }} options - 响应内容。
     * @returns {void}
     */
    respond(options = {}) {
      const pending = entries.findLast(item => !item.settled)
      if (pending === undefined) {
        armed = { status: options.status, data: options.data }
        return
      }
      settleEntry(pending, { status: options.status, data: options.data })
    },
    /**
     * 让最后一次请求抛错（网络层失败）；语义与 `respond` 相同（没有待结算请求时先记下）。
     * @param {Error} error - 抛出的错误。
     * @returns {void}
     */
    fail(error) {
      const pending = entries.findLast(item => !item.settled)
      if (pending === undefined) {
        armed = { error }
        return
      }
      settleEntry(pending, { error })
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

/** 跑到宏任务边界：流式读取（`reader.read()` → 解析 → 写回）跨多个微任务，光靠 tick 不够。 */
const flush = async () => { await new Promise(resolve => setImmediate(resolve)) }

/**
 * 递归收集带某个 props 键的元素（预设菜单项嵌在 div 里，不是包裹节点的直接子元素）。
 * @param {object} element - createElement 产物。
 * @param {string} prop - props 键名。
 * @returns {object[]} 命中元素。
 */
function byProp(element, prop) {
  const found = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node.props !== undefined && node.props[prop] !== undefined) found.push(node)
    const children = node.children
    if (Array.isArray(children)) for (const child of children) walk(child)
  }
  walk(element)
  return found
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

  /**
   * 渲染一次：从真值生成快照（模拟框架给组件的会话标准道具）。
   *
   * 快照字段用 **getter 读真值**，而不是一次性拷贝：真实框架里输入机的任何变化都会让组件重渲染、
   * 于是组件在异步路径上读到的 `live.current.input.draft` 总是新的；而这里的"重渲染"只在测试显式
   * 调用 `view()` 时发生。若快照是死拷贝，"我们自己刚写进去的草稿"就会在组件眼里显得是用户手改。
   */
  const view = () => {
    const snapshot = {
      get draft() { return truth.draft },
      get draftRev() { return truth.draftRev },
      get phase() { return truth.phase },
      get occurrences() { return [...truth.occurrences] },
    }
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
    const presetToggle = byProp(node, 'data-dsh-better-input-preset-toggle')[0] ?? null
    const presetItems = byProp(node, 'data-dsh-better-input-preset')
    const menu = byProp(node, 'data-dsh-better-input-menu')[0] ?? null
    return {
      node,
      props,
      optimize: buttons.find(button => button.props['data-dsh-better-input'] !== undefined),
      undo: buttons.find(button => button.props['data-dsh-better-input-undo'] !== undefined) ?? null,
      /** 预设菜单按钮（没配预设时为 null）。 */
      presetToggle,
      /** 菜单项（按渲染顺序）。 */
      presetItems,
      /** 追加提示词菜单项（含「默认」项，按渲染顺序；'' = 默认）。 */
      profileItems: byProp(node, 'data-dsh-better-input-profile'),
      /** 菜单里的「按所选风格优化」按钮。 */
      apply: byProp(node, 'data-dsh-better-input-apply')[0] ?? null,
      /** 菜单是否展开（由 DOM 推导，而不是读组件内部 state）。 */
      menuOpen: menu !== null,
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
const ROUTE_STREAM = '/api/dsh-input-optimizer/optimize/stream'
const ROUTE_CATALOG = '/api/dsh-input-optimizer/catalog'
const ROUTE_CATALOG_MODELS = '/api/dsh-input-optimizer/catalog/models'
const ROUTE_CHECK = '/api/dsh-input-optimizer/check'
const ROUTE_OPEN_CONFIG = '/api/dsh-input-optimizer/open-config'
const SETTINGS_NAMESPACE = 'better-input'

/* ── 设置页 harness：假 scope + 假目录路由 ─────────────────────────────── */

/**
 * 装一个按路径应答的 fetch 替身（设置页用）。
 * @param {{ catalog?: object, models?: object[], check?: object, failCatalog?: boolean,
 *   openConfig?: object }} options - 响应内容。
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
    if (url === ROUTE_OPEN_CONFIG) {
      // 默认成功并回传一个**测试用的假路径**：真实实现会去起系统默认程序，测试绝不能真起进程。
      if (options.failOpenConfig === true) {
        return respond(options.openConfig ?? { error: 'open-failed', message: '打开失败' }, 500)
      }
      return respond(options.openConfig ?? { ok: true, path: 'C:\\fake\\dsh-better-input\\cordis.patch.yml' })
    }
    if (url === ROUTE_CATALOG) {
      if (options.failCatalog === true) return respond({}, 500)
      return respond(options.catalog ?? {
        namespace: SETTINGS_NAMESPACE,
        settings: { available: true, section: {} },
        providers: [{ id: 'acme', name: 'Acme' }, { id: 'deepseek-official', name: 'DeepSeek' }],
        styles: [],
        profiles: options.profiles ?? [
          { id: 'concise', name: '精简', source: 'default', builtIn: true },
          { id: 'spec', name: '转规格', source: 'default', builtIn: true },
        ],
        defaults: { systemPrompt: '默认提示词全文' },
        configPath: 'C:\\fake\\dsh-better-input\\cordis.patch.yml',
        effective: {
          profileId: options.activeProfileId ?? null,
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
    const profileActive = new Map()
    const expands = new Map()
    const textareas = []
    let defaultPromptText = null
    /** 递归收集（元素是嵌套的：按钮在 .dsh-bi-actions 里，datalist 在分组体里）。 */
    const walk = (element) => {
      if (element === null || typeof element !== 'object') return
      const className = typeof element.props?.className === 'string' ? element.props.className : ''
      if (element.props?.['data-dsh-bi-field'] !== undefined) inputs.set(element.props['data-dsh-bi-field'], element)
      if (element.props?.['data-dsh-bi-action'] !== undefined) buttons.push(element)
      if (element.props?.['data-dsh-bi-expand'] !== undefined) expands.set(element.props['data-dsh-bi-expand'], element)
      if (element.type === 'textarea') textareas.push(element)
      if (className.includes('dsh-bi-note')) notes.push(element)
      if (className === 'dsh-bi-error') errors.push(childrenOf(element)[0])
      if (element.type === 'datalist' && typeof element.props.id === 'string') datalists.set(element.props.id, element)
      if (element.props?.['data-dsh-bi-profile-active'] !== undefined) {
        profileActive.set(element.props['data-dsh-bi-profile-active'], element)
      }
      if (element.props?.['data-dsh-bi-default-prompt'] === 'view') {
        // 展开视图里的 <pre> 是默认提示词正文。
        const pre = childrenOf(element).find(child => child.type === 'pre')
        defaultPromptText = pre === undefined ? null : childrenOf(pre)[0]
      }
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
      /** 追加提示词「启用」单选（按追加条目 id，'' = 不追加）。 */
      profileActive,
      /** 「编辑」开关（按分组键：prompt / model / params / profile:<id>）。 */
      expands,
      /** 多行文本控件（默认视图里应当一个都没有）。 */
      textareas,
      /** 展开的默认提示词正文（未展开时为 null）。 */
      defaultPromptText,
      noteText: notes.length === 0 ? null : childrenOf(notes[notes.length - 1])[0],
      noteTone: notes.length === 0 ? null : notes[notes.length - 1].props['data-tone'],
      action(name) {
        const button = buttons.find(item => item.props['data-dsh-bi-action'] === name)
        assert.ok(button !== undefined, `action ${name} must exist`)
        return button
      },
    }
  }

  /**
   * 展开若干分组/行。
   *
   * P10 起输入框**默认不渲染**（收起的分组里根本没有 input/textarea），所以用例要先点「编辑」。
   * 已经是展开态时是空操作，重复调用安全。
   * @param {...string} keys - 分组键（prompt / model / params / profile:<id>）。
   * @returns {object} 展开后的视图。
   */
  const open = (...keys) => {
    for (const key of keys) {
      const toggle = view().expands.get(key)
      assert.ok(toggle !== undefined, `expand toggle ${key} must exist`)
      if (toggle.props['aria-expanded'] !== true) toggle.props.onClick()
    }
    return view()
  }

  return { harness, network, view, open, face, scope: harness.scope, binds: harness.binds }
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
  assert.equal(network.postCalls.length, 1)
  assert.deepEqual(network.postCalls[0].body, { text: '我的草稿', sessionId: harness.sessionId })
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
  assert.equal(network.postCalls.length, 1)
  assert.equal(network.postCalls[0].url, ROUTE_STREAM, '默认走流式路由')
  assert.equal(network.postCalls[0].method, 'POST')
  assert.equal(network.postCalls[0].headers['content-type'], 'application/json')
  assert.deepEqual(network.postCalls[0].body, { text: '帮我写个脚本', sessionId: harness.sessionId })

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

  // 401（宿主要求浏览器会话）：宿主自带可操作文案时必须优先展示它。
  const unauthorized = installFetch()
  const session = mount({ draft: 'x' })
  const pendingSession = session.view().optimize.props.onClick()
  unauthorized.respond({ status: 401, data: { error: 'unauthorized', message: '需要浏览器会话：请在 GUI 页面里操作' } })
  await pendingSession
  assert.equal(session.view().noteText, '需要浏览器会话：请在 GUI 页面里操作')

  // 401 且响应体为空（例如被前置的认证层挡下）→ 用专门文案而不是"宿主返回错误 (HTTP 401)"。
  const bare = installFetch()
  const bareSession = mount({ draft: 'x' })
  const pendingBare = bareSession.view().optimize.props.onClick()
  bare.respond({ status: 401, data: null })
  await pendingBare
  assert.equal(bareSession.view().noteText, 'unauthorized')

  /**
   * 404/405：这两条是"宿主半没挂载"的语义，属于**回退路径**（旧宿主没有流式路由时同样如此）——
   * 所以用 `streaming: false` 让流式请求先拿到 404、回退到一次性 JSON，再给 JSON 请求应答。
   */
  const missing = installFetch({ streaming: false })
  const third = mount({ draft: 'x' })
  const pendingThree = third.view().optimize.props.onClick()
  await tick()                       // 等回退请求真正发出去
  missing.respond({ status: 404, data: null })
  await pendingThree
  assert.equal(third.view().noteText, 'notMounted')

  // 真机上宿主半没挂载时 POST 拿到的是 **405 空体**（SPA fallback 先拦非 GET/HEAD，
  // 再去找文件），所以 405 必须和 404 一样映射到「路由未挂载」。
  const unmounted = installFetch({ streaming: false })
  const fourth = mount({ draft: 'x' })
  const pendingFour = fourth.view().optimize.props.onClick()
  await tick()
  unmounted.respond({ status: 405, data: null })
  await pendingFour
  assert.equal(fourth.view().noteText, 'notMounted')

  // 插件自己的 405 带 JSON message（"只接受 POST"），必须优先展示它而不是兜底文案。
  // （同样走回退路径：对 POST 而言流式路由回 405 = 这条路由不归它管。）
  const methodNotAllowed = installFetch({ streaming: false })
  const fifth = mount({ draft: 'x' })
  const pendingFive = fifth.view().optimize.props.onClick()
  await tick()
  methodNotAllowed.respond({ status: 405, data: { error: 'method-not-allowed', message: '只接受 POST' } })
  await pendingFive
  assert.equal(fifth.view().noteText, '只接受 POST')
})
await test('网络失败与空结果都有可读文案，且不入栈', async () => {
  // 网络层失败：流式这条路也失败，回退到 JSON 再失败一次 → 最终文案是"网络失败"。
  const network = installFetch({ streaming: false })
  const harness = mount({ draft: 'x' })
  const pending = harness.view().optimize.props.onClick()
  await tick()
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
  assert.equal(network.postCalls.length, 0, '不得发起请求')
  assert.equal(harness.view().noteText, 'chips')
  assert.deepEqual(harness.written, [])
})

console.log('client half: 追加提示词菜单与宿主下发的规则（P5.3 / P8 合并）')
await test('菜单的关闭手势：点外面/Esc 收起，点菜单**内部**不收起（切追加提示词要看清选中态）', async () => {
  // 这条用例的存在理由：`onDown` 若只是 `setMenuOpen(false)`，点追加提示词项就会把菜单关掉，
  // 用户看不到选中标记移动——而手写替身如果 `addEventListener` 是空函数，这个缺陷永远测不出来。
  installFetch({
    profiles: [{ id: 'concise', name: '精简', source: 'default', builtIn: true }],
  })
  const harness = mount({ draft: '草稿' })
  harness.view()
  await tick()
  await harness.view().presetToggle.props.onClick()
  assert.equal(harness.view().menuOpen, true)

  // 点在菜单内部（追加提示词项的 target.closest 能命中菜单）→ 必须保持展开。
  const insideTarget = { closest: (selector) => (selector === '[data-dsh-better-input-menu]' ? {} : null) }
  assert.equal(dispatchMouseDown(insideTarget), 1, '菜单展开时应当挂着 document 的关闭监听')
  assert.equal(harness.view().menuOpen, true, '点在菜单内部不得收起菜单')

  // 点在菜单外面（closest 返回 null）→ 收起。
  const outsideTarget = { closest: () => null }
  dispatchMouseDown(outsideTarget)
  assert.equal(harness.view().menuOpen, false, '点外面必须收起')

  // Esc 同样收起。
  await harness.view().presetToggle.props.onClick()
  assert.equal(harness.view().menuOpen, true)
  for (const listener of documentListeners.get('keydown') ?? []) listener({ key: 'Escape' })
  assert.equal(harness.view().menuOpen, false, 'Esc 必须收起')

  // 菜单收起后监听器必须被摘掉（否则每次开合都会叠一层）。
  assert.equal(documentListeners.get('mousedown').length, 0)
  assert.equal(documentListeners.get('keydown').length, 0)
})
await test('内置条目（精简/转规格）常驻菜单：单选切换落盘 activeProfileId，请求不带 styleIds', async () => {
  const network = installFetch()
  const harness = mount({ draft: '帮我写个脚本' })
  harness.view()
  await tick()
  await harness.view().presetToggle.props.onClick()
  let view = harness.view()
  assert.equal(view.menuOpen, true)
  assert.deepEqual(
    view.profileItems.map(item => item.props['data-dsh-better-input-profile']),
    ['', 'concise', 'spec'],
    '「默认」在最前，内置的精简/转规格随后',
  )
  assert.equal(view.profileItems[0].props['data-active'], true, '初始：默认被选中')
  assert.equal(view.profileItems[1].props['data-active'], false)
  assert.equal(view.profileItems[1].props.role, 'menuitemradio', '追加提示词是单选语义（不是旧多选的复选框）')

  // 点「精简」：乐观更新选中标记；落盘 activeProfileId；菜单不收起。
  await view.profileItems[1].props.onClick()
  await tick()
  view = harness.view()
  assert.deepEqual(harness.scope.mutations, [{
    ops: [{ op: 'set', path: ['activeProfileId'], value: 'concise' }],
    revision: 7,
  }])
  assert.equal(view.profileItems[1].props['data-active'], true)
  assert.equal(view.profileItems[0].props['data-active'], false)
  assert.equal(view.menuOpen, true, '切换不收起菜单')

  // 发起优化：请求体**不带** styleIds（合并后追加提示词由宿主按 activeProfileId 现读）。
  const pending = view.optimize.props.onClick()
  assert.deepEqual(network.postCalls[0].body, { text: '帮我写个脚本', sessionId: harness.sessionId })
  network.respond({ data: { text: '精简后的文本' } })
  await pending
  assert.equal(harness.truth.draft, '精简后的文本')

  // 切回「默认」：发 unset。
  await harness.view().presetToggle.props.onClick()
  await harness.view().profileItems[0].props.onClick()
  await tick()
  assert.deepEqual(harness.scope.mutations[1].ops, [{ op: 'unset', path: ['activeProfileId'] }])
})
await test('宿主拒绝切换时不假报成功：选中标记回退、给错误提示', async () => {
  installFetch()
  const harness = mount({
    draft: '草稿',
    settings: { mutateRefuse: true },
  })
  harness.view()
  await tick()
  await harness.view().presetToggle.props.onClick()
  await harness.view().profileItems[1].props.onClick()
  await tick()
  const view = harness.view()
  assert.equal(harness.scope.mutations.length, 1, '确实发起了写入')
  assert.equal(view.profileItems[0].props['data-active'], true, '失败后选中标记回退到「默认」')
  assert.equal(view.noteTone, 'error')
  assert.equal(view.noteText, 'profile.switchFailed')
})
await test('一次性预设：点一次跑一次，请求带 presetId（与追加提示词共存不混淆）', async () => {
  const network = installFetch({ presets: [{ id: 'shorter', label: '更短' }] })
  const harness = mount({ draft: '帮我写个爬虫' })
  harness.view()
  await tick()                       // 目录请求落地 → 追加提示词与预设渲染
  let view = harness.view()
  assert.notEqual(view.presetToggle, null, '有追加提示词/预设就必须出现菜单按钮')
  assert.equal(view.menuOpen, false, '默认不展开')

  await view.presetToggle.props.onClick()
  view = harness.view()
  assert.deepEqual(view.presetItems.map(item => childrenOf(item)[0]), ['更短'])
  assert.deepEqual(
    view.profileItems.map(item => item.props['data-dsh-better-input-profile']),
    ['', 'concise', 'spec'],
    '追加提示词区在前，预设区在后',
  )

  const pending = view.presetItems[0].props.onClick()
  assert.deepEqual(network.postCalls[0].body, {
    text: '帮我写个爬虫',
    sessionId: harness.sessionId,
    presetId: 'shorter',
  })
  network.respond({ data: { text: '更短的改写', presetId: 'shorter' } })
  await pending
  assert.equal(harness.truth.draft, '更短的改写')
  assert.equal(harness.view().menuOpen, false, '选完必须收起菜单')
})
await test('点主按钮不带 presetId（默认提示词路径不变）', async () => {
  const network = installFetch({ presets: [{ id: 'spec', label: '转规格' }] })
  const harness = mount({ draft: '草稿' })
  harness.view()
  await tick()
  const pending = harness.view().optimize.props.onClick()
  assert.deepEqual(network.postCalls[0].body, { text: '草稿', sessionId: harness.sessionId })
  network.respond({ data: { text: '改写后' } })
  await pending
})
await test('目录读失败：不渲染菜单按钮，主按钮照常可用', async () => {
  const broken = installFetch({ failCatalog: true })
  const other = mount({ draft: '草稿' })
  other.view()
  await tick()
  assert.equal(other.view().presetToggle, null, '目录读失败不能冒出一个空菜单')
  const pending = other.view().optimize.props.onClick()
  assert.equal(broken.postCalls.length, 1, '主按钮不受目录失败影响')
  broken.respond({ data: { text: '改写后' } })
  await pending
  assert.equal(other.truth.draft, '改写后')
})
await test('与内置追加提示词同 id 的预设不进"预设"区（避免同一个名字出现两次）', async () => {
  // 真实部署里 `cordis.patch.yml` 的 presets 就是 concise/spec —— 合并后它们是内置追加提示词的
  // 追加要求来源；若原样列进预设区，用户会在菜单里看到两个"精简"。
  installFetch({
    profiles: [
      { id: 'concise', name: '精简', source: 'config', builtIn: true },
      { id: 'spec', name: '转规格', source: 'config', builtIn: true },
    ],
    presets: [{ id: 'concise', label: '精简' }, { id: 'spec', label: '转规格' }, { id: 'shorter', label: '更短' }],
  })
  const harness = mount({ draft: '草稿' })
  harness.view()
  await tick()
  await harness.view().presetToggle.props.onClick()
  const view = harness.view()
  assert.deepEqual(
    view.presetItems.map(item => item.props['data-dsh-better-input-preset']),
    ['shorter'],
    '与内置追加提示词同 id 的预设要从预设区剔除，只剩真正的一次性预设',
  )
  assert.deepEqual(
    view.profileItems.map(item => item.props['data-dsh-better-input-profile']),
    ['', 'concise', 'spec'],
  )
})
await test('客户端与宿主的风格字段镜像必须一致（漂移就红）', async () => {
  // 客户端 bundle 不能 import policy.js，所以 STYLE_IDS / stylePromptField 是镜像。
  // 这里把镜像与宿主的权威清单对齐：加了第三个风格却忘了改客户端，会当场失败。
  const page = mountSettings({ settingsValue: {} })
  await page.view().action('reset').props.onClick()
  const fields = page.scope.mutations[0].ops.map(op => op.path[0])
  for (const field of HOST_STYLE_FIELDS) {
    assert.equal(fields.includes(field), true, `宿主的风格字段 ${field} 必须被客户端覆盖（保存/重置链路）`)
  }
  assert.equal(HOST_STYLE_FIELDS.length, HOST_STYLE_IDS.length)
  // 宿主的 settings 字段总清单必须被客户端的重置清单完全覆盖，反之亦然。
  assert.deepEqual([...fields].sort(), [...SETTINGS_FIELD_KEYS].sort())
})
await test('长度上限以宿主为准：本地先说清楚，不发请求', async () => {
  const network = installFetch({
    presets: [],
    limits: {
      maxInputChars: 5,
      temperature: { min: 0, max: 2 },
      maxOutputTokens: { min: 1, max: 1000 },
      timeoutMs: { min: 1000, max: 60000 },
    },
  })
  const harness = mount({ draft: '一二三四五六' })   // 6 字 > 上限 5
  harness.view()
  await tick()
  await harness.view().optimize.props.onClick()
  assert.equal(network.postCalls.length, 0, '超长不该打到宿主')
  const note = harness.view().noteText
  assert.equal(note.includes('tooLong'), true)
  assert.equal(note.includes('6/5'), true, '提示里要带实际字数与上限')
  assert.equal(harness.view().noteTone, 'warn')
})
await test('设置页区间也走宿主下发：换一组 limits 立刻生效', async () => {
  // 客户端的 `limits` 不再自带常量，而是 `/catalog` 的 limits（宿主 TEMPERATURE_RANGE 等）。
  // 这里给一组更紧的区间，验证校验与输入框 min 都跟着走。
  const page = mountSettings({
    settingsValue: undefined,
    catalog: {
      namespace: SETTINGS_NAMESPACE,
      settings: { available: true, section: {} },
      providers: [],
      limits: {
        maxInputChars: 100,
        temperature: { min: 0, max: 1 },
        maxOutputTokens: { min: 1, max: 100 },
        timeoutMs: { min: 2000, max: 5000 },
      },
      presets: [],
      effective: { provider: null, model: null, temperature: null, maxOutputTokens: 1024, timeoutMs: 30000 },
    },
  })
  page.view()
  await tick()
  let view = page.open('params')
  assert.equal(view.inputs.get('maxOutputTokens').props.min, 1, '输入框 min 也要用宿主下发值')
  assert.equal(view.inputs.get('timeoutMs').props.min, 2000)

  view.inputs.get('maxOutputTokens').props.onChange({ target: { value: '101' } })   // > 100
  view.inputs.get('timeoutMs').props.onChange({ target: { value: '6000' } })        // > 5000
  view.inputs.get('temperature').props.onChange({ target: { value: '1.5' } })       // > 1
  view = page.view()
  await view.action('save').props.onClick()
  assert.equal(page.scope.mutations.length, 0, '超宿主区间不得写入')
  assert.deepEqual(page.view().errors, [
    'settings.err.temperature',
    'settings.err.maxOutputTokens',
    'settings.err.timeoutMs',
  ])

  // 区间内必须放行（证明不是"一律拒绝"）。
  const ok = mountSettings({
    settingsValue: undefined,
    catalog: {
      namespace: SETTINGS_NAMESPACE,
      settings: { available: true, section: {} },
      providers: [],
      limits: {
        maxInputChars: 100,
        temperature: { min: 0, max: 1 },
        maxOutputTokens: { min: 1, max: 100 },
        timeoutMs: { min: 2000, max: 5000 },
      },
      presets: [],
      effective: { provider: null, model: null, temperature: null, maxOutputTokens: 1024, timeoutMs: 30000 },
    },
  })
  ok.view()
  await tick()
  let okView = ok.open('params')
  okView.inputs.get('maxOutputTokens').props.onChange({ target: { value: '100' } })
  okView.inputs.get('timeoutMs').props.onChange({ target: { value: '5000' } })
  okView = ok.view()
  await okView.action('save').props.onClick()
  assert.equal(ok.scope.mutations.length, 1, '边界值必须放行')
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

console.log('client half: 流式回填（P5.6）')
await test('增量边到边写（节流），最终以 done 帧的文本为准，只压一条撤销记录', async () => {
  const network = installFetch({ streaming: true })
  const harness = mount({ draft: '原文' })
  const pending = harness.view().optimize.props.onClick()
  assert.equal(network.streamCalls.length, 1, '默认走流式路由')

  // 同一个 tick 内连发三个增量：节流生效 → 只写一次（第一次），其余先攒着。
  network.stream.push('改写')
  network.stream.push('后的')
  network.stream.push('文本')
  await flush()
  assert.deepEqual(harness.written, ['改写'], '节流：同一 tick 内只写一次')

  // done 帧的文本与增量拼接不同（例如宿主做了 trim/规范化）→ 最终必须写 done 的文本。
  network.stream.done({ text: '改写后的文本（规范化）', modelUsed: { provider: 'p', model: 'm' } })
  await pending
  assert.deepEqual(harness.written, ['改写', '改写后的文本（规范化）'])
  assert.equal(harness.truth.draft, '改写后的文本（规范化）')
  assert.equal(harness.view().noteText, 'done')
  assert.notEqual(harness.view().undo, null, '成功后才出现撤销按钮')

  // 只有一条撤销记录：一次撤销直接回到原文。
  await harness.view().undo.props.onClick()
  assert.equal(harness.truth.draft, '原文')
  assert.equal(harness.view().undo, null)
})
await test('用户在流式中途手改 → 立刻中止、不覆盖、给 staleResult 提示', async () => {
  const network = installFetch({ streaming: true })
  const harness = mount({ draft: '原文' })
  const pending = harness.view().optimize.props.onClick()

  network.stream.push('改写')
  await flush()
  assert.deepEqual(harness.written, ['改写'])

  harness.type('用户插话')     // 用户开始打字
  harness.view()               // 框架把新快照推给组件
  network.stream.push('后的文本')
  await flush()
  assert.deepEqual(harness.written, ['改写'], '检测到用户改动后不得再写')

  network.stream.done({ text: '改写后的文本' })
  await pending
  assert.equal(harness.truth.draft, '用户插话', '绝不能覆盖用户此刻的输入')
  assert.equal(harness.view().noteText, 'staleResult')
  assert.equal(harness.view().noteTone, 'warn')
  assert.equal(harness.view().undo, null)
})
await test('流中途 error 帧 → 还原原文并说明（不留半截草稿）', async () => {
  const network = installFetch({ streaming: true })
  const harness = mount({ draft: '原文' })
  const pending = harness.view().optimize.props.onClick()
  network.stream.push('半截结果')
  await flush()
  network.stream.error({ error: 'model-failed', message: '上游炸了' })
  await pending
  assert.equal(harness.truth.draft, '原文', '已写入的增量必须还原')
  assert.equal(harness.written.at(-1), '原文')
  assert.equal(harness.view().noteText, '上游炸了（streamReverted）')
  assert.equal(harness.view().noteTone, 'error')
  assert.equal(harness.view().undo, null, '失败不入撤销栈')
})
await test('流被掐断（网络中断）→ 同样还原原文并提示失败', async () => {
  const network = installFetch({ streaming: true })
  const harness = mount({ draft: '原文' })
  const pending = harness.view().optimize.props.onClick()
  network.stream.push('半截')
  await flush()
  network.stream.break()
  await pending
  assert.equal(harness.truth.draft, '原文')
  assert.equal(harness.view().noteText, 'fail')
  assert.equal(harness.view().noteTone, 'error')
})
await test('旧宿主没有流式路由 → 自动回退一次性 JSON，行为与从前一致', async () => {
  const network = installFetch({ streaming: false })
  const harness = mount({ draft: '原文' })
  const pending = harness.view().optimize.props.onClick()
  await flush()
  assert.equal(network.streamCalls.length, 1, '先试过流式')
  assert.equal(network.optimizeCalls.length, 1, '再回退到 JSON')
  network.respond({ data: { text: '优化后' } })
  await pending
  assert.deepEqual(harness.written, ['优化后'], '回退路径不得留下流式的半截痕迹')
  assert.equal(harness.view().noteText, 'done')
  assert.notEqual(harness.view().undo, null)
})
await test('流式中途取消 → 不写、不提示失败、回到 idle', async () => {
  const network = installFetch({ streaming: true })
  const harness = mount({ draft: '原文' })
  const running = harness.view().optimize.props.onClick()
  network.stream.push('改写')
  await flush()
  await harness.view().optimize.props.onClick()   // 生成中再点 = 取消
  await running
  assert.equal(harness.view().optimize.props['data-state'], 'idle')
  assert.equal(harness.view().noteText, null, '取消不该弹失败提示')
  assert.equal(harness.view().undo, null)
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
await test('紧凑布局：默认不渲染任何输入框，点「编辑」后才出现（P10 验收 1）', async () => {
  const page = mountSettings({ settingsValue: undefined })
  const closed = page.view()
  // 默认视图：可编辑字段与多行文本控件一个都没有（只有取值单选与「编辑」开关）。
  assert.equal(closed.inputs.size, 0, '默认不得渲染任何输入框')
  assert.equal(closed.textareas.length, 0, '默认不得渲染任何 textarea')
  assert.equal(closed.errors.length, 0, '未配置不该有校验错误')
  assert.equal(closed.action('save').props.disabled, false, '保存按钮常驻顶部、无需滚动')
  assert.equal(closed.action('reset').props.disabled, false)
  assert.equal(closed.action('open-config').props.disabled, false)
  // 四个分组标题 + 各自一行摘要（收起时唯一的信息来源）。
  assert.deepEqual(
    [...closed.expands.keys()].sort(),
    ['model', 'params', 'prompt', 'profile:concise', 'profile:spec'].sort(),
    '每个分组与内置条目都有「编辑」开关',
  )
  assert.equal(closed.expands.get('prompt').props['aria-expanded'], false)

  // 触发后：控件出现且可用，值仍为空（回落到默认）。
  const opened = page.open('prompt', 'model', 'params')
  assert.equal(opened.inputs.get('customPromptEnabled').props.checked, false)
  assert.equal(opened.inputs.get('systemPrompt').props.value, '')
  assert.equal(opened.inputs.get('modelProvider').props.value, '')
  assert.equal(opened.inputs.get('modelId').props.value, '')
  assert.equal(opened.textareas.length, 1, '展开系统提示词后出现它的 textarea')
  assert.equal(opened.expands.get('prompt').props['aria-expanded'], true)

  // 再点一次 = 收起，输入框重新从 DOM 里消失。
  opened.expands.get('prompt').props.onClick()
  assert.equal(page.view().inputs.has('systemPrompt'), false, '收起后输入框必须消失')

  // 首屏拉了目录（摘要与来源标注都要宿主下发）。
  assert.equal(page.network.calls.some(call => call.url === ROUTE_CATALOG), true)
})
await test('紧凑布局的样式与一屏项数：行距压小、旧 fieldset 版式不再存在（P10 验收 2/3）', async () => {
  const page = mountSettings({ settingsValue: {} })
  page.view()
  await tick()
  const css = appendedStyles[0].textContent

  // 行距/字号按"一屏能塞下全部分组"来定：分组间距 8px、字号 12px、组头 24px、清单行 22px。
  assert.equal(css.includes('.dsh-bi-form{display:flex;flex-direction:column;gap:8px'), true, '分组间距必须压到 8px')
  assert.equal(css.includes('font-size:12px;line-height:1.45'), true, '正文 12px / 行高 1.45')
  assert.equal(css.includes('.dsh-bi-group-head{display:flex;align-items:center;gap:6px;min-height:24px'), true)
  assert.equal(css.includes('.dsh-bi-prow{display:flex;align-items:center;gap:6px;min-height:22px'), true)
  // 旧版式（14px 内边距的 fieldset + 大 legend + 18px 间距）必须彻底消失，避免两套密度混着用。
  for (const gone of ['.dsh-bi-fieldset', '.dsh-bi-legend', '.dsh-bi-grid', 'gap:18px', 'padding:14px', 'min-height:140px']) {
    assert.equal(css.includes(gone), false, `旧版式残留：${gone}`)
  }

  // 一次操作就能看到全部主要设置：默认视图里 4 个分组头 + 清单行 + 操作条，且都带摘要。
  const view = page.view()
  const badges = []
  const groupHeads = []
  const rows = []
  const walk = (element) => {
    if (element === null || typeof element !== 'object') return
    if (element.props?.['data-dsh-bi-badge'] !== undefined) badges.push(element.props['data-dsh-bi-badge'])
    if (element.props?.['data-dsh-bi-group'] !== undefined) groupHeads.push(element.props['data-dsh-bi-group'])
    if (element.props?.['data-dsh-bi-profile'] !== undefined) rows.push(element.props['data-dsh-bi-profile'])
    for (const child of childrenOf(element)) walk(child)
  }
  walk(view.node)
  assert.deepEqual(groupHeads, ['prompt', 'profiles', 'model', 'params'], '四个分组都在默认视图里')
  assert.deepEqual(badges.sort(), ['model', 'params', 'profiles', 'prompt'], '每个分组都有一行摘要')
  assert.deepEqual(rows, ['', 'concise', 'spec'], '追加提示词清单常驻，无需展开即可切换')
  // 单选在紧凑行里没有独立标签，必须有可访问名（读屏可用）。
  for (const key of ['', 'concise', 'spec']) {
    assert.equal(
      typeof view.profileActive.get(key).props['aria-label'] === 'string'
        && view.profileActive.get(key).props['aria-label'] !== '',
      true,
      `清单行 ${key || '(不追加)'} 的单选缺少可访问名`,
    )
  }
  // 操作条常驻顶部：保存/恢复默认/打开配置文件都在默认视图里。
  assert.equal(view.action('save') !== undefined, true)
  assert.equal(view.action('reset') !== undefined, true)
  assert.equal(view.action('open-config') !== undefined, true)
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
  const view = page.open('prompt', 'model', 'params')
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
  let view = page.open('prompt', 'params')
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
await test('校验失败：不保存、逐字段给可读提示，并自动展开出错的分组', async () => {
  const page = mountSettings({ settingsValue: undefined })
  let view = page.open('prompt', 'model', 'params')
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

  // 收起状态下的"错误提示在折叠区里"是这套布局最容易出的事故：新开一页、不展开任何分组，
  // 直接改字段再保存，出错的分组必须被自动展开（否则用户看不到是哪一个字段错了）。
  const fresh = mountSettings({ settingsValue: { modelProvider: 'acme' } })   // 只填 provider = 必然报错
  fresh.open('model').inputs.get('modelId').props.onChange({ target: { value: '' } })
  await fresh.view().action('save').props.onClick()
  const expanded = fresh.view()
  assert.equal(expanded.expands.get('model').props['aria-expanded'], true, '出错的分组必须自动展开')
  assert.equal(expanded.errors.includes('settings.err.modelPair'), true)
})
await test('校验含上界（与宿主 validate 同值），超界在客户端就拦下', async () => {
  // 旧客户端镜像只查下界：填 700000 会先过预校验、再由宿主拒绝，而 mutate 静默失败
  // → 界面假报"已保存"。这里钉住上界必须在客户端也被拦住。
  const page = mountSettings({ settingsValue: undefined })
  let view = page.open('params')
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
  const view = page.open('prompt')
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
  const view = page.open('prompt')
  view.inputs.get('systemPrompt').props.onChange({ target: { value: '新' } })
  await page.view().action('save').props.onClick()
  const note = page.view().noteText
  assert.equal(note.includes('settings.saveFailed'), true)
  assert.equal(note.includes('settings scope is not mounted'), true)
})
await test('恢复默认配置：对所有字段发 unset（含追加提示词），回到默认与组合配置', async () => {
  const page = mountSettings({
    settingsValue: {
      customPromptEnabled: true,
      systemPrompt: 'x',
      modelProvider: 'acme',
      modelId: 'm1',
      promptProfiles: [{ id: 'p1', name: '周报', prompt: '稿' }],
      activeProfileId: 'p1',
    },
  })
  await page.view().action('reset').props.onClick()
  assert.equal(page.scope.mutations.length, 1)
  const { ops } = page.scope.mutations[0]
  // 9 个通用字段（含追加提示词列表与启用 id）+ 每个优化风格 1 个提示词字段。重置必须连追加提示词一起清掉，
  // 否则"恢复默认配置"会留下改不掉的追加提示词。
  assert.equal(ops.length, 9 + HOST_STYLE_IDS.length)
  assert.equal(ops.every(op => op.op === 'unset'), true)
  assert.deepEqual(ops.map(op => op.path[0]).sort(), [
    'customPromptEnabled', 'maxOutputTokens', 'modelId', 'modelProvider', 'systemPrompt', 'temperature', 'timeoutMs',
    'promptProfiles', 'activeProfileId',
    ...HOST_STYLE_FIELDS,
  ].sort())
  assert.equal(page.view().noteText, 'settings.resetDone')
})
console.log('client half: 内置清单行（P8：精简/转规格并入追加提示词）')
await test('内置追加提示词以内置行渲染在追加提示词清单最前：可编辑、可启用，但没有删除按钮和名称框', async () => {
  const page = mountSettings({
    profiles: [
      { id: 'concise', name: '精简', source: 'config', builtIn: true },
      { id: 'spec', name: '转规格', source: 'default', builtIn: true },
    ],
    settingsValue: {},
  })
  page.view()
  await tick()                        // 等 /catalog 落地（来源标注由宿主下发）
  // 清单行常驻（单选 + 名称 + 摘要），点「编辑」才出现它自己的输入框。
  const closed = page.view()
  assert.deepEqual(
    [...closed.profileActive.keys()],
    ['', 'concise', 'spec'],
    '清单由「不追加」+ 两个内置条目组成',
  )
  const view = page.open('profile:concise', 'profile:spec')
  // 内置行的提示词框：空 = 回落到"默认链 + 追加要求"，所以显示为空并带专门 placeholder。
  const concise = view.inputs.get('profilePrompt:concise')
  const spec = view.inputs.get('profilePrompt:spec')
  assert.ok(concise !== undefined, '「精简」必须以内置清单行出现')
  assert.ok(spec !== undefined, '「转规格」必须以内置清单行出现')
  assert.equal(concise.props.value, '')
  assert.equal(concise.props.disabled, false)
  // 内置行没有名称输入框（名称固定），也没有删除按钮。
  assert.ok(view.inputs.get(`profileName:concise`) === undefined, '内置名称固定，不提供名称框')
  const deleteButtons = view.buttons.filter(button => String(button.props['data-dsh-bi-action'] ?? '').startsWith('delete-profile:concise'))
  assert.equal(deleteButtons.length, 0, '内置追加提示词不可删除')
  // 行上标出"追加要求的当前来源"（宿主下发）。
  const hints = []
  const walk = (element) => {
    if (element === null || typeof element !== 'object') return
    if (typeof element.props?.className === 'string' && element.props.className.includes('dsh-bi-hint')) {
      hints.push(childrenOf(element)[0])
    }
    for (const child of childrenOf(element)) walk(child)
  }
  walk(view.node)
  assert.equal(hints.some(text => String(text).includes('settings.source.config')), true, '要标出组合层来源')
  assert.equal(hints.some(text => String(text).includes('settings.source.default')), true, '要标出内置默认来源')
})
await test('编辑内置追加提示词保存：存储整体替换条目（名称取词典固定值），只发变化的部分', async () => {
  const page = mountSettings({ settingsValue: {} })
  let view = page.open('profile:concise')
  view.inputs.get('profilePrompt:concise').props.onChange({ target: { value: '我自己的精简全文' } })
  await page.view().action('save').props.onClick()
  assert.equal(page.scope.mutations.length, 1)
  // 内置覆盖不带 name 字段：显示名由宿主按内置标签补齐，不把随界面语言变化的文本写进存储。
  assert.deepEqual(page.scope.mutations[0].ops, [
    { op: 'set', path: ['promptProfiles'], value: [{ id: 'concise', prompt: '我自己的精简全文' }] },
  ])
  assert.equal(page.view().noteText, 'settings.saved')

  // 清空 = 放弃覆盖：存储条目被丢弃（整表 set 不再包含它），回落到内置追加文案。
  page.view().inputs.get('profilePrompt:concise').props.onChange({ target: { value: '   ' } })
  await page.view().action('save').props.onClick()
  assert.deepEqual(page.scope.mutations[1].ops, [{ op: 'unset', path: ['promptProfiles'] }])
})
await test('用户条目与内置覆盖可以共存：一次保存发出整张表', async () => {
  const page = mountSettings({
    settingsValue: {
      promptProfiles: [
        { id: 'concise', name: '精简', prompt: '内置覆盖' },
        { id: 'weekly', name: '周报', prompt: '周报正文' },
      ],
      activeProfileId: 'weekly',
    },
  })
  let view = page.open('profile:concise')
  // 内置行回显已存储的覆盖值；启用单选回显 'weekly'。
  assert.equal(view.inputs.get('profilePrompt:concise').props.value, '内置覆盖')
  assert.equal(view.profileActive.get('weekly').props.checked, true)
  // 新增一条（清单行立即出现，输入框要展开那行才有）再保存：整表一起发。
  view.action('add-profile').props.onClick()
  const newId = [...page.view().profileActive.keys()].find(key => key.startsWith('bi-p-'))
  assert.ok(newId !== undefined, '新增的清单行必须出现（id 以 bi-p- 开头）')
  view = page.open(`profile:${newId}`)
  view.inputs.get(`profileName:${newId}`).props.onChange({ target: { value: '待办' } })
  view.inputs.get(`profilePrompt:${newId}`).props.onChange({ target: { value: '待办正文' } })
  await page.view().action('save').props.onClick()
  const { ops } = page.scope.mutations[0]
  const profilesOp = ops.find(op => op.path[0] === 'promptProfiles')
  assert.deepEqual(profilesOp, {
    op: 'set',
    path: ['promptProfiles'],
    value: [
      { id: 'concise', prompt: '内置覆盖' },
      { id: 'weekly', name: '周报', prompt: '周报正文' },
      { id: newId, name: '待办', prompt: '待办正文' },
    ],
  })
  // activeProfileId 指向仍存在的 weekly：不需要改动。
  assert.equal(ops.some(op => op.path[0] === 'activeProfileId'), false)
})

console.log('client half: 系统提示词可见 + 追加提示词（设置页）')
await test('默认提示词可查看、可一键填入编辑框（目录下发的 defaults.systemPrompt）', async () => {
  const page = mountSettings({ settingsValue: {} })
  // 目录没到之前没有正文可显示，「查看」按钮应禁用而不是点了没反应。
  assert.equal(page.open('prompt').action('toggle-default').props.disabled, true)
  await tick()
  let view = page.open('prompt')
  assert.equal(view.action('toggle-default').props.disabled, false)
  assert.equal(view.defaultPromptText, null, '默认收起，不占版面')

  view.action('toggle-default').props.onClick()
  view = page.view()
  assert.equal(view.defaultPromptText, '默认提示词全文', '展开后能看到宿主下发的默认正文')

  // 「以默认为基础编辑」：填入正文并自动启用自定义系统提示词（只填不用会让人以为生效了）。
  view.action('use-default').props.onClick()
  view = page.view()
  assert.equal(view.inputs.get('systemPrompt').props.value, '默认提示词全文')
  assert.equal(view.inputs.get('customPromptEnabled').props.checked, true)
})
await test('已保存的追加提示词会回填：名称/提示词/启用单选都渲染出来', () => {
  const page = mountSettings({
    settingsValue: {
      promptProfiles: [
        { id: 'p1', name: '周报', prompt: '你是周报写手' },
        { id: 'p2', name: '待办', prompt: '你是待办助手' },
      ],
      activeProfileId: 'p2',
    },
  })
  // 单选与摘要常驻可见；输入框要展开对应行才有。
  const closed = page.view()
  assert.equal(closed.profileActive.get('p2').props.checked, true, '启用中的追加提示词单选要回显')
  assert.equal(closed.profileActive.get('p1').props.checked, false)
  assert.equal(closed.profileActive.get('').props.checked, false, '「不追加」选项存在且未选中')
  assert.equal(closed.inputs.size, 0, '未展开时不该有输入框')

  const view = page.open('profile:p1', 'profile:p2')
  assert.equal(view.inputs.get('profileName:p1').props.value, '周报')
  assert.equal(view.inputs.get('profilePrompt:p1').props.value, '你是周报写手')
  assert.equal(view.inputs.get('profilePrompt:p2').props.value, '你是待办助手')
})
await test('新增追加提示词：清单行立即出现；展开后填好，保存发出整个 promptProfiles 数组（一次 set）', async () => {
  const page = mountSettings({ settingsValue: {} })
  let view = page.view()
  view.action('add-profile').props.onClick()
  const id = [...page.view().profileActive.keys()].find(key => key.startsWith('bi-p-'))
  assert.ok(id !== undefined, '新增后清单行必须立即出现（id 以 bi-p- 开头）')
  assert.equal(page.view().inputs.size, 0, '新行默认只有一行摘要，输入框要展开才出现')
  view = page.open(`profile:${id}`)
  view.inputs.get(`profileName:${id}`).props.onChange({ target: { value: '  周报 ' } })
  view.inputs.get(`profilePrompt:${id}`).props.onChange({ target: { value: '你是周报写手' } })
  await page.view().action('save').props.onClick()

  assert.equal(page.scope.mutations.length, 1)
  const { ops } = page.scope.mutations[0]
  // 名称要 trim；整个列表作为**一个字段**原子提交（数组在设置通道里是合法值）。
  assert.deepEqual(ops, [
    { op: 'set', path: ['promptProfiles'], value: [{ id, name: '周报', prompt: '你是周报写手' }] },
  ])
  assert.equal(page.view().noteText, 'settings.saved')
})
await test('全空的清单行保存时被丢弃：不报错、也不存出空追加提示词', async () => {
  const page = mountSettings({ settingsValue: {} })
  page.view().action('add-profile').props.onClick()
  await page.view().action('save').props.onClick()
  assert.equal(page.scope.mutations.length, 0, '整行全空 = 没有可保存的改动')
  assert.equal(page.view().noteText, 'settings.noChange')
})
await test('校验：填了一半的追加提示词（缺名称或缺提示词）在客户端就拦下', async () => {
  const page = mountSettings({ settingsValue: {} })
  page.view().action('add-profile').props.onClick()
  const id = [...page.view().profileActive.keys()].find(key => key.startsWith('bi-p-'))
  const view = page.open(`profile:${id}`)
  view.inputs.get(`profileName:${id}`).props.onChange({ target: { value: '只有名字' } })
  await page.view().action('save').props.onClick()

  assert.equal(page.scope.mutations.length, 0, '校验不过绝不能写')
  const after = page.view()
  assert.deepEqual(after.errors, ['settings.err.profilePrompt'])
  assert.equal(after.noteText, 'settings.invalid')
})
await test('在追加提示词间切换：只发 activeProfileId 一个 set', async () => {
  const page = mountSettings({
    settingsValue: {
      promptProfiles: [
        { id: 'p1', name: 'A', prompt: 'P1' },
        { id: 'p2', name: 'B', prompt: 'P2' },
      ],
      activeProfileId: 'p1',
    },
  })
  page.view().profileActive.get('p2').props.onChange()
  await page.view().action('save').props.onClick()
  assert.deepEqual(page.scope.mutations[0].ops, [
    { op: 'set', path: ['activeProfileId'], value: 'p2' },
  ])
})
await test('删除启用中的追加提示词：activeProfileId 一并退回默认（unset）', async () => {
  const page = mountSettings({
    settingsValue: {
      promptProfiles: [{ id: 'p1', name: '周报', prompt: '稿子' }],
      activeProfileId: 'p1',
    },
  })
  let view = page.view()
  view.action('delete-profile:p1').props.onClick()
  view = page.view()
  assert.equal(view.profileActive.get('').props.checked, true, '删除后退回「默认」')
  await view.action('save').props.onClick()
  assert.deepEqual(page.scope.mutations[0].ops, [
    { op: 'unset', path: ['promptProfiles'] },
    { op: 'unset', path: ['activeProfileId'] },
  ])
})
await test('宿主拒绝追加提示词写入时不假报成功（opsApplied 对数组做深比较）', async () => {
  const page = mountSettings({
    settingsValue: { promptProfiles: [{ id: 'p1', name: '旧', prompt: '旧稿' }] },
    mutateRefuse: true,
  })
  const view = page.open('profile:p1')
  view.inputs.get('profilePrompt:p1').props.onChange({ target: { value: '新稿' } })
  await page.view().action('save').props.onClick()

  assert.equal(page.scope.mutations.length, 1, '确实发起了写入')
  const after = page.view()
  assert.equal(after.noteTone, 'error')
  assert.equal(after.noteText.includes('settings.saved'), false, '数组写失败绝不能报"已保存"')
})

console.log('client half: 追加提示词切换（输入框旁 ▾ 菜单）')
await test('用户自定义追加提示词排在内置种子之后；点选后落盘 activeProfileId 并移动选中标记', async () => {
  installFetch({
    profiles: [
      { id: 'concise', name: '精简', source: 'default', builtIn: true },
      { id: 'spec', name: '转规格', source: 'default', builtIn: true },
      { id: 'weekly', name: '周报', source: 'settings', builtIn: false },
      { id: 'todo', name: '待办', source: 'settings', builtIn: false },
    ],
    activeProfileId: 'weekly',
  })
  const harness = mount({ draft: '帮我写个脚本' })
  harness.view()
  await tick()
  await harness.view().presetToggle.props.onClick()
  let view = harness.view()
  assert.deepEqual(
    view.profileItems.map(item => item.props['data-dsh-better-input-profile']),
    ['', 'concise', 'spec', 'weekly', 'todo'],
    '「默认」在最前，内置种子随后，用户条目按宿主顺序排最后',
  )
  assert.equal(view.profileItems[3].props['data-active'], true, '宿主标了启用中的追加提示词要回显')

  // 点「待办」：乐观更新选中标记；写入成功（假 scope 落盘）后提示 ok。
  await view.profileItems[4].props.onClick()
  await tick()
  view = harness.view()
  assert.deepEqual(harness.scope.mutations, [{
    ops: [{ op: 'set', path: ['activeProfileId'], value: 'todo' }],
    revision: 7,
  }])
  assert.equal(view.profileItems[4].props['data-active'], true)
  assert.equal(view.profileItems[3].props['data-active'], false)
  assert.equal(view.menuOpen, true, '切换不收起菜单')
  assert.equal(view.noteTone, 'ok')

  // 切回「默认」：发 unset。
  await view.profileItems[0].props.onClick()
  await tick()
  assert.deepEqual(harness.scope.mutations[1].ops, [{ op: 'unset', path: ['activeProfileId'] }])
})

console.log('client half: 打开插件配置文件（P6.3）')
await test('打开配置文件按钮：调宿主路由，成功时显示宿主回传的绝对路径', async () => {
  const page = mountSettings({ settingsValue: {} })
  const button = page.view().action('open-config')
  assert.equal(button.props.disabled, false, '按钮必须可点')
  await button.props.onClick()
  const call = page.network.calls.find(item => item.url === ROUTE_OPEN_CONFIG)
  assert.ok(call !== undefined, '必须打到宿主的打开路由')
  assert.equal(call.method, 'POST')
  const note = page.view().noteText
  assert.equal(String(note).startsWith('settings.openConfig.ok'), true)
  // 路径由宿主解析并回传，前端只显示——绝不自己拼 profile 布局。
  assert.equal(String(note).includes('C:\\fake\\dsh-better-input\\cordis.patch.yml'), true)
  assert.equal(page.view().noteTone, 'ok')
  assert.equal(page.view().action('open-config').props.disabled, false, '结束后要恢复可点')
})
await test('打开失败：把宿主的原因原样展示（找不到文件 / 平台不支持 / 起不来）', async () => {
  const failed = mountSettings({
    settingsValue: {},
    failOpenConfig: true,
    openConfig: { error: 'open-failed', message: '打开失败（spawn ENOENT）；请手动打开：C:\\x\\cordis.patch.yml' },
  })
  await failed.view().action('open-config').props.onClick()
  const note = String(failed.view().noteText)
  assert.equal(note.startsWith('settings.openConfig.fail'), true, '失败必须有明确提示')
  assert.equal(note.includes('spawn ENOENT'), true, '宿主给的原因必须原样带给用户')
  assert.equal(note.includes('请手动打开'), true, '必须给出可直接照做的兜底路径')
  assert.equal(failed.view().noteTone, 'error')
  assert.equal(failed.view().action('open-config').props.disabled, false, '失败后按钮要能再点')

  // 网络层直接失败（宿主路由没挂上）也要有提示，不能静默什么都不发生。
  const page = mountSettings({ settingsValue: {} })
  globalThis.fetch = async () => { throw new TypeError('failed to fetch') }
  await page.view().action('open-config').props.onClick()
  assert.equal(String(page.view().noteText).startsWith('settings.openConfig.fail'), true)
})
await test('设置页展示配置文件路径（便于手动编辑/复制）', async () => {
  const page = mountSettings({ settingsValue: {} })
  page.view()
  await tick()                        // 路径来自 /catalog 的 configPath
  let pathText = null
  const walk = (element) => {
    if (element === null || typeof element !== 'object') return
    if (element.props?.['data-dsh-bi-config-path'] !== undefined) pathText = childrenOf(element)[0]
    for (const child of childrenOf(element)) walk(child)
  }
  walk(page.view().node)
  assert.equal(String(pathText).includes('C:\\fake\\dsh-better-input\\cordis.patch.yml'), true)
})

await test('远端提交后（未在编辑）表单会同步成新值', async () => {
  const page = mountSettings({ settingsValue: { systemPrompt: '旧值' } })
  assert.equal(page.open('prompt').inputs.get('systemPrompt').props.value, '旧值')
  page.scope.publish({ value: { systemPrompt: '远端改了' } })
  assert.equal(page.view().inputs.get('systemPrompt').props.value, '远端改了')
})
await test('可写性/可用性两态都有明确说明', () => {
  const readOnly = mountSettings({ settingsValue: {}, writable: false })
  // 只读时依然可以展开查看（输入控件是 disabled，不是藏起来）。
  const readOnlyView = readOnly.open('prompt')
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
  let view = page.open('model')
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
  const brokenView = broken.open('model')
  assert.equal(brokenView.errors.includes('settings.err.loadCatalog'), true, '目录失败要提示且可手填')
  assert.equal(brokenView.inputs.get('modelId').props.disabled, false, '手填仍然可用')
})
await test('测试按钮：走宿主试调路由，成功失败都有可读结论', async () => {
  const okPage = mountSettings({ settingsValue: { modelProvider: 'acme', modelId: 'm1' } })
  await okPage.open('model').action('test').props.onClick()
  const checkCall = okPage.network.calls.find(call => call.url === ROUTE_CHECK)
  assert.deepEqual(checkCall.body, { provider: 'acme', model: 'm1' })
  assert.equal(okPage.view().noteText.includes('settings.model.testOk'), true)

  const badPage = mountSettings({
    settingsValue: { modelProvider: 'acme', modelId: 'nope' },
    check: { ok: false, message: 'unknown model' },
  })
  await badPage.open('model').action('test').props.onClick()
  const badNote = badPage.view().noteText
  assert.equal(badNote.includes('settings.model.testFail'), true)
  assert.equal(badNote.includes('unknown model'), true)
  assert.equal(badPage.view().noteTone, 'error')

  const missingPage = mountSettings({ settingsValue: {} })
  await missingPage.open('model').action('test').props.onClick()
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
