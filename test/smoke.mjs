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
 * 造一个假宿主 ctx：捕获注册的路由、伪造 LLM 流与设置服务。
 * @param {{ chunks?: object[], delayMs?: number, selection?: object, fail?: Error,
 *   settings?: false, settingsSection?: object, providers?: object[], models?: object[],
 *   modelsFail?: Error, resolveFail?: Error, resolveInfo?: object }} options - 替身参数。
 * @returns {{ ctx: object, routes: object[], calls: object[], settingsCalls: object[], settingsState: object }} ctx 与观测点。
 */
function fakeCtx(options = {}) {
  const routes = []
  const calls = []
  const settingsCalls = []
  const settingsState = { section: options.settingsSection }
  const settingsService = {
    register(namespace, schema, registerOptions) {
      settingsCalls.push({ namespace, schema, options: registerOptions })
      return {
        get: () => settingsState.section,
        replace: async (section) => { settingsState.section = section },
        update: async (patch) => { settingsState.section = { ...settingsState.section, ...patch } },
      }
    },
  }
  return {
    routes,
    calls,
    settingsCalls,
    settingsState,
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
        if (serviceName === 'settings') {
          // settings: false 模拟「部署没挂设置提供者」；默认与真实 web profile 一致（可用）。
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
            await new Promise(resolve => setTimeout(resolve, options.delayMs))
          }
          callOptions.signal?.throwIfAborted()
          if (options.fail !== undefined) throw options.fail
          for (const chunk of options.chunks ?? []) yield chunk
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
          return { name: `${provider}/${model}`, context: 128000, ...options.resolveInfo }
        },
      },
    },
  }
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
 * @returns {{ routes: object[], calls: object[], settingsCalls: object[], settingsState: object }} 观测点。
 */
function setup(config, options = {}) {
  const fake = fakeCtx(options)
  apply(fake.ctx, config)
  lastFake = fake
  boundRoute = fake.routes.find(route => route.path === ROUTE)
  return {
    routes: fake.routes,
    calls: fake.calls,
    settingsCalls: fake.settingsCalls,
    settingsState: fake.settingsState,
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
    [ROUTE_CATALOG, ROUTE_CATALOG_MODELS, ROUTE, ROUTE_CHECK].sort(),
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
  assert.equal(observations.routes.length, 4)
  const result = await drive(fakeRequest({ body: '{"text":"x"}' }))
  assert.equal(result.status, 200)
  assert.equal(result.json.text, '改写后的提示词。')
})

console.log('settings: 设置项驱动实际请求')
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
