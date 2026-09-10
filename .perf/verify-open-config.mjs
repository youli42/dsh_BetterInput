/**
 * 真机验收：驱动真实的 `open-config` 路由（会真的用编辑器打开插件配置文件）。
 *
 * 单测不能起进程，所以这条链路必须单独驱动一次：走的是与线上完全相同的
 * `apply()` → 路由处理器 → openerCandidates → spawn。
 *
 * 用法：node .perf/verify-open-config.mjs
 */

import { apply } from '../lib/index.js'

const routes = []
const logs = []

const loggerService = Object.assign(
  () => loggerService,
  {
    info: (format, ...params) => logs.push(`INFO ${String(format)} ${params.map(String).join(' ')}`),
    warn: (format, ...params) => logs.push(`WARN ${String(format)} ${params.map(String).join(' ')}`),
  },
)

const ctx = {
  effect: (factory) => { factory(); return () => {} },
  logger: loggerService,
  // 刻意**不提供** connection：走插件自己的环回围栏（线上本机浏览器之外的场景）。
  get: () => undefined,
  inject(deps, callback) {
    if (Array.isArray(deps) && deps.includes('settings')) {
      callback({
        settings: { register: () => ({ get: () => undefined }) },
        effect: (factory) => { factory(); return () => {} },
      })
    }
    return () => {}
  },
  webServer: {
    register(route) { routes.push(route); return () => {} },
  },
  llm: { listProviders: () => [] },
}

apply(ctx, {})

const route = routes.find(candidate => candidate.path === '/api/dsh-input-optimizer/open-config')
if (route === undefined) throw new Error('open-config 路由没有挂上')

/** 一个环回、同源的假请求（字段形状与 node IncomingMessage 一致）。 */
const request = {
  method: 'POST',
  url: '/api/dsh-input-optimizer/open-config',
  headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
  socket: { remoteAddress: '127.0.0.1' },
}

let body
let status = 0
const response = {
  writableEnded: false,
  setHeader() {},
  end(payload) { body = payload; response.writableEnded = true },
  get statusCode() { return status },
  set statusCode(value) { status = value },
}

await route.handler(request, response)
console.log(`status=${String(status)}`)
console.log(`body=${String(body)}`)

// 失败路径也验一次：不存在的文件必须给"找不到 + 绝对路径"，而不是静默。
console.log(`logs=${JSON.stringify(logs)}`)
