/**
 * better-input 冒烟测试：不起真实宿主，用测试替身驱动宿主半的路由处理器。
 *
 * 运行：node test/smoke.mjs
 * 依赖：@deepseek-ai/dsh-llm 需要可见（本地开发用 node_modules/@deepseek-ai/dsh-llm
 *       软链到 dsh 安装目录；安装进 profile 后天然可见）。
 */

import assert from 'node:assert/strict'

import {
  MAX_BODY_BYTES,
  ROUTE,
  ROUTE_CATALOG,
  ROUTE_CATALOG_MODELS,
  ROUTE_CHECK,
  ROUTE_STREAM,
  SETTINGS_NAMESPACE,
  effectiveConfig,
  isIPv4Loopback,
  isLoopbackAddress,
  isLoopbackRequest,
  resolveConfig,
  systemPromptFor,
  validateSettingsSection,
} from '../lib/policy.js'
import { apply, inject, name } from '../lib/index.js'

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

/**
 * 造一个假请求（async-iterable 的 JSON 体 + socket/headers + url）。
 * @param {{ method?: string, headers?: Record<string, string>, remoteAddress?: string, body?: string, url?: string }} options - 请求参数。
 * @returns {object} 请求替身。
 */
function fakeRequest(options = {}) {
  const payload = Buffer.from(options.body ?? '', 'utf8')
  return {
    method: options.method ?? 'POST',
    url: options.url ?? '/',
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', ...options.headers },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) yield payload
    },
  }
}

/**
 * 造一个假响应，记录状态码/头/体。
 * @returns {object} 响应替身。
 */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    /** 每次 `write()` 的内容，按顺序（SSE 用例靠它看"什么时候写了什么"）。 */
    writes: [],
    writableEnded: false,
    onClose: undefined,
    setHeader(key, value) {
      this.headers[key] = value
    },
    once(event, listener) {
      if (event === 'close') this.onClose = listener
    },
    off() {},
    write(chunk) {
      this.writes.push(String(chunk))
      return true
    },
    end(body) {
      if (body !== undefined) this.body = body
      this.writableEnded = true
      this.onClose?.()
    },
  }
}

/**
 * 把 SSE 的写出内容解析成事件序列。
 * @param {string[]} writes - `response.writes`。
 * @returns {Array<{ event: string, data: any }>} 事件（忽略以 `:` 开头的注释帧）。
 */
function parseSse(writes) {
  const events = []
  for (const frame of writes) {
    for (const block of frame.split('\n\n')) {
      const lines = block.split('\n').filter(line => line !== '')
      if (lines.length === 0) continue
      if (lines[0].startsWith(':')) continue
      const event = lines.find(line => line.startsWith('event: '))?.slice('event: '.length)
      const data = lines.find(line => line.startsWith('data: '))?.slice('data: '.length)
      if (event === undefined) continue
      events.push({ event, data: data === undefined ? undefined : JSON.parse(data) })
    }
  }
  return events
}

/**
 * 造一个假宿主 ctx：捕获注册的路由、伪造 LLM 流与设置服务。
 * @param {{ chunks?: object[], delayMs?: number, selection?: object, fail?: Error,
 *   settings?: false, settingsSection?: object, providers?: object[], models?: object[],
 *   modelsFail?: Error, resolveFail?: Error, resolveInfo?: object }} options - 替身参数。
 * @returns {{ ctx: object, routes: object[], calls: object[], settingsCalls: object[], settingsState: object }} ctx 与观测点。
 */
function fakeCtx(options = {}) {
  const routes = []
  const calls = []
  const logs = []
  const settingsCalls = []
  const settingsState = { section: options.settingsSection }
  /** 等 settings 服务出现的 inject 回调（真实语义：服务就绪时才执行，见 ctx.inject）。 */
  const waitingInjections = []
  const injectionDisposers = []
  const settingsService = {
    register(namespace, schema, registerOptions) {
      settingsCalls.push({ namespace, schema, options: registerOptions })
      // settings: 'reject' 模拟宿主侧拒绝注册（非法存量段 / 命名空间冲突）。
      if (options.settings === 'reject') throw new Error('settings: namespace conflict')
      return {
        get: () => settingsState.section,
        replace: async (section) => { settingsState.section = section },
        update: async (patch) => { settingsState.section = { ...settingsState.section, ...patch } },
      }
    },
  }
  /**
   * 真实 cordis 的 logger 门面：**可调用**（`ctx.logger(name)` 造具名 logger）且带 info/warn。
   * 这里只记录调用，替身不去做 %s 格式化。
   */
  const loggerService = Object.assign(
    () => loggerService,
    {
      info: (format, ...params) => { logs.push({ level: 'info', format, params }) },
      warn: (format, ...params) => { logs.push({ level: 'warn', format, params }) },
    },
  )
  /** 注入回调收到的子上下文（真实 cordis 里是个独立 fiber）。 */
  const injectionChild = () => ({
    settings: settingsService,
    effect(factory) {
      const disposer = factory()
      if (typeof disposer === 'function') injectionDisposers.push(disposer)
      return () => {}
    },
  })
  return {
    routes,
    calls,
    logs,
    settingsCalls,
    settingsState,
    /**
     * 模拟「settings 服务后到」：真实帧里 `ctx.inject(deps, cb)` 是等依赖就绪才跑 cb 的
     * （cordis 把它编译成一个子 fiber），替身必须照抄这一点，否则"一次性 ctx.get 永久降级"
     * 这类时序缺陷在冒烟测试里永远看不见。
     * @returns {number} 本次被唤醒的回调数。
     */
    deliverSettings() {
      const pending = waitingInjections.splice(0)
      for (const callback of pending) callback(injectionChild())
      return pending.length
    },
    /** 模拟 settings 服务被卸载：子 fiber 的 effect 清理函数应当全部执行。 */
    disposeSettingsChild() {
      const disposers = injectionDisposers.splice(0)
      for (const disposer of disposers) disposer()
      return disposers.length
    },
    ctx: {
      effect(factory) {
        factory()
        return () => {}
      },
      /** 真实的 `ctx.logger`：自有属性，可调用并带 info/warn。 */
      logger: loggerService,
      /**
       * `ctx.inject(deps, cb)`：仅在所需服务就绪时执行 cb（真实实现是 `ctx.plugin({inject, apply})`）。
       * settings: false 时回调**不执行**（部署没挂设置提供者）；默认与真实 web profile 一致（已就绪）。
       */
      inject(deps, callback) {
        if (Array.isArray(deps) && deps.includes('settings')) {
          if (options.settings === false) waitingInjections.push(callback)
          else callback(injectionChild())
        }
        return () => {}
      },
      get(serviceName) {
        // 真实 cordis 里 logger **不是** reflect 注册的服务，`ctx.get('logger')` 恒为 undefined。
        // 替身必须照抄这一点：否则"日志全部静默丢失"这类回归永远测不出来。
        if (serviceName === 'logger') return undefined
        if (serviceName === 'connection') return options.connection
        if (serviceName === 'agentDefaultModel') {
          return options.selection === undefined ? undefined : { currentSelection: () => options.selection }
        }
        if (serviceName === 'settings') {
          return options.settings === false ? undefined : settingsService
        }
        return undefined
      },
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
      llm: {
        async *stream(callOptions) {
          calls.push(callOptions)
          // 真实适配器契约要求「必须遵守 options.signal」，替身照做，超时用例才有意义。
          if (options.delayMs !== undefined) {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, options.delayMs)
              callOptions.signal?.addEventListener('abort', () => {
                clearTimeout(timer)
                reject(callOptions.signal.reason ?? new Error('aborted'))
              }, { once: true })
            })
          }
          callOptions.signal?.throwIfAborted()
          if (options.fail !== undefined) throw options.fail
          for (const [index, chunk] of (options.chunks ?? []).entries()) {
            // midDelayMs：在第 2 个 chunk 之前停一下——流式用例靠它证明"增量是边来边写的"，
            // 而不是等全部收完再一次性吐出（若是一次性，这段停顿时长内就不会有任何 write）。
            // 停顿同样必须遵守 signal（真实适配器契约），否则"客户端断开"用例测不出效果。
            if (index === 1 && options.midDelayMs !== undefined) {
              await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, options.midDelayMs)
                callOptions.signal?.addEventListener('abort', () => {
                  clearTimeout(timer)
                  reject(callOptions.signal.reason ?? new Error('aborted'))
                }, { once: true })
              })
            }
            yield chunk
          }
        },
        listProviders() {
          if (options.providersFail !== undefined) throw options.providersFail
          return options.providers ?? [
            { id: 'deepseek-official', name: 'DeepSeek' },
            { id: 'acme', name: 'Acme' },
          ]
        },
        async listModels(provider) {
          if (options.modelsFail !== undefined) throw options.modelsFail
          return (options.models ?? [
            { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
            { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
          ]).map(model => ({ ...model, provider }))
        },
        async resolveModelInfo(provider, model) {
          if (options.resolveFail !== undefined) throw options.resolveFail
          // 形状照抄 `LlmResolvedModelInfo`：`context` 是 `{ contextWindow }` 对象，不是数字。
          return { name: `${provider}/${model}`, context: { contextWindow: 128000 }, ...options.resolveInfo }
        },
      },
    },
  }
}

/** 让一条已开始的请求推进到"停在 stream 上"的状态（并发用例需要它制造重叠）。 */
const flush = async () => { await new Promise(resolve => setImmediate(resolve)) }

/**
 * 驱动**流式**路由：与 `drive` 的区别是结果不在 `end()` 的 body 里，而在 `write()` 序列里。
 * @param {object} response - fakeResponse（调用方持有，便于中途观察 writes）。
 * @param {object} request - 假请求。
 * @returns {Promise<void>} 处理器完成。
 */
async function driveStream(response, request) {
  const route = lastFake.routes.find(item => item.path === ROUTE_STREAM)
  assert.ok(route !== undefined, `route ${ROUTE_STREAM} was not registered`)
  await route.handler(request, response)
}

/** 最近一次 apply 注册的路由（由 setup 填充）。 */
let boundRoute

/**
 * 驱动最近注册的优化路由。
 * @param {object} request - 假请求。
 * @returns {Promise<{ status: number, json: any, response: object }>} 结果。
 */
async function drive(request) {
  assert.ok(boundRoute !== undefined, 'route was not registered')
  const response = fakeResponse()
  await boundRoute.handler(request, response)
  return {
    status: response.statusCode,
    response,
    json: typeof response.body === 'string' && response.body !== '' ? JSON.parse(response.body) : undefined,
  }
}

/** 最近一次 apply 的观测点。 */
let lastFake

/**
 * 按路径驱动一条已注册的路由。
 * @param {string} path - 路由路径。
 * @param {object} request - 假请求。
 * @returns {Promise<{ status: number, json: any, response: object }>} 结果。
 */
async function drivePath(path, request) {
  const route = lastFake.routes.find(item => item.path === path)
  assert.ok(route !== undefined, `route ${path} was not registered`)
  const response = fakeResponse()
  await route.handler(request, response)
  return {
    status: response.statusCode,
    response,
    json: typeof response.body === 'string' && response.body !== '' ? JSON.parse(response.body) : undefined,
  }
}

/**
 * 启动一次插件并返回观测点。
 * @param {unknown} config - 插件配置。
 * @param {object} options - 假宿主参数。
 * @returns {{ routes: object[], calls: object[], logs: object[], settingsCalls: object[],
 *   settingsState: object, deliverSettings: () => number, disposeSettingsChild: () => number }} 观测点。
 */
function setup(config, options = {}) {
  const fake = fakeCtx(options)
  apply(fake.ctx, config)
  lastFake = fake
  boundRoute = fake.routes.find(route => route.path === ROUTE)
  return {
    routes: fake.routes,
    calls: fake.calls,
    logs: fake.logs,
    settingsCalls: fake.settingsCalls,
    settingsState: fake.settingsState,
    deliverSettings: fake.deliverSettings,
    disposeSettingsChild: fake.disposeSettingsChild,
  }
}

/** 一段正常的文本流（delta-only，装配器容忍无 block-start/end）。 */
const TEXT_CHUNKS = [
  { type: 'text-delta', index: 0, text: '改写后的' },
  { type: 'text-delta', index: 0, text: '提示词。' },
  { type: 'finish', reason: { kind: 'stop' } },
]

console.log('policy: 环回判定')
await test('127/8、::1、IPv4-mapped 都算环回', () => {
  assert.equal(isIPv4Loopback('127.0.0.1'), true)
  assert.equal(isIPv4Loopback('127.255.0.1'), true)
  assert.equal(isIPv4Loopback('128.0.0.1'), false)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('10.0.0.7'), false)
  assert.equal(isLoopbackAddress(undefined), false)
})
await test('信任围栏同时要求环回 socket + 本机 Host + 同源标记', () => {
  assert.equal(isLoopbackRequest(fakeRequest()), true)
  assert.equal(isLoopbackRequest(fakeRequest({ remoteAddress: '192.168.1.10' })), false)
  assert.equal(isLoopbackRequest(fakeRequest({ headers: { host: 'evil.example.com' } })), false)
  assert.equal(isLoopbackRequest(fakeRequest({ headers: { 'sec-fetch-site': 'cross-site' } })), false)
  assert.equal(isLoopbackRequest(fakeRequest({ headers: { origin: 'http://evil.example.com' } })), false)
  assert.equal(isLoopbackRequest(fakeRequest({ headers: { origin: 'http://127.0.0.1:3080' } })), true)
})

console.log('policy: 配置校验')
await test('缺省值补齐，未知键与错类型 fail loud', () => {
  const resolved = resolveConfig(undefined)
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.maxInputChars, 8000)
  assert.equal(resolved.maxOutputTokens, 1024)
  assert.equal(resolved.timeoutMs, 30000)
  assert.deepEqual(resolved.presets, [])
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key "nope"/)
  assert.throws(() => resolveConfig({ timeoutMs: 0 }), /positive integer/)
  assert.throws(() => resolveConfig({ systemPrompt: '   ' }), /non-empty string/)
})
await test('组合层的数值区间同样 fail loud（不能只查设置层）', () => {
  // 区间只在设置层查过的后果：config.timeoutMs 超上界会让 AbortSignal.timeout 抛
  // ERR_OUT_OF_RANGE（实测上限 4294967295），于是**每次**请求都 502，用户只看到"优化失败"。
  assert.throws(() => resolveConfig({ timeoutMs: 5_000_000_000 }), /timeoutMs must be within 1000\.\.600000/)
  assert.throws(() => resolveConfig({ timeoutMs: 999 }), /timeoutMs must be within 1000\.\.600000/)
  assert.throws(() => resolveConfig({ maxOutputTokens: 1_000_000_000 }), /maxOutputTokens must be within 1\.\.200000/)
  // 边界值本身必须放行。
  assert.equal(resolveConfig({ timeoutMs: 1000 }).timeoutMs, 1000)
  assert.equal(resolveConfig({ timeoutMs: 600000 }).timeoutMs, 600000)
  assert.equal(resolveConfig({ maxOutputTokens: 200000 }).maxOutputTokens, 200000)
})
await test('model 路由必须成对出现', () => {
  assert.deepEqual(
    { provider: resolveConfig({ model: { provider: 'p', model: 'm' } }).provider },
    { provider: 'p' },
  )
  assert.throws(() => resolveConfig({ model: { provider: 'p' } }), /together/)
  assert.throws(() => resolveConfig({ model: 'p/m' }), /must be an object/)
})
await test('presets 去重与 id 校验', () => {
  const resolved = resolveConfig({ presets: [{ id: 'a', prompt: 'x' }, { id: 'b', label: 'B', prompt: 'y' }] })
  assert.equal(resolved.presets.length, 2)
  assert.equal(resolved.presets[1].label, 'B')
  assert.throws(() => resolveConfig({ presets: [{ id: 'a', prompt: 'x' }, { id: 'a', prompt: 'y' }] }), /duplicate/)
  assert.throws(() => resolveConfig({ presets: [{ id: 'a' }] }), /prompt must be a non-empty string/)
})
await test('systemPromptFor 追加预设，未知预设报 400', () => {
  const resolved = resolveConfig({ systemPrompt: 'BASE', presets: [{ id: 'spec', prompt: '条目化' }] })
  assert.equal(systemPromptFor(resolved, undefined), 'BASE')
  assert.equal(systemPromptFor(resolved, 'spec'), 'BASE\n\n本次额外要求：条目化')
  assert.throws(
    () => systemPromptFor(resolved, 'missing'),
    error => error.code === 'unknown-preset' && error.status === 400,
  )
})

console.log('host half: 路由注册与契约')
await test('插件契约：name/inject 与路由挂载点', () => {
  const { routes } = setup({})
  assert.equal(name, 'better-input')
  assert.deepEqual(inject, ['webServer', 'llm'])
  assert.deepEqual(
    routes.map(route => route.path).sort(),
    [ROUTE_CATALOG, ROUTE_CATALOG_MODELS, ROUTE, ROUTE_STREAM, ROUTE_CHECK].sort(),
  )
  for (const route of routes) {
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.handler, 'function')
  }
})
await test('enabled: false 时不挂路由', () => {
  const { routes } = setup({ enabled: false })
  assert.equal(routes.length, 0)
  boundRoute = { handler: async () => { throw new Error('route must not exist') } }
})
await test('日志必须真的落进 ctx.logger（ctx.get("logger") 恒为 undefined）', async () => {
  // 真实 cordis 里 logger 是 root context 的自有属性，不是 reflect 服务：写
  // `ctx.get('logger')` 得到 undefined，而代码里的可选链让失败完全静默——
  // 连 README 承诺的 mounted 行都打不出来。这里钉住"日志确实被记录"。
  const observations = setup({}, { chunks: TEXT_CHUNKS, selection: { provider: 'p', model: 'm' } })
  const mounted = observations.logs.find(entry => String(entry.format).includes('mounted'))
  assert.ok(mounted !== undefined, 'apply 必须打印 mounted 日志')
  assert.equal(mounted.level, 'info')
  // printf 风格：ROUTE 是参数而不是拼进格式串（否则消息里的 % 占位符会被吃掉）。
  assert.equal(mounted.format, 'better-input: mounted %s (+stream/catalog/check)')
  assert.equal(mounted.params[0], ROUTE)
  // 设置命名空间的注册结论也必须有一条明确日志（否则"设置服务不可用"根本无从排查）。
  const registered = observations.logs.find(entry => String(entry.format).includes('settings namespace'))
  assert.ok(registered !== undefined, '注册成功/失败都必须留下日志')
  assert.equal(registered.level, 'info')
  assert.equal(registered.params[0], SETTINGS_NAMESPACE)

  // 失败路径也要留下记录，且参数化传参。
  await drive(fakeRequest({ body: JSON.stringify({ text: 'x' }) }))
  const warn = observations.logs.find(entry => entry.level === 'warn')
  assert.equal(warn, undefined, '正常路径不该有告警')

  const broken = setup({}, { fail: new Error('boom %s'), selection: { provider: 'p', model: 'm' } })
  await drive(fakeRequest({ body: JSON.stringify({ text: 'x' }) }))
  const failure = broken.logs.find(entry => entry.level === 'warn')
  assert.equal(failure.format, 'better-input: %s: %s')
  assert.deepEqual(failure.params, ['model-failed', 'boom %s'], '消息必须作为参数传，不能被当格式串')
})

console.log('host half: 流式优化（SSE）')
await test('增量边来边写：先 delta 帧，最后 done 帧带权威文本', async () => {
  const observations = setup({}, {
    chunks: [
      { type: 'text-delta', index: 0, text: '改写后的' },
      { type: 'text-delta', index: 0, text: '提示词。' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    midDelayMs: 60,   // 第 2 个 chunk 之前停 60ms：这期间必须已经写出了第 1 个 delta
    selection: { provider: 'p', model: 'm' },
  })
  const response = fakeResponse()
  const handler = driveStream(response, fakeRequest({ body: '{"text":"x"}' }))

  // 处理器还没结束（卡在 midDelay），但第一个增量**已经写出**——这才叫流式。
  await flush()
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(parseSse(response.writes), [{ event: 'delta', data: { text: '改写后的' } }])
  assert.equal(response.writableEnded, false, '此时流还不能结束')

  await handler
  assert.deepEqual(parseSse(response.writes), [
    { event: 'delta', data: { text: '改写后的' } },
    { event: 'delta', data: { text: '提示词。' } },
    { event: 'done', data: { text: '改写后的提示词。', modelUsed: { provider: 'p', model: 'm' } } },
  ])
  assert.equal(response.writableEnded, true)
  assert.equal(observations.calls.length, 1, '只调用模型一次')
})
await test('max-tokens 截断：done 帧标注 truncated', async () => {
  setup({}, {
    chunks: [{ type: 'text-delta', index: 0, text: '半截' }, { type: 'finish', reason: { kind: 'max-tokens' } }],
    selection: { provider: 'p', model: 'm' },
  })
  const response = fakeResponse()
  await driveStream(response, fakeRequest({ body: '{"text":"x"}' }))
  const events = parseSse(response.writes)
  assert.deepEqual(events.at(-1), {
    event: 'done',
    data: { text: '半截', modelUsed: { provider: 'p', model: 'm' }, truncated: true },
  })
})
await test('模型失败 / 未知终态 / 空输出：开流后用 error 帧或 done 帧收尾', async () => {
  setup({}, { fail: new Error('provider exploded'), selection: { provider: 'p', model: 'm' } })
  const failed = fakeResponse()
  await driveStream(failed, fakeRequest({ body: '{"text":"x"}' }))
  assert.deepEqual(parseSse(failed.writes), [
    { event: 'error', data: { error: 'model-failed', message: 'provider exploded' } },
  ])
  assert.equal(failed.writableEnded, true, 'error 之后必须收尾')

  // 未知终态与 JSON 路由语义一致：已拿到的文本仍可用，只记告警。
  const unknown = setup({}, {
    chunks: [{ type: 'text-delta', index: 0, text: '照样可用' }, { type: 'finish', reason: { kind: 'content-filter' } }],
    selection: { provider: 'p', model: 'm' },
  })
  const filtered = fakeResponse()
  await driveStream(filtered, fakeRequest({ body: '{"text":"x"}' }))
  assert.deepEqual(parseSse(filtered.writes), [
    { event: 'delta', data: { text: '照样可用' } },
    { event: 'done', data: { text: '照样可用', modelUsed: { provider: 'p', model: 'm' } } },
  ])
  assert.equal(unknown.logs.some(entry => String(entry.format).includes('unknown finish reason')), true)

  const empty = setup({}, { chunks: [{ type: 'finish', reason: { kind: 'stop' } }], selection: { provider: 'p', model: 'm' } })
  const blank = fakeResponse()
  await driveStream(blank, fakeRequest({ body: '{"text":"x"}' }))
  assert.equal(parseSse(blank.writes).at(-1).event, 'error')
  assert.equal(parseSse(blank.writes).at(-1).data.error, 'model-failed')
  assert.equal(empty.calls.length, 1)
})
await test('准入失败（还没开流）仍走 HTTP 状态码：空草稿 400 / 超长 400 / 闸门 409', async () => {
  setup({ maxInputChars: 5 }, { chunks: TEXT_CHUNKS, selection: { provider: 'p', model: 'm' } })
  const blank = fakeResponse()
  await driveStream(blank, fakeRequest({ body: '{"text":"  "}' }))
  assert.equal(blank.statusCode, 400, '开流之前失败必须用状态码，客户端好按既有文案处理')
  assert.equal(blank.headers['content-type'], 'application/json; charset=utf-8')

  const tooLong = fakeResponse()
  await driveStream(tooLong, fakeRequest({ body: '{"text":"123456"}' }))
  assert.equal(tooLong.statusCode, 400)
  assert.equal(JSON.parse(tooLong.body).error, 'text-too-long')

  // 同会话并发：第二条必须 409（流式路由与 JSON 路由共用同一个闸门）。
  const first = setup({}, { chunks: TEXT_CHUNKS, delayMs: 40, selection: { provider: 'p', model: 'm' } })
  const held = fakeResponse()
  const running = driveStream(held, fakeRequest({ body: '{"text":"a","sessionId":"s1"}' }))
  await flush()
  const conflict = fakeResponse()
  await driveStream(conflict, fakeRequest({ body: '{"text":"b","sessionId":"s1"}' }))
  assert.equal(conflict.statusCode, 409)
  assert.equal(JSON.parse(conflict.body).error, 'busy-session')
  await running
  assert.equal(first.calls.length, 1)
})
await test('信任判定同样生效：401 / 403 在开流之前就挡住', async () => {
  const unauthorized = setup({}, {
    chunks: TEXT_CHUNKS,
    selection: { provider: 'p', model: 'm' },
    connection: { requestRejection: () => 401 },
  })
  const noSession = fakeResponse()
  await driveStream(noSession, fakeRequest({ body: '{"text":"x"}' }))
  assert.equal(noSession.statusCode, 401)
  assert.equal(JSON.parse(noSession.body).error, 'unauthorized')
  assert.equal(unauthorized.calls.length, 0)

  setup({}, { chunks: TEXT_CHUNKS, selection: { provider: 'p', model: 'm' } })
  const alien = fakeResponse()
  await driveStream(alien, fakeRequest({ remoteAddress: '10.1.2.3', body: '{"text":"x"}' }))
  assert.equal(alien.statusCode, 403)
})
await test('超时：开流后发 error 帧（timeout）并收尾', async () => {
  const observations = setup({ timeoutMs: 1000 }, {
    chunks: TEXT_CHUNKS,
    delayMs: 60000,
    selection: { provider: 'p', model: 'm' },
  })
  const response = fakeResponse()
  await driveStream(response, fakeRequest({ body: '{"text":"x"}' }))
  const last = parseSse(response.writes).at(-1)
  assert.equal(last.event, 'error')
  assert.equal(last.data.error, 'timeout')
  assert.equal(response.writableEnded, true)
  assert.equal(observations.logs.some(entry => String(entry.params?.[0] ?? '').includes('timed out')), true)
})
await test('客户端中途断开：不写事件、不抛错，闸门照常释放', async () => {
  setup({}, {
    chunks: [
      { type: 'text-delta', index: 0, text: '第一段' },
      { type: 'text-delta', index: 1, text: '第二段' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    midDelayMs: 40,
    selection: { provider: 'p', model: 'm' },
  })
  const response = fakeResponse()
  const running = driveStream(response, fakeRequest({ body: '{"text":"x","sessionId":"s9"}' }))
  await flush()
  response.onClose?.()          // 模拟客户端断开：host 侧的 close 事件
  await running                 // 不得抛出
  const events = parseSse(response.writes)
  assert.deepEqual(events, [{ event: 'delta', data: { text: '第一段' } }], '断开后不再写事件')

  // 名额已归还：同一会话可以立刻再来一次。
  setup({}, { chunks: TEXT_CHUNKS, selection: { provider: 'p', model: 'm' } })
  const retry = fakeResponse()
  await driveStream(retry, fakeRequest({ body: '{"text":"x","sessionId":"s9"}' }))
  assert.equal(parseSse(retry.writes).at(-1).event, 'done')
})

console.log('host half: 请求处理')
await test('200：把草稿交给模型并回传优化文本', async () => {
  const observations = setup({}, { chunks: TEXT_CHUNKS, selection: { provider: 'agent-provider', model: 'agent-model' } })
  const result = await drive(fakeRequest({ body: JSON.stringify({ text: '帮我写个脚本' }) }))
  assert.equal(result.status, 200)
  assert.equal(result.json.text, '改写后的提示词。')
  assert.deepEqual(result.json.modelUsed, { provider: 'agent-provider', model: 'agent-model' })
  // 草稿被 JSON 框架包裹，且模型路由来自宿主的默认选择
  const userText = observations.calls[0].messages[0].content[0].text
  assert.equal(userText.includes('{"draft":"帮我写个脚本"}'), true)
  assert.equal(observations.calls[0].system.includes('提示词工程师'), true)
  assert.equal(observations.calls[0].maxTokens, 1024)
})
await test('配置里的 model 覆盖默认选择', async () => {
  const observations = setup({ model: { provider: 'cfg-p', model: 'cfg-m' } }, { chunks: TEXT_CHUNKS, selection: { provider: 'a', model: 'b' } })
  const result = await drive(fakeRequest({ body: JSON.stringify({ text: 'x' }) }))
  assert.equal(result.status, 200)
  assert.deepEqual(result.json.modelUsed, { provider: 'cfg-p', model: 'cfg-m' })
  assert.equal(observations.calls[0].provider, 'cfg-p')
})
await test('presetId 追加到 system，未知预设 400', async () => {
  const observations = setup({ systemPrompt: 'BASE', presets: [{ id: 'spec', prompt: '条目化' }] }, { chunks: TEXT_CHUNKS, selection: { provider: 'p', model: 'm' } })
  const ok = await drive(fakeRequest({ body: JSON.stringify({ text: 'x', presetId: 'spec' }) }))
  assert.equal(ok.status, 200)
  assert.equal(ok.json.presetId, 'spec')
  assert.equal(observations.calls[0].system, 'BASE\n\n本次额外要求：条目化')
  const bad = await drive(fakeRequest({ body: JSON.stringify({ text: 'x', presetId: 'nope' }) }))
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error, 'unknown-preset')
})
await test('max-tokens 截断仍返回文本并标注 truncated', async () => {
  setup({}, { chunks: [{ type: 'text-delta', index: 0, text: '半截结果' }, { type: 'finish', reason: { kind: 'max-tokens' } }], selection: { provider: 'p', model: 'm' } })
  const result = await drive(fakeRequest({ body: JSON.stringify({ text: 'x' }) }))
  assert.equal(result.status, 200)
  assert.equal(result.json.text, '半截结果')
  assert.equal(result.json.truncated, true)
})
await test('未知 finish kind 不再整条失败（FinishReason 是可合并扩展的）', async () => {
  // dsh-llm 的 FinishReasonMap 明确写着 "Merge-extensible so adapters can surface
  // provider-specific reasons"，官方指引是 fall through unknowns。旧代码对未知 kind 抛错，
  // 适配器/后续版本新增一个 reason 就会让**每一次**优化 502。
  const observations = setup({}, {
    chunks: [{ type: 'text-delta', index: 0, text: '照样可用' }, { type: 'finish', reason: { kind: 'content-filter' } }],
    selection: { provider: 'p', model: 'm' },
  })
  const result = await drive(fakeRequest({ body: JSON.stringify({ text: 'x' }) }))
  assert.equal(result.status, 200)
  assert.equal(result.json.text, '照样可用')
  assert.equal(result.json.truncated, undefined)
  const warn = observations.logs.find(entry => String(entry.format).includes('unknown finish reason'))
  assert.ok(warn !== undefined, '未知终态必须留下一条告警')
  assert.equal(warn.params[0], 'content-filter')
})
await test('error / aborted 终态仍是失败，并把 failure 带出来', async () => {
  const aborted = setup({}, {
    chunks: [{ type: 'finish', reason: { kind: 'aborted', failure: { message: '上游取消', code: 'aborted' } } }],
    selection: { provider: 'p', model: 'm' },
  })
  const result = await drive(fakeRequest({ body: JSON.stringify({ text: 'x' }) }))
  assert.equal(result.status, 502)
  assert.equal(result.json.error, 'model-failed')
  assert.equal(result.json.message, '上游取消')
  assert.equal(aborted.calls.length, 1)
})
await test('403：非环回来源 / 异源 Host / 跨站标记', async () => {
  setup({}, { chunks: TEXT_CHUNKS, selection: { provider: 'p', model: 'm' } })
  for (const request of [
    fakeRequest({ remoteAddress: '10.1.2.3', body: '{"text":"x"}' }),
    fakeRequest({ headers: { host: 'lan-host:3080' }, body: '{"text":"x"}' }),
    fakeRequest({ headers: { 'sec-fetch-site': 'cross-site' }, body: '{"text":"x"}' }),
  ]) {
    const result = await drive(request)
    assert.equal(result.status, 403, `expected 403 for ${JSON.stringify(request.headers)}`)
    assert.equal(result.json.error, 'forbidden')
  }
})
await test('信任判定优先交给框架的 connection.requestRejection（403/401/放行）', async () => {
  const base = { chunks: TEXT_CHUNKS, selection: { provider: 'p', model: 'm' } }

  // 1) 框架放行（浏览器带会话 cookie）→ 正常出结果。
  const allowed = setup({}, { ...base, connection: { requestRejection: () => undefined } })
  assert.equal((await drive(fakeRequest({ body: '{"text":"x"}' }))).status, 200)
  assert.equal(allowed.calls.length, 1)

  // 2) 框架 403（DNS rebinding / 异源 Host）→ 原样拒绝，且**不调用模型**。
  const rebinding = setup({}, { ...base, connection: { requestRejection: () => 403 } })
  const forbidden = await drive(fakeRequest({ body: '{"text":"x"}' }))
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.json.error, 'forbidden')
  assert.equal(rebinding.calls.length, 0, '被围栏拒绝时绝不能触达模型')

  // 3) 框架 401（围栏过了但缺浏览器会话）→ 能力路由必须挡住，并给出可操作提示。
  const noSession = setup({}, { ...base, connection: { requestRejection: () => 401 } })
  const unauthorized = await drive(fakeRequest({ body: '{"text":"x"}' }))
  assert.equal(unauthorized.status, 401)
  assert.equal(unauthorized.json.error, 'unauthorized')
  assert.equal(unauthorized.json.message.includes('浏览器会话'), true)
  assert.equal(noSession.calls.length, 0, '没有会话就不得花凭据')

  // 4) 元数据路由（/catalog、/check）在**环回**客户端上免会话：保留 CLI 可排查性。
  const metadata = setup({}, { ...base, connection: { requestRejection: () => 401 } })
  const catalog = await drivePath(ROUTE_CATALOG, fakeRequest({ method: 'GET' }))
  assert.equal(catalog.status, 200, '本机 curl 仍应能读目录（不花凭据）')
  assert.equal((await drivePath(ROUTE_CHECK, fakeRequest({ method: 'POST', body: '{"provider":"p","model":"m"}' }))).status, 200)

  // 5) 但**非环回**客户端即便只是读元数据也要被拒（LAN 客户端必须带会话）。
  const lan = await drivePath(ROUTE_CATALOG, fakeRequest({ method: 'GET', remoteAddress: '10.1.2.3' }))
  assert.equal(lan.status, 403)
  assert.equal(metadata.routes.length, 5)
})
await test('connection 判定抛错时回落旧围栏（不是放行）', async () => {
  const observations = setup({}, {
    chunks: TEXT_CHUNKS,
    selection: { provider: 'p', model: 'm' },
    connection: {
      requestRejection() { throw new Error('connection exploded') },
    },
  })
  assert.equal((await drive(fakeRequest({ body: '{"text":"x"}' }))).status, 200, '环回客户端照常')
  assert.equal((await drive(fakeRequest({ remoteAddress: '10.1.2.3', body: '{"text":"x"}' }))).status, 403, '非环回仍拒')
  const warn = observations.logs.find(entry => String(entry.format).includes('requestRejection failed'))
  assert.ok(warn !== undefined, '回落必须留日志（否则安全策略悄悄降级没人知道）')
})
await test('并发闸门：同会话单航班 409、全局上限 429、结束后释放', async () => {
  const observations = setup({ maxConcurrentCalls: 2 }, {
    chunks: TEXT_CHUNKS,
    delayMs: 40,
    selection: { provider: 'p', model: 'm' },
  })

  // 第一条占住 s1（不 await，让它停在 stream 上）。
  const first = drive(fakeRequest({ body: '{"text":"a","sessionId":"s1"}' }))
  await flush()
  const sameSession = await drive(fakeRequest({ body: '{"text":"b","sessionId":"s1"}' }))
  assert.equal(sameSession.status, 409, '同一会话不允许并发')
  assert.equal(sameSession.json.error, 'busy-session')
  assert.equal(sameSession.json.message.includes('已经在优化中'), true)

  // 换个会话占满第 2 个名额，再来第三条就被全局上限挡住。
  const second = drive(fakeRequest({ body: '{"text":"c","sessionId":"s2"}' }))
  await flush()
  const saturated = await drive(fakeRequest({ body: '{"text":"d","sessionId":"s3"}' }))
  assert.equal(saturated.status, 429)
  assert.equal(saturated.json.error, 'too-many-requests')
  assert.equal(saturated.json.message.includes('2'), true, '提示里要带上限值')

  const settled = await Promise.all([first, second])
  assert.deepEqual(settled.map(item => item.status), [200, 200])
  assert.equal(observations.calls.length, 2, '被拒的请求绝不能触达模型（不花钱）')

  // 名额必须被释放：否则几次取消/失败之后整个插件就"锁死"了。
  const after = await drive(fakeRequest({ body: '{"text":"e","sessionId":"s1"}' }))
  assert.equal(after.status, 200, '请求结束后名额必须归还')
  assert.equal(observations.calls.length, 3)
})
await test('失败/超时路径也要释放名额', async () => {
  const failing = setup({}, { fail: new Error('provider exploded'), selection: { provider: 'p', model: 'm' } })
  assert.equal((await drive(fakeRequest({ body: '{"text":"x","sessionId":"s1"}' }))).status, 502)
  assert.equal((await drive(fakeRequest({ body: '{"text":"x","sessionId":"s1"}' }))).status, 502, '模型失败后名额要归还（否则 409）')
  assert.equal(failing.calls.length, 2)
})
await test('maxConcurrentCalls 取值域校验与默认值', () => {
  assert.equal(resolveConfig(undefined).maxConcurrentCalls, 4)
  assert.equal(resolveConfig({ maxConcurrentCalls: 1 }).maxConcurrentCalls, 1)
  assert.equal(resolveConfig({ maxConcurrentCalls: 64 }).maxConcurrentCalls, 64)
  assert.throws(() => resolveConfig({ maxConcurrentCalls: 0 }), /positive integer/)
  assert.throws(() => resolveConfig({ maxConcurrentCalls: 65 }), /maxConcurrentCalls must be within 1\.\.64/)
})
await test('405 非 POST；400 空草稿/超长/坏 JSON；413 超大体积', async () => {
  setup({ maxInputChars: 5 }, { chunks: TEXT_CHUNKS, selection: { provider: 'p', model: 'm' } })
  assert.equal((await drive(fakeRequest({ method: 'GET' }))).status, 405)
  assert.equal((await drive(fakeRequest({ body: '{}' }))).status, 400)
  assert.equal((await drive(fakeRequest({ body: '{"text":"   "}' }))).status, 400)
  assert.equal((await drive(fakeRequest({ body: '{"text":"123456"}' }))).json.error, 'text-too-long')
  assert.equal((await drive(fakeRequest({ body: 'not json' }))).json.error, 'bad-request')
  assert.equal((await drive(fakeRequest({ body: JSON.stringify({ text: 'x'.repeat(300 * 1024) }) }))).status, 413)
})
await test('502：没有模型路由 / 模型侧失败 / 空输出', async () => {
  setup({}, { chunks: TEXT_CHUNKS })
  assert.equal((await drive(fakeRequest({ body: '{"text":"x"}' }))).json.error, 'no-model-route')

  setup({}, { fail: new Error('provider exploded'), selection: { provider: 'p', model: 'm' } })
  const failed = await drive(fakeRequest({ body: '{"text":"x"}' }))
  assert.equal(failed.status, 502)
  assert.equal(failed.json.message, 'provider exploded')

  setup({}, { chunks: [{ type: 'finish', reason: { kind: 'stop' } }], selection: { provider: 'p', model: 'm' } })
  assert.equal((await drive(fakeRequest({ body: '{"text":"x"}' }))).status, 502)
})
await test('504：超过 timeoutMs', async () => {
  // 超时下界现在是 1000ms（组合层与设置层同值），所以这条用例至少要等 1 秒。
  // 替身的流会遵守 abort：超时一到就抛，不必真等 60 秒。
  setup({ timeoutMs: 1000 }, { chunks: TEXT_CHUNKS, delayMs: 60000, selection: { provider: 'p', model: 'm' } })
  const result = await drive(fakeRequest({ body: '{"text":"x"}' }))
  assert.equal(result.status, 504)
  assert.equal(result.json.error, 'timeout')
})

console.log('settings: 生效配置（纯函数）')
await test('未配置时与加设置页之前完全一致', () => {
  const bare = resolveConfig(undefined)
  const effective = effectiveConfig(bare, undefined)
  assert.equal(effective.systemPrompt.includes('提示词工程师'), true)
  assert.equal(effective.provider, undefined)
  assert.equal(effective.model, undefined)
  assert.equal(effective.temperature, undefined)
  assert.equal(effective.maxOutputTokens, 1024)
  assert.equal(effective.timeoutMs, 30000)
  assert.deepEqual(effective.sources, { prompt: 'default', model: 'none', temperature: 'default', limits: 'default' })
})
await test('优先级：内置默认 ← 组合配置 ← 用户设置', () => {
  const config = resolveConfig({
    systemPrompt: 'CFG',
    model: { provider: 'cfg-p', model: 'cfg-m' },
    temperature: 0.7,
    maxOutputTokens: 777,
  })
  const fromConfig = effectiveConfig(config, {})
  assert.equal(fromConfig.systemPrompt, 'CFG')
  assert.deepEqual([fromConfig.provider, fromConfig.model], ['cfg-p', 'cfg-m'])
  assert.equal(fromConfig.temperature, 0.7)
  assert.equal(fromConfig.maxOutputTokens, 777)
  assert.deepEqual(fromConfig.sources, { prompt: 'config', model: 'config', temperature: 'config', limits: 'config' })

  const fromSettings = effectiveConfig(config, {
    customPromptEnabled: true,
    systemPrompt: 'SET',
    modelProvider: 'set-p',
    modelId: 'set-m',
    temperature: 0.1,
    maxOutputTokens: 55,
    timeoutMs: 9000,
  })
  assert.equal(fromSettings.systemPrompt, 'SET')
  assert.deepEqual([fromSettings.provider, fromSettings.model], ['set-p', 'set-m'])
  assert.equal(fromSettings.temperature, 0.1)
  assert.equal(fromSettings.maxOutputTokens, 55)
  assert.equal(fromSettings.timeoutMs, 9000)
  assert.deepEqual(fromSettings.sources, { prompt: 'settings', model: 'settings', temperature: 'settings', limits: 'settings' })
})
await test('开关关闭 / 只有一半模型字段时回落到组合配置', () => {
  const config = resolveConfig({ systemPrompt: 'CFG', model: { provider: 'cfg-p', model: 'cfg-m' } })
  const promptOff = effectiveConfig(config, { customPromptEnabled: false, systemPrompt: '忽略我' })
  assert.equal(promptOff.systemPrompt, 'CFG')
  const halfModel = effectiveConfig(config, { modelProvider: 'only-provider' })
  assert.deepEqual([halfModel.provider, halfModel.model], ['cfg-p', 'cfg-m'])
  assert.equal(halfModel.sources.model, 'config')
})
await test('跨字段校验规则矩阵（宿主与客户端共用结论）', () => {
  assert.deepEqual(validateSettingsSection({}), [])
  assert.deepEqual(validateSettingsSection({ customPromptEnabled: false, systemPrompt: '' }), [])
  assert.equal(validateSettingsSection({ customPromptEnabled: true }).length, 1)
  assert.equal(validateSettingsSection({ customPromptEnabled: true, systemPrompt: '   ' }).length, 1)
  assert.equal(validateSettingsSection({ modelProvider: 'p' }).length, 1)
  assert.equal(validateSettingsSection({ modelId: 'm' }).length, 1)
  assert.deepEqual(validateSettingsSection({ modelProvider: 'p', modelId: 'm' }), [])
  assert.equal(validateSettingsSection({ temperature: 3 }).length, 1)
  assert.equal(validateSettingsSection({ temperature: 'hot' }).length, 1)
  assert.equal(validateSettingsSection({ maxOutputTokens: 0 }).length, 1)
  assert.equal(validateSettingsSection({ timeoutMs: 10 }).length, 1)
  assert.equal(validateSettingsSection({ systemPrompt: 5 }).length, 1)
})

console.log('settings: 命名空间注册')
await test('注册 better-input 命名空间，applies=live，validate 拒绝非法组合', () => {
  const { settingsCalls } = setup({})
  assert.equal(settingsCalls.length, 1)
  assert.equal(settingsCalls[0].namespace, SETTINGS_NAMESPACE)
  assert.equal(settingsCalls[0].options.applies, 'live')
  assert.equal(typeof settingsCalls[0].options.validate, 'function')
  assert.doesNotThrow(() => settingsCalls[0].options.validate({ customPromptEnabled: false }))
  assert.throws(
    () => settingsCalls[0].options.validate({ customPromptEnabled: true, systemPrompt: '' }),
    /提示词/,
  )
})
await test('部署没挂设置提供者时：不报错、不注册、路由照挂', async () => {
  const observations = setup({}, { settings: false, chunks: TEXT_CHUNKS, selection: { provider: 'p', model: 'm' } })
  assert.equal(observations.settingsCalls.length, 0)
  assert.equal(observations.routes.length, 5)
  const result = await drive(fakeRequest({ body: '{"text":"x"}' }))
  assert.equal(result.status, 200)
  assert.equal(result.json.text, '改写后的提示词。')
  // 目录路由必须如实汇报"不可用"。
  const catalog = await drivePath(ROUTE_CATALOG, fakeRequest({ method: 'GET' }))
  assert.equal(catalog.json.settings.available, false)
})
await test('settings 服务晚到：注册必须补上（本轮真机事故的单元级回归）', async () => {
  // 真实链路：插件只 inject webServer/llm，可能先于设置提供者激活；而 SettingsProvider 的
  // [Service.init] 要 await 读盘，`ctx.get('settings')` 在它 ACTIVE 前恒为 undefined。
  // 旧代码在 apply 里读一次 → 永久降级（真机表现就是"设置服务不可用，重启也没用"）。
  const observations = setup({}, { settings: false, chunks: TEXT_CHUNKS, selection: { provider: 'p', model: 'm' } })
  assert.equal(observations.settingsCalls.length, 0, '此刻服务还没到')

  assert.equal(observations.deliverSettings(), 1, '服务就绪时必须唤醒注册回调')
  assert.equal(observations.settingsCalls.length, 1, '命名空间必须被注册')
  assert.equal(observations.settingsCalls[0].namespace, SETTINGS_NAMESPACE)

  const catalog = await drivePath(ROUTE_CATALOG, fakeRequest({ method: 'GET' }))
  assert.equal(catalog.json.settings.available, true, '注册后目录路由必须变为可用')
  assert.equal(catalog.json.settings.reason, undefined)
})
await test('注册失败时把宿主侧原因带给客户端，而不是只显示笼统的不可用', async () => {
  // 用一个"注册即抛"的设置服务模拟非法存量段/命名空间冲突这类宿主侧拒绝。
  const observations = setup({}, { settings: 'reject', chunks: TEXT_CHUNKS, selection: { provider: 'p', model: 'm' } })
  assert.equal(observations.settingsCalls.length, 1, '确实尝试过注册')
  const catalog = await drivePath(ROUTE_CATALOG, fakeRequest({ method: 'GET' }))
  assert.equal(catalog.json.settings.available, false)
  assert.equal(catalog.json.settings.reason, 'settings: namespace conflict')
  const warn = observations.logs.find(entry => entry.level === 'warn')
  assert.ok(warn !== undefined, '注册失败必须留日志')
})
await test('settings 服务消失后回到降级态（注册是子 fiber 上的 effect）', async () => {
  const observations = setup({}, { chunks: TEXT_CHUNKS, selection: { provider: 'p', model: 'm' } })
  assert.equal((await drivePath(ROUTE_CATALOG, fakeRequest({ method: 'GET' }))).json.settings.available, true)
  assert.equal(observations.disposeSettingsChild(), 1, '服务卸载时要执行清理')
  const after = await drivePath(ROUTE_CATALOG, fakeRequest({ method: 'GET' }))
  assert.equal(after.json.settings.available, false, '服务没了就必须如实降级')
  // 降级后优化链路不受影响（回落到组合配置 + 宿主默认模型）。
  const optimized = await drive(fakeRequest({ body: '{"text":"x"}' }))
  assert.equal(optimized.status, 200)
})

console.log('settings: 设置项驱动实际请求')
await test('catalog 下发客户端需要的规则与预设（单一事实来源）', async () => {
  const config = {
    maxInputChars: 1234,
    presets: [
      { id: 'concise', label: '精简', prompt: '压缩篇幅' },
      { id: 'spec', prompt: '转规格' },          // 没写 label 时回落到 id
    ],
  }
  setup(config, { chunks: TEXT_CHUNKS, selection: { provider: 'p', model: 'm' } })
  const catalog = await drivePath(ROUTE_CATALOG, fakeRequest({ method: 'GET' }))

  // 区间：客户端不再自己维护镜像，校验/输入框 min 都以这里为准。
  assert.equal(catalog.json.limits.maxInputChars, 1234)
  assert.deepEqual(catalog.json.limits.temperature, { min: 0, max: 2 })
  assert.deepEqual(catalog.json.limits.maxOutputTokens, { min: 1, max: 200000 })
  assert.deepEqual(catalog.json.limits.timeoutMs, { min: 1000, max: 600000 })

  // 预设：只给 id/label —— prompt 留在宿主，客户端不需要也不该看到它。
  assert.deepEqual(catalog.json.presets, [
    { id: 'concise', label: '精简' },
    { id: 'spec', label: 'spec' },
  ])
  assert.equal(JSON.stringify(catalog.json).includes('压缩篇幅'), false, 'prompt 绝不能下发')
})
await test('保存后的模型/提示词/参数就是后续请求用的那套', async () => {
  const observations = setup({}, {
    chunks: TEXT_CHUNKS,
    selection: { provider: 'agent-p', model: 'agent-m' },
    settingsSection: {
      customPromptEnabled: true,
      systemPrompt: '自定义提示词',
      modelProvider: 'set-p',
      modelId: 'set-m',
      temperature: 0.25,
      maxOutputTokens: 321,
      timeoutMs: 7000,
    },
  })
  const result = await drive(fakeRequest({ body: JSON.stringify({ text: '草稿' }) }))
  assert.equal(result.status, 200)
  assert.deepEqual(result.json.modelUsed, { provider: 'set-p', model: 'set-m' })
  const call = observations.calls[0]
  assert.equal(call.provider, 'set-p')
  assert.equal(call.model, 'set-m')
  assert.equal(call.system, '自定义提示词')
  assert.equal(call.temperature, 0.25)
  assert.equal(call.maxTokens, 321)
})
await test('设置是每次请求现读：改完立刻生效，无需重启', async () => {
  // 设置里没写模型 → 用宿主的默认选择（这一步本身也是「未配置模型时不报错」的体现）。
  const observations = setup({}, {
    chunks: TEXT_CHUNKS,
    selection: { provider: 'agent-p', model: 'agent-m' },
    settingsSection: { customPromptEnabled: true, systemPrompt: '第一版' },
  })
  await drive(fakeRequest({ body: '{"text":"x"}' }))
  assert.equal(observations.calls[0].system, '第一版')
  assert.equal(observations.calls[0].provider, 'agent-p')
  observations.settingsState.section = { customPromptEnabled: true, systemPrompt: '第二版' }
  await drive(fakeRequest({ body: '{"text":"x"}' }))
  assert.equal(observations.calls[1].system, '第二版')
})

console.log('settings: 目录与试调路由')
await test('catalog：provider 目录 + 当前生效配置 + 来源标注', async () => {
  setup({}, { settingsSection: { customPromptEnabled: true, systemPrompt: '自定义', modelProvider: 'set-p', modelId: 'set-m' } })
  const result = await drivePath(ROUTE_CATALOG, fakeRequest({ method: 'GET' }))
  assert.equal(result.status, 200)
  assert.equal(result.json.namespace, SETTINGS_NAMESPACE)
  assert.equal(result.json.settings.available, true)
  assert.equal(result.json.settings.section.systemPrompt, '自定义')
  assert.deepEqual(result.json.providers, [
    { id: 'deepseek-official', name: 'DeepSeek' },
    { id: 'acme', name: 'Acme' },
  ])
  assert.equal(result.json.effective.provider, 'set-p')
  assert.equal(result.json.effective.model, 'set-m')
  assert.equal(result.json.effective.sources.model, 'settings')
  assert.equal(result.json.effective.sources.prompt, 'settings')
})
await test('catalog：目录读取失败不致命，退化成空列表', async () => {
  setup({}, { providersFail: new Error('registry down') })
  const result = await drivePath(ROUTE_CATALOG, fakeRequest({ method: 'GET' }))
  assert.equal(result.status, 200)
  assert.deepEqual(result.json.providers, [])
})
await test('catalog/models：按 provider 拉列表；缺参数 400', async () => {
  setup({})
  const listed = await drivePath(ROUTE_CATALOG_MODELS, fakeRequest({ method: 'GET', url: '/x?provider=deepseek-official' }))
  assert.equal(listed.status, 200)
  assert.equal(listed.json.provider, 'deepseek-official')
  assert.equal(listed.json.models.length, 2)
  assert.equal(listed.json.models[0].id, 'deepseek-v4-flash')

  const missing = await drivePath(ROUTE_CATALOG_MODELS, fakeRequest({ method: 'GET', url: '/x' }))
  assert.equal(missing.status, 400)
  assert.equal(missing.json.error, 'missing-provider')

  setup({}, { modelsFail: new Error('catalog offline') })
  const failed = await drivePath(ROUTE_CATALOG_MODELS, fakeRequest({ method: 'GET', url: '/x?provider=acme' }))
  assert.equal(failed.status, 502)
  assert.equal(failed.json.message, 'catalog offline')
})
await test('check：能解析就 ok，解析不了把原因带回来；缺字段 400', async () => {
  setup({})
  const okResult = await drivePath(ROUTE_CHECK, fakeRequest({ body: '{"provider":"acme","model":"m"}' }))
  assert.equal(okResult.status, 200)
  assert.equal(okResult.json.ok, true)
  assert.equal(okResult.json.context, 128000)

  setup({}, { resolveFail: new Error('unknown model') })
  const bad = await drivePath(ROUTE_CHECK, fakeRequest({ body: '{"provider":"acme","model":"nope"}' }))
  assert.equal(bad.status, 200)
  assert.equal(bad.json.ok, false)
  assert.equal(bad.json.message, 'unknown model')

  setup({})
  const missing = await drivePath(ROUTE_CHECK, fakeRequest({ body: '{"provider":"acme"}' }))
  assert.equal(missing.status, 400)
  assert.equal(missing.json.error, 'missing-model')
})
await test('只读路由同样走信任围栏与体积上限', async () => {
  setup({})
  const forbidden = await drivePath(ROUTE_CATALOG, fakeRequest({ method: 'GET', remoteAddress: '10.0.0.9' }))
  assert.equal(forbidden.status, 403)
  const wrongMethod = await drivePath(ROUTE_CATALOG, fakeRequest({ method: 'POST' }))
  assert.equal(wrongMethod.status, 405)
  const huge = await drivePath(ROUTE_CHECK, fakeRequest({ body: JSON.stringify({ provider: 'a', model: 'x'.repeat(MAX_BODY_BYTES) }) }))
  assert.equal(huge.status, 413)
})

console.log('')
if (failures.length > 0) {
  console.error(`${String(failures.length)} 个用例失败，${String(passed)} 个通过`)
  for (const { label, error } of failures) console.error(`- ${label}: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
}
console.log(`全部通过：${String(passed)} 个用例`)
