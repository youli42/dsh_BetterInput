/**
 * 通用输入角标（P13）测试：主输入框之外的每个输入窗口都能优化输入。
 *
 * 为什么单独一个套件、并且自带一个"够真"的小 DOM：
 *   · 这一层做的事**全在 DOM 上**（扫描 textarea、量矩形、写回受控组件的值、派发 input 事件），
 *     `client.smoke.mjs` 的替身只为"座位组件"造了几样 API（没有 body、没有选择器、
 *     没有事件冒泡），根本驱动不了它；
 *   · 真 DOM 需要 jsdom（本仓库没有、也不打算为一个功能引入依赖），而这个功能的正确性判据
 *     恰好都很小：**够不够格挂**、**量到的矩形对不对**、**写回有没有派发 input 事件**、
 *     **用户手改有没有被覆盖**。给这几条各写一个探针，比拉一整套 jsdom 更诚实。
 *
 * 覆盖边界（别高估）：
 *   · 这里**不**跑 React：写回"受控组件"的那条路是用「原生 value setter + input 事件」
 *     建模的（`win.HTMLTextAreaElement.prototype` 上的访问器），React 自己的 value tracker
 *     不在这套替身里——该行为由真实浏览器的通行做法保证，随机安装验收覆盖。
 *   · 不测 CSS 视觉（角标长什么样），只测它的元素/状态/位置数值。
 *
 * 运行：node test/client.universal.mjs （`npm test` 会跑）
 */

import assert from 'node:assert/strict'

let passed = 0
const failures = []

/**
 * 跑一个用例，记录失败但不中断其余用例。
 * @param {string} label - 用例名。
 * @param {() => (void | Promise<void>)} body - 用例体。
 * @returns {Promise<void>} 完成。
 */
async function test(label, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 让微任务队列跑干净（fetch/流/写回都是 promise 链）。 */
async function flush(times = 6) {
  for (let index = 0; index < times; index += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

/* ── 极简 DOM 替身（只实现本功能用到的 API） ───────────────────────────── */

/** 匹配一个简单选择器：`tag`（忽略大小写）或 `[attr]`。 */
function matches(element, selector) {
  if (selector.startsWith('[') && selector.endsWith(']')) {
    return element.hasAttribute(selector.slice(1, -1))
  }
  return element.tagName === selector.toUpperCase()
}

/** 一个元素。 */
class FakeElement {
  /**
   * @param {string} tagName - 标签名。
   * @param {object} ownerDocument - 所属 document。
   */
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = ownerDocument
    this.parentElement = null
    this.childNodes = []
    this.attributes = new Map()
    this.style = {}
    this.dataset = {}
    this.textContent = ''
    this.listeners = new Map()
    this.disabled = false
    this.readOnly = false
    /** 视口矩形（用例按需设置；默认给一个"看得见"的框）。 */
    this.rect = { left: 10, top: 100, right: 410, bottom: 220, width: 400, height: 120 }
  }

  /** 是否挂在 documentElement 上（真 DOM 的语义）。 */
  get isConnected() {
    let node = this
    while (node.parentElement !== null) node = node.parentElement
    return node === this.ownerDocument.documentElement
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this
      node.removed = false
      this.childNodes.push(node)
    }
  }

  appendChild(node) {
    this.append(node)
    return node
  }

  remove() {
    const parent = this.parentElement
    if (parent !== null) {
      const at = parent.childNodes.indexOf(this)
      if (at >= 0) parent.childNodes.splice(at, 1)
    }
    this.parentElement = null
    this.removed = true
  }

  /** 祖先链（含自身）逐个匹配。 */
  closest(selector) {
    let node = this
    while (node !== null && node !== undefined) {
      if (matches(node, selector)) return node
      node = node.parentElement
    }
    return null
  }

  addEventListener(type, listener) {
    const bucket = this.listeners.get(type) ?? []
    bucket.push(listener)
    this.listeners.set(type, bucket)
  }

  removeEventListener(type, listener) {
    const bucket = this.listeners.get(type) ?? []
    const at = bucket.indexOf(listener)
    if (at >= 0) bucket.splice(at, 1)
  }

  /**
   * 派发事件：先跑本元素的监听器，再按 `bubbles` 向上冒泡。
   * @param {object} event - 事件对象。
   * @returns {boolean} 恒为 true（不实现 preventDefault 语义）。
   */
  dispatchEvent(event) {
    let node = this
    while (node !== null && node !== undefined) {
      event.currentTarget = node
      for (const listener of [...(node.listeners.get(event.type) ?? [])]) listener.call(node, event)
      if (event.bubbles !== true) break
      node = node.parentElement
    }
    return true
  }

  getBoundingClientRect() {
    return this.rect
  }
}

/** 平台的原生 value 访问器（插件要求"走原生 setter"）。 */
Object.defineProperty(FakeElement.prototype, 'value', {
  configurable: true,
  get() {
    return this._value ?? ''
  },
  set(next) {
    this._value = String(next)
  },
})

/** 一个 document。 */
class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement('html', this)
    this.body = new FakeElement('body', this)
    this.documentElement.append(this.body)
    this.mutationObservers = []
  }

  createElement(tagName) {
    return new FakeElement(tagName, this)
  }

  /** 深度优先遍历 documentElement 下的全部后代。 */
  walk() {
    const all = []
    const visit = (node) => {
      for (const child of node.childNodes) {
        all.push(child)
        visit(child)
      }
    }
    visit(this.documentElement)
    return all
  }

  querySelectorAll(selector) {
    return this.walk().filter(element => matches(element, selector))
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  /** 造一个元素并挂到 body 上（用例的"页面上多了一个输入框"）。 */
  add(tagName, options = {}) {
    const element = this.createElement(tagName)
    if (options.rect !== undefined) element.rect = options.rect
    if (options.parent !== undefined) options.parent.append(element)
    else this.body.append(element)
    return element
  }

  /** 触发一次 MutationObserver 回调（真 DOM 由浏览器调用）。 */
  flushMutations() {
    for (const observer of this.mutationObservers) {
      if (observer.disconnected !== true) observer.callback([], observer)
    }
  }
}

/**
 * 一个 window：定时器/事件/观察器都可手工驱动。
 * @param {object} document - 所属 document。
 * @returns {object} window 替身。
 */
function makeWindow(document) {
  const timeouts = new Map()
  const intervals = new Map()
  const listeners = new Map()
  let seq = 0
  return {
    document,
    innerHeight: 800,
    HTMLTextAreaElement: FakeElement,
    HTMLInputElement: FakeElement,
    Event: class FakeEvent {
      constructor(type, init) {
        this.type = type
        this.bubbles = init?.bubbles === true
        this.target = null
        this.currentTarget = null
      }
    },
    MutationObserver: class FakeMutationObserver {
      constructor(callback) {
        this.callback = callback
        this.disconnected = false
        document.mutationObservers.push(this)
      }
      observe(target) {
        this.target = target
      }
      disconnect() {
        this.disconnected = true
      }
    },
    setTimeout: (callback) => {
      seq += 1
      timeouts.set(seq, callback)
      return seq
    },
    clearTimeout: (id) => {
      timeouts.delete(id)
    },
    setInterval: (callback) => {
      seq += 1
      intervals.set(seq, callback)
      return seq
    },
    clearInterval: (id) => {
      intervals.delete(id)
    },
    addEventListener: (type, listener, options) => {
      const bucket = listeners.get(type) ?? []
      bucket.push({ listener, options })
      listeners.set(type, bucket)
    },
    removeEventListener: (type, listener) => {
      const bucket = listeners.get(type) ?? []
      const at = bucket.findIndex(entry => entry.listener === listener)
      if (at >= 0) bucket.splice(at, 1)
    },
    /** 推进到期的 setTimeout（去抖扫描就是靠它）。 */
    flushTimeouts() {
      const pending = [...timeouts.entries()]
      timeouts.clear()
      for (const [, callback] of pending) callback()
    },
    /** 触发一次 window 级事件（scroll/resize）。 */
    emit(type) {
      const event = { type }
      for (const entry of [...(listeners.get(type) ?? [])]) entry.listener(event)
      return (listeners.get(type) ?? []).length
    },
    /** 在跑的 interval 数（空闲时必须是 0）。 */
    intervalCount: () => intervals.size,
    listenerCount: type => (listeners.get(type) ?? []).length,
  }
}

/* ── 宿主路由替身 ─────────────────────────────────────────────────────── */

const ROUTE = '/api/dsh-input-optimizer/optimize'
const ROUTE_STREAM = '/api/dsh-input-optimizer/optimize/stream'
const ROUTE_CATALOG = '/api/dsh-input-optimizer/catalog'

/**
 * 装一个 fetch 替身：目录立即结算，流式路由返回可控 SSE 流，一次性路由立即结算。
 * @param {{ streaming?: boolean, fallbackText?: string, limits?: object, catalogFail?: boolean }} [options] - 参数。
 * @returns {object} 门面：calls / stream。
 */
function installFetch(options = {}) {
  const calls = []
  const encoder = new TextEncoder()
  let streamController = null
  /** 推一帧（`event:` + `data:` 两行 + 空行分隔，与宿主 SSE 契约一致）。 */
  const send = (event, data) => {
    streamController.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
  }
  const stream = {
    controller: null,
    /** 推一段**文本增量**（最常用的那一帧）。 */
    push(text) {
      send('delta', { text })
    },
    /** 推一帧自定义事件。 */
    pushEvent(event, data) {
      send(event, data)
    },
    done(text, truncated = false) {
      send('done', { text, truncated })
      streamController.close()
    },
    /** 宿主报错（error 帧）后正常收流。 */
    fail(message) {
      send('error', { error: 'model-failed', message })
      streamController.close()
    },
    /** 断流（网络中断）。 */
    break() {
      streamController.error(new Error('network broke'))
    },
    close() {
      streamController.close()
    },
  }
  globalThis.fetch = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    })
    if (url === ROUTE_CATALOG) {
      if (options.catalogFail === true) return { ok: false, status: 500, json: async () => ({}) }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          limits: options.limits ?? {
            maxInputChars: 8000,
            temperature: { min: 0, max: 2 },
            maxOutputTokens: { min: 1, max: 200000 },
            timeoutMs: { min: 1000, max: 600000 },
          },
          presets: [],
          profiles: [],
          effective: { profileId: null },
        }),
      }
    }
    if (url === ROUTE_STREAM && options.streaming === false) {
      return { ok: false, status: 404, json: async () => ({}) }
    }
    if (url === ROUTE_STREAM) {
      const body = new ReadableStream({
        start(controller) {
          streamController = controller
          stream.controller = controller
        },
      })
      // 真实 fetch 在 signal 中止时会取消 body：不让它挂住，取消用例才能立刻结束。
      if (init?.signal !== undefined) {
        init.signal.addEventListener('abort', () => {
          try {
            streamController.error(new Error('aborted'))
          } catch {
            // 流可能已经关闭/出错，忽略。
          }
        })
      }
      return { ok: true, status: 200, body }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ text: options.fallbackText ?? '回退后的文本', truncated: false }),
    }
  }
  return { calls, stream }
}

/* ── 加载 bundle ──────────────────────────────────────────────────────── */

let entry
globalThis.window = { __ModuleLoader__: { load: loaded => { entry = loaded } } }
globalThis.document = { createElement: () => ({ dataset: {}, id: '', textContent: '' }), getElementById: () => null }

await import('../lib/client.js')

/** 本套件不渲染座位组件，React 只给到"能被 require"的最小形状（通用角标是纯 DOM 层）。 */
const inertReact = { createElement: () => null, useState: () => [null, () => {}], useRef: () => ({ current: null }), useEffect: () => {} }

const exports_ = entry.factory(spec => {
  if (spec === 'react') return inertReact
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return {}
  throw new Error(`unexpected require("${spec}")`)
})

/** 取 bundle 暴露的通用角标把手（框架不读它，测试用它直接驱动控制器）。 */
const universalApi = exports_.universal
assert.ok(universalApi !== undefined, 'bundle 必须暴露 universal 把手')

/** 一个"看得见"的宿主矩形。 */
const RECT = { left: 10, top: 100, right: 410, bottom: 220, width: 400, height: 120 }
/** 一个"太小/不可见"的宿主矩形。 */
const TINY_RECT = { left: 10, top: 100, right: 60, bottom: 118, width: 50, height: 18 }

/**
 * 搭一个环境：假 DOM + 假路由 + 一个通用角标控制器。
 * @param {object} [options] - 透传给 fetch 替身。
 * @returns {object} 环境。
 */
function setup(options = {}) {
  const doc = new FakeDocument()
  const win = makeWindow(doc)
  const network = installFetch(options)
  const universal = universalApi.create({ t: key => key, win, doc })
  return {
    doc,
    win,
    network,
    universal,
    /** 动态内容变化：MutationObserver 回调 + 去抖超时一起推进。 */
    settle() {
      doc.flushMutations()
      win.flushTimeouts()
    },
  }
}

/**
 * 取一个宿主的角标记录。
 * @param {object} env - 环境。
 * @param {object} host - 宿主要素。
 * @returns {object} 记录。
 */
function recordOf(env, host) {
  const record = env.universal.records.get(host)
  assert.ok(record !== undefined, '宿主应当有角标记录')
  return record
}

/**
 * 点一次角标。
 * @param {object} env - 环境。
 * @param {object} host - 宿主要素。
 * @returns {void}
 */
function clickBadge(env, host) {
  recordOf(env, host).badge.dispatchEvent(new env.win.Event('click', { bubbles: true }))
}

/**
 * 点一次撤销角标。
 * @param {object} env - 环境。
 * @param {object} host - 宿主要素。
 * @returns {void}
 */
function clickUndo(env, host) {
  recordOf(env, host).undoBadge.dispatchEvent(new env.win.Event('click', { bubbles: true }))
}

console.log('client half: 通用输入角标（P13）')

await test('扫描：只给只读/禁用/被跳过之外的 textarea 挂角标，并贴到右上角', () => {
  const env = setup()
  const host = env.doc.add('textarea')
  const readOnly = env.doc.add('textarea')
  readOnly.readOnly = true
  const disabled = env.doc.add('textarea')
  disabled.disabled = true
  const skipped = env.doc.add('textarea')
  skipped.setAttribute('data-dsh-better-input-skip', '1')
  const option = env.doc.add('input', { rect: TINY_RECT })

  env.universal.scan()

  assert.deepEqual([...env.universal.records.keys()], [host], '只有普通 textarea 够格')
  const record = recordOf(env, host)
  assert.equal(record.badge.style.display, 'flex')
  const expectedLeft = RECT.right - 20 - 4
  assert.equal(record.badge.style.left, `${String(expectedLeft)}px`, '角标贴右上角')
  assert.equal(record.badge.style.top, `${String(RECT.top + 4)}px`)
  assert.equal(record.badge.getAttribute('data-state'), 'idle')
  assert.equal(record.badge.parentElement.getAttribute(universalApi.rootAttr), 'better-input', '角标挂在覆盖层里')
  assert.equal(env.universal.records.has(option), false, '单选输入框默认不挂')
  assert.equal(env.universal.records.has(readOnly), false)
  assert.equal(env.universal.records.has(disabled), false)
  assert.equal(env.universal.records.has(skipped), false)
})

await test('本插件自己的界面（设置页/主按钮工具行）与主输入框区域里的输入框不挂角标', () => {
  const env = setup()
  const settings = env.doc.createElement('div')
  settings.setAttribute('data-dsh-bi-settings', 'ready')
  env.doc.body.append(settings)
  const inside = env.doc.add('textarea', { parent: settings })
  const wrap = env.doc.createElement('span')
  wrap.setAttribute('data-dsh-better-input-wrap', 'better-input')
  env.doc.body.append(wrap)
  const buttonHost = env.doc.add('textarea', { parent: wrap })
  // composer 在本版本是 contenteditable（不是 textarea），但旧版本/降级态会渲染真正的 textarea：
  // 主输入框已经有自己的 ✦ 按钮，这里必须按框架标记排除。
  const composer = env.doc.createElement('div')
  composer.setAttribute('data-composer-seat', '1')
  env.doc.body.append(composer)
  const composerHost = env.doc.add('textarea', { parent: composer })
  const free = env.doc.add('textarea')

  env.universal.scan()

  assert.deepEqual([...env.universal.records.keys()], [free])
  assert.equal(env.universal.records.has(inside), false)
  assert.equal(env.universal.records.has(buttonHost), false)
  assert.equal(env.universal.records.has(composerHost), false)
})

await test('显式报名（data-dsh-better-input-host）可以让非 textarea 控件也挂上角标', () => {
  const env = setup()
  const editor = env.doc.add('div')
  editor.setAttribute('data-dsh-better-input-host', '1')
  editor.textContent = '原文'
  env.universal.scan()

  const record = recordOf(env, editor)
  assert.equal(record.badge.style.display, 'flex')
})

await test('太小/不可见的宿主：角标存在但不显示；滚回视口内时重新显示', () => {
  const env = setup()
  const host = env.doc.add('textarea', { rect: TINY_RECT })
  env.universal.scan()
  assert.equal(recordOf(env, host).badge.style.display, 'none')

  host.rect = RECT
  assert.equal(env.win.emit('scroll'), 1, '滚动监听必须挂在 window 上')
  assert.equal(recordOf(env, host).badge.style.display, 'flex')

  host.rect = { ...RECT, top: 900, bottom: 1020 }
  env.win.emit('resize')
  assert.equal(recordOf(env, host).badge.style.display, 'none', '滚出视口后隐藏')
})

await test('被对话框/抽屉盖住的输入框：角标不能浮到覆盖层之上', () => {
  const env = setup()
  const host = env.doc.add('textarea')
  env.universal.scan()
  assert.equal(recordOf(env, host).badge.style.display, 'flex')

  // 假 DOM 默认没有 elementFromPoint → 按"取不到就当可见"处理（不误伤）。
  delete env.doc.elementFromPoint
  env.universal.reposition()
  assert.equal(recordOf(env, host).badge.style.display, 'flex')

  const overlay = env.doc.add('div')
  env.doc.elementFromPoint = () => overlay
  env.universal.reposition()
  assert.equal(recordOf(env, host).badge.style.display, 'none', '被盖住时角标要隐藏')
  assert.equal(recordOf(env, host).undoBadge.style.display, 'none')

  env.doc.elementFromPoint = () => host
  env.universal.reposition()
  assert.equal(recordOf(env, host).badge.style.display, 'flex', '对话框关掉后角标回来')
})

await test('点击 → 流式写入（受控组件：原生 setter + 冒泡 input 事件）→ 成功角标 + 撤销角标', async () => {
  const env = setup({ streaming: true })
  const host = env.doc.add('textarea')
  host.value = '原文'
  env.settle()
  const seen = []
  const outer = env.doc.createElement('div')
  env.doc.body.append(outer)
  outer.append(host)
  outer.addEventListener('input', event => seen.push({ type: event.type, value: host.value }))

  clickBadge(env, host)
  await flush()
  assert.equal(env.network.calls.at(-1).url, ROUTE_STREAM)
  assert.equal(env.network.calls.at(-1).body.text, '原文', '请求带的是宿主里的原文')
  assert.equal(recordOf(env, host).badge.getAttribute('data-state'), 'running')

  env.network.stream.push('改写')
  env.network.stream.push('后的文本')
  await flush()
  assert.equal(host.value, '改写', '节流：同一个 tick 内只写一次')
  assert.deepEqual(seen.at(-1), { type: 'input', value: '改写' }, '写回必须派发 input（冒泡到祖先）')

  env.network.stream.done('改写后的文本')
  await flush()
  const record = recordOf(env, host)
  assert.equal(host.value, '改写后的文本', '最终以 done 帧的文本为准')
  assert.equal(record.badge.getAttribute('data-state'), 'ok')
  assert.equal(record.undoBadge.style.display, 'flex', '成功后出现撤销角标')
  assert.equal(env.win.intervalCount(), 0, '收尾必须停掉进度计时器')
})

await test('撤销：还原原文；内容在优化后被动过时第一次只武装、第二次强制还原', async () => {
  const env = setup({ streaming: true })
  const host = env.doc.add('textarea')
  host.value = '原文'
  env.settle()
  clickBadge(env, host)
  await flush()
  env.network.stream.done('优化后的文本')
  await flush()
  assert.equal(host.value, '优化后的文本')

  // 用户改了内容 → 第一次点击只武装（不能悄悄丢掉用户刚写的东西）。
  host.value = '用户新写的'
  clickUndo(env, host)
  assert.equal(host.value, '用户新写的', '第一次点击不得还原')
  assert.equal(recordOf(env, host).undoBadge.getAttribute('title'), 'badge.undoForce')
  assert.equal(recordOf(env, host).note.style.display, 'block')

  clickUndo(env, host)
  assert.equal(host.value, '原文', '第二次点击强制还原')
  assert.equal(recordOf(env, host).badge.getAttribute('data-state'), 'idle')
  assert.equal(recordOf(env, host).undoBadge.style.display, 'none')
})

await test('空输入 / 超长：本地就拦下，不发任何优化请求', async () => {
  const env = setup({ streaming: true })
  const empty = env.doc.add('textarea')
  env.universal.scan()
  clickBadge(env, empty)
  await flush()
  assert.equal(recordOf(env, empty).note.textContent, 'empty')
  assert.equal(env.network.calls.filter(call => call.url !== ROUTE_CATALOG).length, 0)

  const long = env.doc.add('textarea')
  long.value = 'x'.repeat(8001)
  env.universal.scan()
  clickBadge(env, long)
  await flush()
  assert.equal(recordOf(env, long).note.textContent, 'tooLong（8001/8000）')
  assert.equal(env.network.calls.filter(call => call.url !== ROUTE_CATALOG).length, 0)
  assert.equal(recordOf(env, long).note.getAttribute('data-tone'), 'warn')
})

await test('生成中再点 = 取消：不改写、不报错、计时器停掉', async () => {
  const env = setup({ streaming: true })
  const host = env.doc.add('textarea')
  host.value = '原文'
  env.settle()
  clickBadge(env, host)
  await flush()
  env.network.stream.push('半截')
  await flush()
  assert.equal(host.value, '半截')

  clickBadge(env, host)
  await flush()
  assert.equal(recordOf(env, host).badge.getAttribute('data-state'), 'idle')
  assert.equal(recordOf(env, host).note.style.display, 'none', '主动取消不该弹失败提示')
  assert.equal(env.win.intervalCount(), 0)
})

await test('用户在流式中途手改 → 立刻中止、不覆盖、给 staleResult 提示', async () => {
  const env = setup({ streaming: true })
  const host = env.doc.add('textarea')
  host.value = '原文'
  env.settle()
  clickBadge(env, host)
  await flush()
  env.network.stream.push('改写')
  await flush()
  assert.equal(host.value, '改写')

  host.value = '用户插话'
  env.network.stream.push('后的文本')
  await flush()
  assert.equal(host.value, '用户插话', '绝不能覆盖用户此刻的输入')
  assert.equal(recordOf(env, host).note.textContent, 'staleResult')
  assert.equal(recordOf(env, host).undoBadge.style.display, 'none', '中止不入撤销栈')
})

await test('流中途 error 帧 → 还原原文并说明；失败不进撤销栈', async () => {
  const env = setup({ streaming: true })
  const host = env.doc.add('textarea')
  host.value = '原文'
  env.settle()
  clickBadge(env, host)
  await flush()
  env.network.stream.push('半截结果')
  await flush()
  env.network.stream.fail('上游炸了')
  await flush()
  assert.equal(host.value, '原文', '已写入的增量必须还原')
  assert.equal(recordOf(env, host).note.textContent, '上游炸了（streamReverted）')
  assert.equal(recordOf(env, host).badge.getAttribute('data-state'), 'error')
  assert.equal(recordOf(env, host).undoBadge.style.display, 'none')
})

await test('旧宿主没有流式路由 → 自动回退一次性 JSON，行为与主按钮一致', async () => {
  const env = setup({ streaming: false, fallbackText: '回退优化结果' })
  const host = env.doc.add('textarea')
  host.value = '原文'
  env.settle()
  clickBadge(env, host)
  await flush(10)
  assert.equal(host.value, '回退优化结果')
  assert.equal(recordOf(env, host).badge.getAttribute('data-state'), 'ok')
  assert.equal(env.network.calls.some(call => call.url === ROUTE), true, '必须真的走回退路由')
})

await test('动态插入/移除输入框：MutationObserver 扫描后自动挂角标、摘角标', () => {
  const env = setup()
  const first = env.doc.add('textarea')
  env.settle()
  assert.equal(env.universal.records.has(first), true)

  const second = env.doc.add('textarea')
  env.settle()
  assert.equal(env.universal.records.has(second), true, '新出现的输入框要自动接上')

  second.remove()
  env.settle()
  assert.equal(env.universal.records.has(second), false, '被移除的输入框要摘掉角标')
  assert.equal(second.childNodes.length, 0)
})

await test('卸载：角标、覆盖层、观察器、监听器、计时器全部回收', async () => {
  const env = setup({ streaming: true })
  const host = env.doc.add('textarea')
  host.value = '原文'
  env.settle()
  clickBadge(env, host)
  await flush()
  const root = env.doc.querySelector(`[${universalApi.rootAttr}]`)
  const observer = env.doc.mutationObservers.at(-1)

  env.universal.uninstall()

  assert.equal(env.universal.isDisposed(), true)
  assert.equal(env.universal.records.size, 0)
  assert.equal(root.parentElement, null, '覆盖层要从页面上摘掉')
  assert.equal(observer.disconnected, true, '观察器要断开')
  assert.equal(env.win.listenerCount('scroll'), 0)
  assert.equal(env.win.listenerCount('resize'), 0)
  assert.equal(env.win.intervalCount(), 0)
  assert.equal(host.value, '原文', '卸载不写回任何东西')
})

await test('apply() 只在环境完整时挂通用角标：假 document（无 body）不抛错也不挂', () => {
  const installed = universalApi.create({
    t: key => key,
    win: { ...makeWindow(new FakeDocument()) },
    doc: { createElement: () => ({ dataset: {}, style: {} }), getElementById: () => null },
  })
  assert.equal(installed, null, 'DOM 不完整时返回 null（插件其余功能不受影响）')
})

if (failures.length > 0) {
  console.error(`通用输入角标：${String(failures.length)} 个用例失败`)
  for (const failure of failures) console.error(`- ${failure.label}\n  ${failure.stack ?? failure.error}`)
  process.exit(1)
}
console.log(`全部通过：${String(passed)} 个用例`)
