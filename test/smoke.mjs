/**
 * better-input 冒烟测试：不起真实宿主，用测试替身驱动宿主半的路由处理器。
 *
 * 运行：node test/smoke.mjs
 * 依赖：@deepseek-ai/dsh-llm 需要可见（本地开发用 node_modules/@deepseek-ai/dsh-llm
 *       软链到 dsh 安装目录；安装进 profile 后天然可见）。
 */

import assert from 'node:assert/strict'

import {
  ROUTE,
  isIPv4Loopback,
  isLoopbackAddress,
  isLoopbackRequest,
  resolveConfig,
  systemPromptFor,
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
 * 造一个假请求（async-iterable 的 JSON 体 + socket/headers）。
 * @param {{ method?: string, headers?: Record<string, string>, remoteAddress?: string, body?: string }} options - 请求参数。
 * @returns {object} 请求替身。
 */
function fakeRequest(options = {}) {
  const payload = Buffer.from(options.body ?? '', 'utf8')
  return {
    method: options.method ?? 'POST',
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
    writableEnded: false,
    onClose: undefined,
    setHeader(key, value) {
      this.headers[key] = value
    },
    once(event, listener) {
      if (event === 'close') this.onClose = listener
    },
    off() {},
    end(body) {
      this.body = body
      this.writableEnded = true
      this.onClose?.()
    },
  }
}

/**
 * 造一个假宿主 ctx：捕获注册的路由、伪造 LLM 流。
 * @param {{ chunks?: object[], delayMs?: number, selection?: object, fail?: Error }} options - 替身参数。
 * @returns {{ ctx: object, routes: object[], calls: object[] }} ctx 与观测点。
 */
function fakeCtx(options = {}) {
  const routes = []
  const calls = []
  return {
    routes,
    calls,
    ctx: {
      effect(factory) {
        factory()
        return () => {}
      },
      get(serviceName) {
        if (serviceName === 'logger') return { info() {}, warn() {} }
        if (serviceName === 'agentDefaultModel') {
          return options.selection === undefined ? undefined : { currentSelection: () => options.selection }
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
            await new Promise(resolve => setTimeout(resolve, options.delayMs))
          }
          callOptions.signal?.throwIfAborted()
          if (options.fail !== undefined) throw options.fail
          for (const chunk of options.chunks ?? []) yield chunk
        },
      },
    },
  }
}

/** 最近一次 apply 注册的路由（由 setup 填充）。 */
let boundRoute

/**
 * 驱动最近注册的路由。
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

/**
 * 启动一次插件并返回观测点。
 * @param {unknown} config - 插件配置。
 * @param {object} llmOptions - 假 LLM 参数。
 * @returns {{ routes: object[], calls: object[] }} 观测点。
 */
function setup(config, llmOptions = {}) {
  const fake = fakeCtx(llmOptions)
  apply(fake.ctx, config)
  boundRoute = fake.routes[0]
  return { routes: fake.routes, calls: fake.calls }
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
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, ROUTE)
  assert.equal(typeof routes[0].handler, 'function')
})
await test('enabled: false 时不挂路由', () => {
  const { routes } = setup({ enabled: false })
  assert.equal(routes.length, 0)
  boundRoute = { handler: async () => { throw new Error('route must not exist') } }
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
  setup({ timeoutMs: 20 }, { chunks: TEXT_CHUNKS, delayMs: 200, selection: { provider: 'p', model: 'm' } })
  const result = await drive(fakeRequest({ body: '{"text":"x"}' }))
  assert.equal(result.status, 504)
  assert.equal(result.json.error, 'timeout')
})

console.log('')
if (failures.length > 0) {
  console.error(`${String(failures.length)} 个用例失败，${String(passed)} 个通过`)
  for (const { label, error } of failures) console.error(`- ${label}: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
}
console.log(`全部通过：${String(passed)} 个用例`)
