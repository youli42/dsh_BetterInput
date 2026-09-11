/**
 * 集成测试：宿主半的「设置命名空间注册」必须发生在 **settings 服务就绪之后**。
 *
 * 为什么必须用真实 cordis + 真实 dsh-settings-file 跑：
 *
 *   缺陷完全来自框架的服务激活时序——
 *     · `SettingsProvider` 用 `super(ctx, 'settings')` 提供 `settings` 服务（dsh-settings），
 *       它的 `async *[Service.init]()` 里要 `await this.load()`（读 settings.yaml）**之后**
 *       服务才 publish/injectable；
 *     · `ctx.get(name)` 走 `ctx.reflect.get(name, strict = true)`，对"已提供但 fiber 尚未
 *       ACTIVE"的服务返回 `undefined`（cordis 的 `_getImpl`）。
 *   于是"在 `apply()` 里一次性 `ctx.get('settings')`"会在竞态落败时**永久**降级：
 *   命名空间永不注册 → 客户端设置页显示"设置服务不可用"。
 *
 *   冒烟测试用的是假 ctx，`get('settings')` 永远即时返回，造不出这个时序——所以这一条
 *   必须用真框架跑（真实服务 + 真实提供者 + 真实 schema 校验/持久化）。
 *
 * 运行：node test/settings-activation.mjs （`npm test` 会跑）
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import SettingsFile from '@deepseek-ai/dsh-settings-file'

import * as plugin from '../lib/index.js'
import { ROUTE, ROUTE_CATALOG, ROUTE_OPEN_CONFIG, ROUTE_STREAM, SETTINGS_NAMESPACE } from '../lib/policy.js'

/**
 * 临时目录：**优先放仓库内**（`test/.tmp/`，已 gitignore）。
 *
 * 为什么不直接用 `os.tmpdir()`：受限环境（只读沙箱、某些 CI）会拒写系统临时区，
 * `mkdtemp` 抛 EPERM——那会让这条用例看起来像"回归"，而实际只是环境不允许写盘。
 * 两个位置都不可写时按 SKIP 处理并说明原因（产品代码与运行实例不受影响）。
 * @returns {string | undefined} 可写的父目录，或 undefined（不可写）。
 */
function writableParent() {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '.tmp'),
    join(tmpdir(), 'dsh-better-input'),
  ]
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true })
      mkdtempSync(join(candidate, 'probe-'))
      rmSync(candidate, { recursive: true, force: true })
      mkdirSync(candidate, { recursive: true })
      return candidate
    } catch {
      // 这个位置不可写，试下一个（两个都不行就返回 undefined → 整条套件 SKIP）。
    }
  }
  return undefined
}

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

/** 让 cordis 的异步激活/排空跑完（服务激活跨越多个微任务与定时器）。 */
const settle = async (ms = 60) => { await new Promise(resolve => setTimeout(resolve, ms)) }

/** 临时目录父路径；undefined = 当前环境不可写（整条套件按 SKIP 处理）。 */
const TMP_PARENT = writableParent()

/**
 * 起一个最小宿主上下文。
 *
 * `webServer`/`llm` 用替身（只为让插件通过 `inject` 门，路由注册被捕获下来），
 * settings 提供者则按需挂**真实的** `dsh-settings-file`（写到临时文档，不碰用户配置）。
 * @param {{ settings?: 'before' | 'after' | 'never', config?: object }} options - 提供者挂载时机与插件组合配置。
 * @returns {Promise<{ ctx: object, routes: object[], calls: object[], documentPath: string,
 *   dispose: () => Promise<void> }>} 句柄（`calls` 是每次 LLM 调用的入参，用来核对 system prompt）。
 */
async function boot(options = {}) {
  const parent = TMP_PARENT
  if (parent === undefined) throw new Error('SKIP: 当前环境既不能写 test/.tmp 也不能写系统临时目录')
  const dir = mkdtempSync(join(parent, 'settings-'))
  const documentPath = join(dir, 'settings.yaml')
  const ctx = new Context()
  const routes = []
  const calls = []

  ctx.plugin({
    name: 'host-stub-services',
    apply(stub) {
      stub.provide('webServer', {
        register(route) {
          routes.push(route)
          return () => {
            const at = routes.indexOf(route)
            if (at >= 0) routes.splice(at, 1)
          }
        },
      })
      stub.provide('llm', {
        // 记下每次调用的入参（system prompt 是"逐风格提示词是否真的生效"的唯一判据），
        // 并回一段最小可用的文本流，让 /optimize 能走到 200。
        stream: async function* stream(callOptions) {
          calls.push(callOptions)
          yield { type: 'text-delta', index: 0, text: '改写后的' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
        listProviders: () => [],
        listModels: async () => [],
        resolveModelInfo: async (provider, model) => ({ provider, model, name: model }),
      })
    },
  })
  await settle(10)

  const mountSettings = async () => {
    ctx.plugin(SettingsFile, { path: documentPath, watch: false })
    await settle(30)
  }
  if (options.settings === 'before') await mountSettings()

  // 宿主半：与真实组合一样，行里只 inject webServer/llm。
  ctx.plugin(plugin, options.config)
  await settle(30)

  if (options.settings === 'after') await mountSettings()

  return {
    ctx,
    routes,
    calls,
    documentPath,
    dispose: async () => {
      await ctx.stop?.()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * 用假请求驱动一条已注册的路由。
 * @param {object[]} routes - 已注册路由。
 * @param {string} path - 路由路径。
 * @param {'GET' | 'POST'} method - 方法。
 * @param {object} [body] - JSON 体。
 * @returns {Promise<{ status: number, json: any }>} 结果。
 */
async function drive(routes, path, method, body) {
  const route = routes.find(candidate => candidate.path === path)
  assert.ok(route !== undefined, `route ${path} 未注册（宿主半没挂载？）`)
  const payload = body === undefined ? '' : JSON.stringify(body)
  const request = {
    method,
    url: path,
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  }
  let captured
  const response = {
    statusCode: 0,
    writableEnded: false,
    setHeader() {},
    once() {},
    off() {},
    end(text) {
      captured = text
      this.writableEnded = true
    },
  }
  await route.handler(request, response)
  return {
    status: response.statusCode,
    json: typeof captured === 'string' && captured !== '' ? JSON.parse(captured) : undefined,
  }
}

console.log('integration: 设置命名空间的注册时机（真实 cordis + 真实 settings 提供者）')

if (TMP_PARENT === undefined) {
  console.log('SKIP  当前环境既不能写 test/.tmp 也不能写系统临时目录（只读沙箱/受限 CI）——不是回归')
  process.exit(0)
}

await test('提供者在插件激活**之前**就绪 → 命名空间已注册（回归保护）', async () => {
  const host = await boot({ settings: 'before' })
  try {
    const catalog = await drive(host.routes, ROUTE_CATALOG, 'GET')
    assert.equal(catalog.status, 200)
    assert.equal(catalog.json.settings.available, true, '提供者已在，必须注册成功')
    assert.equal(catalog.json.namespace, SETTINGS_NAMESPACE)
    // 真实服务上确实能读到这个命名空间（不是我们自己的假象）。
    assert.notEqual(host.ctx.settings.get(SETTINGS_NAMESPACE), undefined)
  } finally {
    await host.dispose()
  }
})

await test('提供者**晚于**插件激活就绪 → 命名空间仍须注册（本轮缺陷的回归测试）', async () => {
  const host = await boot({ settings: 'after' })
  try {
    const catalog = await drive(host.routes, ROUTE_CATALOG, 'GET')
    assert.equal(catalog.status, 200, '无论设置可否，目录路由都必须可用')
    assert.equal(
      catalog.json.settings.available,
      true,
      'settings 服务后到也必须注册命名空间（一次性 ctx.get 的写法会在这里永久失败）',
    )
    assert.notEqual(host.ctx.settings.get(SETTINGS_NAMESPACE), undefined)

    // 端到端：注册之后，用户层写入必须真的落盘并可读回（"配置可正常保存"）。
    await host.ctx.settings.update(SETTINGS_NAMESPACE, { systemPrompt: '集成测试写进去的', customPromptEnabled: true })
    await settle(30)
    const stored = readFileSync(host.documentPath, 'utf8')
    assert.equal(stored.includes('集成测试写进去的'), true, '设置文档里必须出现写入的字段')
    assert.equal(host.ctx.settings.get(SETTINGS_NAMESPACE).systemPrompt, '集成测试写进去的')

    const after = await drive(host.routes, ROUTE_CATALOG, 'GET')
    assert.equal(after.json.settings.section.systemPrompt, '集成测试写进去的', '目录路由必须反映用户层')
    assert.equal(after.json.effective.sources.prompt, 'settings', '生效配置必须来自用户层')
  } finally {
    await host.dispose()
  }
})

await test('逐风格提示词：保存 → 生效来源变 settings → 下一次请求的 system 真的用它（真框架全链路）', async () => {
  const host = await boot({
    settings: 'after',
    // 固定模型路由，否则 /optimize 会先以 502 no-model-route 结束，走不到 LLM。
    config: { systemPrompt: 'BASE', model: { provider: 'p', model: 'm' } },
  })
  try {
    // 保存之前：风格提示词来自内置默认。
    const before = await drive(host.routes, ROUTE_CATALOG, 'GET')
    const specBefore = before.json.styles.find(style => style.id === 'spec')
    assert.equal(specBefore.source, 'default', '没配过时来源必须是内置默认')

    // 走真实 settings 服务的写入通道（这正是客户端 mutate 落到的同一层），然后落盘。
    await host.ctx.settings.update(SETTINGS_NAMESPACE, { stylePromptSpec: '条目化：背景/目标/约束/验收' })
    await settle(30)
    assert.equal(
      readFileSync(host.documentPath, 'utf8').includes('条目化：背景/目标/约束/验收'),
      true,
      '逐风格提示词必须真的落进设置文档',
    )

    // 生效来源变了，而且只影响被覆盖的那一个风格。
    const after = await drive(host.routes, ROUTE_CATALOG, 'GET')
    assert.deepEqual(
      after.json.styles.map(style => [style.id, style.source]),
      [['concise', 'default'], ['spec', 'settings']],
      '只有 spec 被覆盖，concise 仍回落到内置默认',
    )
    assert.equal(after.json.settings.section.stylePromptSpec, '条目化：背景/目标/约束/验收')

    // 关键一步：下一次请求真的用了新提示词。
    const optimized = await drive(host.routes, ROUTE, 'POST', { text: '写个脚本', styleIds: ['spec'] })
    assert.equal(optimized.status, 200)
    assert.deepEqual(optimized.json.styleIds, ['spec'])
    assert.equal(
      host.calls[host.calls.length - 1].system,
      'BASE\n\n本次额外要求（转规格）：条目化：背景/目标/约束/验收',
      '保存后的逐风格提示词必须出现在下一次调用的 system 里',
    )

    // 勾了风格但没勾那个风格时，它的提示词不该出现（多选是"按勾选拼"而不是"全都拼"）。
    await drive(host.routes, ROUTE, 'POST', { text: '写个脚本', styleIds: ['concise'] })
    const conciseSystem = host.calls[host.calls.length - 1].system
    assert.equal(conciseSystem.includes('条目化：背景/目标/约束/验收'), false)
    assert.equal(conciseSystem.startsWith('BASE\n\n本次额外要求（精简）：'), true)
  } finally {
    await host.dispose()
  }
})

await test('追加提示词：保存 → catalog 可见 → 切换后下一次请求的 system 真的换（真框架全链路）', async () => {
  const host = await boot({
    settings: 'after',
    // 固定模型路由，否则 /optimize 会先以 502 no-model-route 结束，走不到 LLM。
    config: { systemPrompt: 'BASE', model: { provider: 'p', model: 'm' } },
  })
  try {
    // 走真实 settings 服务的写入通道（与客户端 mutate 落到的同一层）：两条追加提示词，启用其中之一。
    await host.ctx.settings.update(SETTINGS_NAMESPACE, {
      promptProfiles: [
        { id: 'weekly', name: '周报模式', prompt: '你是周报写手' },
        { id: 'todo', name: '待办模式', prompt: '你是待办助手' },
      ],
      activeProfileId: 'weekly',
    })
    await settle(30)
    assert.equal(
      readFileSync(host.documentPath, 'utf8').includes('你是周报写手'),
      true,
      '追加提示词列表（含正文）必须真的落进设置文档',
    )

    // catalog 必须如实反映：内置种子在前，用户条目在后（行只含 id/名称/来源/是否内置）。
    const catalog = await drive(host.routes, ROUTE_CATALOG, 'GET')
    assert.deepEqual(catalog.json.profiles, [
      { id: 'concise', name: '精简', source: 'default', builtIn: true },
      { id: 'spec', name: '转规格', source: 'default', builtIn: true },
      { id: 'weekly', name: '周报模式', source: 'settings', builtIn: false },
      { id: 'todo', name: '待办模式', source: 'settings', builtIn: false },
    ])
    assert.equal(catalog.json.effective.profileId, 'weekly')
    // 基底来源如实标注：追加提示词不改系统提示词，所以这里仍是组合配置。
    assert.equal(catalog.json.effective.sources.prompt, 'config')
    // 清单行绝不带正文（正文是用户自己的设置值，走设置镜像，不走这份清单）。
    assert.equal(catalog.json.profiles.some(profile => 'prompt' in profile), false)

    // 关键一步：下一次请求的系统提示词 = 基底 + 启用中的那条追加（只增不改）。
    const optimized = await drive(host.routes, ROUTE, 'POST', { text: '写个脚本' })
    assert.equal(optimized.status, 200)
    assert.equal(host.calls[host.calls.length - 1].system, 'BASE\n\n本次额外要求（周报模式）：你是周报写手')

    // 切换追加提示词 = 改一个字段（输入框旁 ▾ 菜单落盘的正是这条 op），下一次请求即换。
    await host.ctx.settings.mutate(SETTINGS_NAMESPACE, [{ op: 'set', path: ['activeProfileId'], value: 'todo' }])
    await settle(30)
    await drive(host.routes, ROUTE, 'POST', { text: '写个脚本' })
    assert.equal(host.calls[host.calls.length - 1].system, 'BASE\n\n本次额外要求（待办模式）：你是待办助手')

    // 切到**内置追加提示词**（没有存储条目也合法）：system = 组合层 BASE + 内置追加要求，与旧多选逐字节一致。
    await host.ctx.settings.mutate(SETTINGS_NAMESPACE, [{ op: 'set', path: ['activeProfileId'], value: 'concise' }])
    await settle(30)
    await drive(host.routes, ROUTE, 'POST', { text: '写个脚本' })
    assert.equal(
      host.calls[host.calls.length - 1].system,
      'BASE\n\n本次额外要求（精简）：在保留全部约束的前提下压缩篇幅，去掉客套与重复表述。',
    )
    const builtinCatalog = await drive(host.routes, ROUTE_CATALOG, 'GET')
    assert.equal(builtinCatalog.json.effective.profileId, 'concise')
    assert.equal(builtinCatalog.json.profiles.find(profile => profile.id === 'concise').source, 'default')

    // 切回默认（unset）：回落到组合配置的 BASE。
    await host.ctx.settings.mutate(SETTINGS_NAMESPACE, [{ op: 'unset', path: ['activeProfileId'] }])
    await settle(30)
    await drive(host.routes, ROUTE, 'POST', { text: '写个脚本' })
    assert.equal(host.calls[host.calls.length - 1].system, 'BASE')
    const after = await drive(host.routes, ROUTE_CATALOG, 'GET')
    assert.equal(after.json.effective.profileId, null)
    assert.equal(after.json.effective.sources.prompt, 'config')
  } finally {
    await host.dispose()
  }
})

await test('完全没有设置提供者 → 插件照常挂载，只是 settings.available=false', async () => {
  const host = await boot({ settings: 'never' })
  try {
    assert.deepEqual(
      host.routes.map(route => route.path).sort(),
      [
        ROUTE,
        ROUTE_STREAM,
        ROUTE_CATALOG,
        `${ROUTE_CATALOG}/models`,
        '/api/dsh-input-optimizer/check',
        ROUTE_OPEN_CONFIG,
      ].sort(),
      '不能因为等 settings 就整个不激活（部署可能没有设置提供者）',
    )
    const catalog = await drive(host.routes, ROUTE_CATALOG, 'GET')
    assert.equal(catalog.status, 200)
    assert.equal(catalog.json.settings.available, false)
    // 优化路由也必须照常工作（回落到组合配置 + 宿主当前默认模型）。
    const optimize = await drive(host.routes, ROUTE, 'POST', { text: '写个脚本' })
    assert.equal(optimize.status, 502, '没有模型路由 → 502 no-model-route（而不是插件整体失效）')
    assert.equal(optimize.json.error, 'no-model-route')
  } finally {
    await host.dispose()
  }
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
