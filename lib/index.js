/**
 * better-input —— 宿主半（Node）。
 *
 * 两份职责：
 *   1. 能力路由：`POST /optimize` 用宿主里已注册的 LLM 服务做一次性辅助调用；
 *   2. 设置页的支撑路由：`GET /catalog`（provider 目录 + 当前生效配置）、
 *      `GET /catalog/models`（某 provider 的模型列表）、`POST /check`（试调一条模型路由）。
 *
 * 配置的**读写不在这条路由上**：它走 dsh 标准设置通道
 * （宿主 `ctx.settings.register` / 客户端 `ctx.settingsScope`，见 lib/settings.js），
 * 所以持久化、校验、版本栅栏都由框架保证。这里只负责「按生效配置去调模型」。
 *
 * 为什么走 HTTP 而不是 Typert remote：remote 需要仓库内的 codegen 构建管线，
 * 第三方插件无法参与；HTTP 路由是社区插件的既有成熟路径（同 dsh 的 api-gateway
 * 一样直接注册在 ctx.webServer 上）。代价是必须自己做信任围栏。
 *
 * @module dsh-better-input
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

import {
  MAX_BODY_BYTES,
  MAX_OUTPUT_TOKENS_RANGE,
  PLUGIN_CONFIG_FILENAME,
  ROUTE,
  ROUTE_CATALOG,
  ROUTE_CATALOG_MODELS,
  ROUTE_CHECK,
  ROUTE_OPEN_CONFIG,
  ROUTE_STREAM,
  SETTINGS_NAMESPACE,
  TEMPERATURE_RANGE,
  TIMEOUT_RANGE,
  RequestError,
  effectiveConfig,
  isLoopbackAddress,
  isLoopbackRequest,
  frameUserPayload,
  openerCandidates,
  parseStyleIds,
  readJsonObject,
  resolveConfig,
  sendJson,
  systemPromptFor,
} from './policy.js'
import { bindSettings } from './settings.js'

/** 稳定 cordis 插件名。 */
export const name = 'better-input'

/** 需要就绪的服务：路由宿主与 LLM 运行时。（设置服务是可选依赖，走 ctx.get。） */
export const inject = ['webServer', 'llm']

/** 路由路径（浏览器半镜像同一组字面量）。 */
export { ROUTE, ROUTE_STREAM, ROUTE_CATALOG, ROUTE_CATALOG_MODELS, ROUTE_CHECK, ROUTE_OPEN_CONFIG }

/**
 * 取日志器。
 *
 * **不要写 `ctx.get('logger')`**：logger 不是注册进 reflect 的服务，而是 root context 的
 * 自有属性（cordis 的 `Context.logger: LoggerService`），`ctx.get('logger')` 恒为
 * `undefined`——实测 `typeof ctx.logger.warn === 'function'` 而 `ctx.get('logger') === undefined`。
 * 用错法子的后果不是报错而是**静默**：所有宿主日志与告警一条都打不出来。
 *
 * 参数按 printf 风格传：cordis 的 logger 会对第一个字符串做 `%s`/`%d` 替换，把拼好的整串
 * 当格式串会让模型返回的 message 里出现的占位符被吃成 `undefined`。
 * @param {object} ctx - 宿主上下文。
 * @returns {{ info: (format: string, ...params: unknown[]) => void,
 *   warn: (format: string, ...params: unknown[]) => void }} 日志门面。
 */
function logger(ctx) {
  const service = /** @type {{ info?: Function, warn?: Function } | undefined} */ (ctx.logger)
  return {
    info: (format, ...params) => service?.info?.(format, ...params),
    warn: (format, ...params) => service?.warn?.(format, ...params),
  }
}

/**
 * 解析本次调用使用的模型路由：生效配置优先，其次宿主的默认/当前选择。
 * @param {object} ctx - 宿主上下文。
 * @param {{ provider?: string, model?: string }} effective - 生效配置。
 * @returns {{ provider: string, model: string }} 路由。
 */
function resolveRoute(ctx, effective) {
  if (effective.provider !== undefined && effective.model !== undefined) {
    return { provider: effective.provider, model: effective.model }
  }
  const selection = /** @type {{ currentSelection?: () => { provider?: unknown, model?: unknown } } | undefined} */ (
    ctx.get?.('agentDefaultModel')
  )?.currentSelection?.()
  if (typeof selection?.provider === 'string' && typeof selection.model === 'string') {
    return { provider: selection.provider, model: selection.model }
  }
  throw new RequestError(
    'no-model-route',
    502,
    '没有可用的模型路由：请在设置页选择模型，或在插件配置的 config.model 里指定 provider/model，或先在选择器里选一个模型',
  )
}

/**
 * 把 finish reason 翻译成一次调用的终态。
 *
 * 注意 `FinishReasonMap` 在 dsh-llm 里是**可合并扩展**的（`types.d.ts:90-114`：
 * "Merge-extensible so adapters can surface provider-specific reasons"，
 * 官方指引是 "switch on `kind` and **fall through unknowns**"），所以未知终态**不能**
 * 当成失败：适配器或后续版本新增一个 reason，插件就会整条 502。未知值按"已拿到的文本可用"
 * 处理，只让调用方记一条告警。
 * @param {object} finish - BlockAssembler 的 finish。
 * @returns {{ error?: Error, unknown?: unknown }} 失败原因，或未识别的终态 kind。
 */
function finishOutcome(finish) {
  switch (finish?.kind) {
    case 'stop':
    case 'max-tokens':
      return {}
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure?.message ?? '模型调用失败')
      error.code = finish.failure?.code
      return { error }
    }
    case 'tool-calls':
      return { error: new Error('模型意外发起了工具调用；优化输入不应带工具') }
    default:
      return { unknown: finish?.kind }
  }
}

/**
 * 一次性辅助 LLM 调用：与官方 dsh-session-title-llm 同构（stream + BlockAssembler + finish 校验）。
 * @param {object} ctx - 宿主上下文。
 * @param {{ maxOutputTokens: number }} limits - 生效的输出上限。
 * @param {{ provider: string, model: string, system: string, text: string, temperature?: number,
 *   sessionId?: string, signal: AbortSignal }} call - 本次调用参数。
 * @returns {Promise<{ text: string, truncated: boolean }>} 优化结果。
 */
async function optimizeText(ctx, limits, call) {
  const messages = [createUserMessage({
    content: [{ type: 'text', text: frameUserPayload(call.text) }],
    source: { kind: 'plugin', plugin: 'better-input' },
  })]
  const options = {
    provider: call.provider,
    model: call.model,
    messages,
    system: call.system,
    maxTokens: limits.maxOutputTokens,
    signal: call.signal,
    ...call.temperature === undefined ? {} : { temperature: call.temperature },
    ...call.sessionId === undefined ? {} : { sessionId: call.sessionId },
    // purpose 是封闭联合（'compaction' | 'session-title'），第三方插件无法新增取值，
    // 这里保持省略 = 普通请求语义。
  }
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const outcome = finishOutcome(assembler.finish)
  if (outcome.error !== undefined) throw outcome.error
  if (outcome.unknown !== undefined) {
    logger(ctx).warn(
      'better-input: unknown finish reason %s; returning the assembled text',
      String(outcome.unknown),
    )
  }
  const text = assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
  if (text === '') throw new Error('模型没有返回任何文本')
  // max-tokens 截断不是失败：把已拿到的结果交回去（撤销按钮兜底），并标注 truncated。
  return { text, truncated: assembler.finish?.kind === 'max-tokens' }
}

/**
 * 建一个「客户端断开就取消上游」的取消源。
 * @param {object} response - 响应对象。
 * @returns {{ signal: AbortSignal, dispose: () => void }} 取消信号与清理函数。
 */
function clientAbortSource(response) {
  const controller = new AbortController()
  const onClose = () => {
    if (!response.writableEnded) controller.abort(new Error('client disconnected'))
  }
  response.once('close', onClose)
  return { signal: controller.signal, dispose: () => { response.off?.('close', onClose) } }
}

/**
 * 统一的失败回复：请求级错误按自身状态码，其余按 502。
 * @param {object} ctx - 宿主上下文。
 * @param {object} response - 响应对象。
 * @param {unknown} error - 抛出的错误。
 * @param {string} code - 兜底错误码。
 * @returns {void}
 */
function replyFailure(ctx, response, error, code) {
  if (response.writableEnded) return
  if (error instanceof RequestError) {
    sendJson(response, error.status, { error: error.code, message: error.message })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  logger(ctx).warn('better-input: %s: %s', code, message)
  sendJson(response, 502, { error: code, message })
}

/**
 * 并发闸门：**同会话单航班 + 全局并发上限**。
 *
 * 为什么需要：前端 `running` 只挡"同一个按钮连点"，多标签页、或本机脚本仍能并发刷 `/optimize`，
 * 每一次都会真的调用模型（烧 token/额度）。这里做的是**快速失败**而不是排队：
 * 超限立刻回 409/429，行为可预测，也不会把队列堆在后面。
 *
 * 闸门由 `apply()` 创建（随 fiber 生命周期），所以插件被重载/卸载时状态自然归零。
 * @param {number} limit - 全局并发上限（> 0）。
 * @returns {{ acquire: (sessionId: string | undefined) => { release?: () => void, conflict?: true, saturated?: true },
 *   active: () => number }} 闸门。
 */
function createGate(limit) {
  /** @type {Set<string>} 正在调用中的会话。 */
  const inFlight = new Set()
  let active = 0
  return {
    active: () => active,
    /**
     * 占位：拿到 release 才能往下走；conflict/saturated 表示被拒。
     * @param {string | undefined} sessionId - 会话 id（没有就不做单航班判定）。
     * @returns {{ release?: () => void, conflict?: true, saturated?: true }} 结果。
     */
    acquire(sessionId) {
      if (sessionId !== undefined && inFlight.has(sessionId)) return { conflict: true }
      if (active >= limit) return { saturated: true }
      active += 1
      if (sessionId !== undefined) inFlight.add(sessionId)
      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          active -= 1
          if (sessionId !== undefined) inFlight.delete(sessionId)
        },
      }
    },
  }
}

/**
 * 请求的信任判定。
 *
 * 优先交给**框架自己的围栏**：`ctx.connection.requestRejection(request)` 返回
 * `403`（Host/Origin 围栏不过：DNS rebinding、异源 Host）、`401`（围栏过了但缺浏览器会话）
 * 或 `undefined`（放行）。这样本插件与框架的 `/api` 通道用同一套判定，顺带获得
 * `trustedHosts`/LAN 部署支持，也不必自己维护一份会漂移的环回判定。
 *
 * `connection` 不可用（老版本/精简部署）或它自己抛错时，回落本插件自己的环回围栏——这是
 * "退回旧策略"而不是"放行"。
 *
 * **401 的处置按路由分级**（凭据能不能被花掉）：
 *   · 能力路由（`/optimize`、`/check`）：必须有浏览器会话。凭据可能来自**环境变量**
 *     （`apiKeyEnv`），本机其它进程读不到它，却能借这条路由花掉——所以要按框架策略挡住。
 *   · 只读元数据路由（`/catalog`、`/catalog/models`）：环回客户端免会话（便于 CLI 排查，
 *     它们只暴露 provider/模型名与本插件配置，不花凭据），但**非环回一律拒绝**。
 * @param {object} ctx - 宿主上下文。
 * @param {object} request - node IncomingMessage（或测试替身）。
 * @param {{ session: boolean }} requirement - 该路由是否要求浏览器会话。
 * @returns {number | undefined} 需要拒绝时的 HTTP 状态码。
 */
function rejectionOf(ctx, request, requirement) {
  const connection = /** @type {{ requestRejection?: Function } | undefined} */ (ctx.get?.('connection'))
  if (connection !== undefined && typeof connection.requestRejection === 'function') {
    let rejected
    try {
      rejected = connection.requestRejection(request)
    } catch (error) {
      logger(ctx).warn(
        'better-input: connection.requestRejection failed (%s); falling back to the loopback fence',
        error instanceof Error ? error.message : String(error),
      )
      rejected = undefined
      if (!isLoopbackRequest(request)) return 403
      return undefined
    }
    if (rejected === undefined) return undefined
    if (rejected === 401 && requirement.session === false) {
      // 元数据路由：只放行本机客户端，LAN 客户端仍必须带会话。
      const socket = /** @type {{ remoteAddress?: string } | undefined} */ (request?.socket)
      return isLoopbackAddress(socket?.remoteAddress) ? undefined : 403
    }
    return rejected
  }
  return isLoopbackRequest(request) ? undefined : 403
}

/**
 * 把信任判定的状态码翻成可展示的错误。
 * @param {number} status - 403 或 401。
 * @returns {RequestError} 请求级错误。
 */
function rejectionError(status) {
  if (status === 401) {
    return new RequestError(
      'unauthorized',
      401,
      '需要浏览器会话：请在 GUI 页面里操作（页面自带的会话 cookie 会被自动带上）；'
        + '命令行调试请改用只读路由，或从浏览器复制 cookie 后带上',
    )
  }
  return new RequestError('forbidden', 403, '这条路由只服务本机浏览器（或已声明的可信主机）')
}

/**
 * 校验请求并解析本次调用的全部参数。
 *
 * JSON 路由与 SSE 路由共用这一段：两条路由的**准入条件必须完全一致**（方法、信任判定、
 * 体积/字数上限、并发闸门、生效配置、预设、模型路由），否则"流式那条更松"就会变成绕过口子。
 * @param {object} ctx - 宿主上下文。
 * @param {Readonly<object>} resolved - 组合配置。
 * @param {{ available: boolean, read: () => unknown }} settings - 设置门面。
 * @param {object} request - 请求对象。
 * @param {{ acquire: (sessionId: string | undefined) => object }} gate - 并发闸门。
 * @returns {Promise<{ text: string, presetId?: string, styleIds: string[], sessionId?: string,
 *   route: { provider: string, model: string }, limits: object, system: string, timeoutMs: number,
 *   slot: object }>} 调用参数（slot 需在 finally 释放）。
 */
async function prepareCall(ctx, resolved, settings, request, gate) {
  if (request.method !== 'POST') {
    throw new RequestError('method-not-allowed', 405, '只接受 POST')
  }
  const rejection = rejectionOf(ctx, request, { session: true })
  if (rejection !== undefined) throw rejectionError(rejection)
  const body = await readJsonObject(request, MAX_BODY_BYTES)
  const text = typeof body.text === 'string' ? body.text : ''
  if (text.trim() === '') {
    throw new RequestError('empty-text', 400, '草稿为空，没有可优化的内容')
  }
  if (text.length > resolved.maxInputChars) {
    throw new RequestError(
      'text-too-long',
      400,
      `草稿 ${String(text.length)} 字，超过上限 ${String(resolved.maxInputChars)} 字`,
    )
  }
  // 生效配置每次请求现读：设置页保存后无需重启，下一次优化即用新值。
  const effective = effectiveConfig(resolved, settings.available ? settings.read() : undefined)
  const presetId = typeof body.presetId === 'string' && body.presetId !== '' ? body.presetId : undefined
  const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
  // 多选优化风格：未知 id 在这里就以 400 拒掉（静默忽略会让用户以为风格生效了）。
  const styleIds = parseStyleIds(body.styleIds)
  // 按**风格清单顺序**取，而不是请求里的点击顺序：同一组选择无论怎么点出来，
  // 拼出的 system prompt 都逐字节相同，便于复现与对比。
  const styles = effective.styles.filter(style => styleIds.includes(style.id))
  // 下面两处都会抛（未知预设 400 / 没有模型路由 502），所以**必须**排在占位之前：
  // 闸门的名额是"已占用"就没人还的，占位后抛错会让该会话之后恒 409、累计满额后全局恒 429，
  // 只能靠重启宿主恢复。而"没配模型/还没选过默认模型"正是新装首用的常见状态。
  const system = systemPromptFor({ systemPrompt: effective.systemPrompt, presets: resolved.presets }, presetId, styles)
  const route = resolveRoute(ctx, effective)
  // 闸门放在所有校验之后、真正调用模型之前：被拒的请求不占位，也不会白花钱。
  const slot = gate.acquire(sessionId)
  if (slot.conflict === true) {
    throw new RequestError('busy-session', 409, '这个会话已经在优化中了，请等它结束或先在页面上取消')
  }
  if (slot.saturated === true) {
    throw new RequestError(
      'too-many-requests',
      429,
      `并发调用已达上限 ${String(resolved.maxConcurrentCalls)}，请稍后重试`,
    )
  }
  return {
    text,
    ...presetId === undefined ? {} : { presetId },
    styleIds,
    ...sessionId === undefined ? {} : { sessionId },
    limits: effective,
    system,
    route,
    timeoutMs: effective.timeoutMs,
    slot,
  }
}

/**
 * 构建优化路由处理器（一次性 JSON）。
 * @param {object} ctx - 宿主上下文。
 * @param {Readonly<object>} resolved - 已校验的插件组合配置。
 * @param {{ available: boolean, read: () => unknown }} settings - 设置门面。
 * @param {{ acquire: (sessionId: string | undefined) => object }} gate - 并发闸门。
 * @returns {(request: object, response: object) => Promise<void>} 处理器。
 */
function createOptimizeHandler(ctx, resolved, settings, gate) {
  const log = logger(ctx)
  return async function handler(request, response) {
    const client = clientAbortSource(response)
    /** 超时信号与时长：拿到生效配置后才确定，catch 里要判空。 */
    let timeout
    let timeoutMs = resolved.timeoutMs
    /** 并发闸门的占位凭证：拿到后必须在 finally 释放。 */
    let slot
    try {
      const call = await prepareCall(ctx, resolved, settings, request, gate)
      slot = call.slot
      timeoutMs = call.timeoutMs
      timeout = AbortSignal.timeout(timeoutMs)
      const result = await optimizeText(ctx, call.limits, {
        ...call.route,
        system: call.system,
        text: call.text,
        ...call.limits.temperature === undefined ? {} : { temperature: call.limits.temperature },
        ...call.sessionId === undefined ? {} : { sessionId: call.sessionId },
        signal: AbortSignal.any([timeout, client.signal]),
      })
      sendJson(response, 200, {
        text: result.text,
        modelUsed: call.route,
        ...call.presetId === undefined ? {} : { presetId: call.presetId },
        ...call.styleIds.length === 0 ? {} : { styleIds: call.styleIds },
        ...result.truncated ? { truncated: true } : {},
      })
    } catch (error) {
      const timedOut = timeout?.aborted === true && !client.signal.aborted
      if ((timedOut || client.signal.aborted) && !response.writableEnded) {
        // 客户端已经走了（或超时）：给出可读原因，别把上游错误原样抛给空气。
        log.warn('better-input: %s', timedOut ? 'timed out' : 'client disconnected')
        sendJson(response, timedOut ? 504 : 499, {
          error: timedOut ? 'timeout' : 'client-gone',
          message: timedOut ? `超过 ${String(timeoutMs)} ms 未完成` : '客户端已断开',
        })
        return
      }
      replyFailure(ctx, response, error, 'model-failed')
    } finally {
      slot?.release?.()
      client.dispose()
    }
  }
}

/**
 * 开一条 SSE 响应流。
 *
 * 注意事项（都踩过或差点踩）：
 *   · `text/event-stream` 必须早于任何 `write()` 就写好头，否则客户端拿不到流式语义；
 *   · `cache-control: no-store` + `x-accel-buffering: no`：本机没有代理，但这两个头能防止
 *     中间层攒包（攒了就等于没有流式）；
 *   · webserver 的 gzip 中间件已经对 `text/event-stream` 放行（见 dsh-host-webserver），
 *     所以不需要我们再关压缩。
 * @param {object} response - node ServerResponse（或测试替身）。
 * @param {() => boolean} [isAborted] - 客户端是否已断开（断开后不要再往 socket 写）。
 * @returns {{ send: (event: string, data: unknown) => void, end: () => void, closed: () => boolean }} 流句柄。
 */
function openEventStream(response, isAborted) {
  response.statusCode = 200
  response.setHeader('content-type', 'text/event-stream; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('connection', 'keep-alive')
  response.setHeader('x-accel-buffering', 'no')
  // 立即 flush 一个注释帧：让客户端（和任何中间层）马上知道流已经开了。
  response.write(': ok\n\n')
  return {
    send: (event, data) => {
      // 客户端断了就别再写：写到已销毁的 socket 上只会产生无用的错误事件。
      if (response.writableEnded === true || isAborted?.() === true) return
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    end: () => {
      if (response.writableEnded === true) return
      response.end()
    },
    closed: () => response.writableEnded === true,
  }
}

/**
 * 构建流式优化处理器（SSE）。
 *
 * 与 JSON 路由的差别只有"怎么把结果交回去"：准入条件、并发闸门、CAS 所需的语义完全一致
 * （共用 `prepareCall`）。增量只转发**文本增量**（reasoning 增量不发），最终一帧 `done` 带
 * 装配后的权威文本 —— 客户端以 `done` 的文本为准，避免增量与装配结果在边界上不一致。
 * @param {object} ctx - 宿主上下文。
 * @param {Readonly<object>} resolved - 已校验的插件组合配置。
 * @param {{ available: boolean, read: () => unknown }} settings - 设置门面。
 * @param {{ acquire: (sessionId: string | undefined) => object }} gate - 并发闸门。
 * @returns {(request: object, response: object) => Promise<void>} 处理器。
 */
function createStreamHandler(ctx, resolved, settings, gate) {
  const log = logger(ctx)
  return async function handler(request, response) {
    const client = clientAbortSource(response)
    let timeout
    let timeoutMs = resolved.timeoutMs
    let slot
    /** 已经开流了吗：开了就只能用 SSE 事件报错，不能再回 HTTP 状态码。 */
    let stream
    try {
      const call = await prepareCall(ctx, resolved, settings, request, gate)
      slot = call.slot
      timeoutMs = call.timeoutMs
      timeout = AbortSignal.timeout(timeoutMs)
      stream = openEventStream(response, () => client.signal.aborted)
      const signal = AbortSignal.any([timeout, client.signal])
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream({
        provider: call.route.provider,
        model: call.route.model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: frameUserPayload(call.text) }],
          source: { kind: 'plugin', plugin: 'better-input' },
        })],
        system: call.system,
        maxTokens: call.limits.maxOutputTokens,
        signal,
        ...call.limits.temperature === undefined ? {} : { temperature: call.limits.temperature },
        ...call.sessionId === undefined ? {} : { sessionId: call.sessionId },
      })) {
        assembler.push(chunk)
        if (chunk.type === 'text-delta') stream.send('delta', { text: chunk.text })
      }
      const outcome = finishOutcome(assembler.finish)
      if (outcome.error !== undefined) throw outcome.error
      if (outcome.unknown !== undefined) {
        log.warn('better-input: unknown finish reason %s; returning the assembled text', String(outcome.unknown))
      }
      const text = assembler.blocks()
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim()
      if (text === '') throw new Error('模型没有返回任何文本')
      stream.send('done', {
        text,
        modelUsed: call.route,
        ...call.presetId === undefined ? {} : { presetId: call.presetId },
        ...call.styleIds.length === 0 ? {} : { styleIds: call.styleIds },
        ...assembler.finish?.kind === 'max-tokens' ? { truncated: true } : {},
      })
    } catch (error) {
      const timedOut = timeout?.aborted === true && !client.signal.aborted
      if (stream?.closed() === true) {
        // 客户端已经断开：没人收事件了，只留日志。
        log.warn('better-input: stream %s', client.signal.aborted ? 'client disconnected' : 'ended early')
        return
      }
      if (stream !== undefined) {
        if (client.signal.aborted) {
          // 客户端自己断了：没人收事件了，写进去也没意义（还可能写到已销毁的 socket 上）。
          log.warn('better-input: stream %s', 'client disconnected')
          return
        }
        if (timedOut) {
          log.warn('better-input: stream %s', 'timed out')
          stream.send('error', {
            error: 'timeout',
            message: `超过 ${String(timeoutMs)} ms 未完成`,
          })
        } else if (error instanceof RequestError) {
          stream.send('error', { error: error.code, message: error.message })
        } else {
          const message = error instanceof Error ? error.message : String(error)
          log.warn('better-input: %s: %s', 'model-failed', message)
          stream.send('error', { error: 'model-failed', message })
        }
        stream.end()
        return
      }
      // 还没开流（校验/闸门阶段就失败了）→ 照常回 HTTP 状态码，客户端好按既有文案处理。
      if (timedOut || client.signal.aborted) {
        sendJson(response, timedOut ? 504 : 499, {
          error: timedOut ? 'timeout' : 'client-gone',
          message: timedOut ? `超过 ${String(timeoutMs)} ms 未完成` : '客户端已断开',
        })
        return
      }
      replyFailure(ctx, response, error, 'model-failed')
    } finally {
      slot?.release?.()
      stream?.end()
      client.dispose()
    }
  }
}

/**
 * 构建只读路由处理器（目录查询 / 试调）。
 * @param {object} ctx - 宿主上下文。
 * @param {'GET' | 'POST'} method - 允许的方法。
 * @param {(request: object) => Promise<Record<string, unknown>>} run - 业务体。
 * @param {{ session?: boolean }} [requirement] - 是否要求浏览器会话（默认不要求，仅限环回）。
 * @param {string} [code] - 非请求级异常时的兜底错误码（进响应体与日志）。
 * @returns {(request: object, response: object) => Promise<void>} 处理器。
 */
function createReadHandler(ctx, method, run, requirement = { session: false }, code = 'catalog-failed') {
  return async function handler(request, response) {
    try {
      if (request.method !== method) {
        throw new RequestError('method-not-allowed', 405, `只接受 ${method}`)
      }
      const rejection = rejectionOf(ctx, request, requirement)
      if (rejection !== undefined) throw rejectionError(rejection)
      sendJson(response, 200, await run(request))
    } catch (error) {
      replyFailure(ctx, response, error, code)
    }
  }
}

/**
 * provider 目录（读失败不抛：目录是增强信息，缺了设置页仍能手填）。
 * @param {object} ctx - 宿主上下文。
 * @returns {Array<{ id: string, name: string }>} provider 行。
 */
function providerRows(ctx) {
  try {
    const providers = ctx.llm.listProviders() ?? []
    return providers.map(provider => ({
      id: String(provider.id),
      name: typeof provider.name === 'string' && provider.name !== '' ? provider.name : String(provider.id),
    }))
  } catch {
    return []
  }
}

/**
 * 目录 + 当前生效配置（设置页首屏 + 输入框预设菜单用）。
 *
 * 这里同时下发**客户端需要的规则与清单**，让"规则只有一份事实来源"：
 * `limits` 是各区间的权威值（客户端不再自己写一份镜像，避免"客户端放行 → 宿主拒绝"），
 * `presets` 只给 `id`/`label`（`prompt` 留在宿主，客户端不需要也不该看到）。
 *
 * `styles` 与 `presets` 的区别只在**能不能多选**：风格是内置的多选清单，
 * 同样**只下发 `id`/`label` 与提示词来源**，正文一律留在宿主——所以设置页里那几栏
 * 显示的是"用户自己填的值"，空着时按 `source` 说明当前用的是哪一层（`config`/`default`），
 * 而不是把宿主侧提示词回灌到浏览器。
 * @param {object} ctx - 宿主上下文。
 * @param {Readonly<object>} resolved - 组合配置。
 * @param {{ available: boolean, reason?: string | undefined, read: () => unknown }} settings - 设置门面。
 * @returns {Record<string, unknown>} 响应体。
 */
function catalogPayload(ctx, resolved, settings) {
  const section = settings.available ? settings.read() : undefined
  const effective = effectiveConfig(resolved, section)
  return {
    namespace: SETTINGS_NAMESPACE,
    settings: {
      available: settings.available,
      // 不可用时把**宿主侧的原因**带出去：客户端只显示一句笼统的"设置服务不可用"就没法排查了。
      ...settings.available || settings.reason === undefined ? {} : { reason: settings.reason },
      section: section === undefined || section === null ? {} : section,
    },
    providers: providerRows(ctx),
    limits: {
      maxInputChars: resolved.maxInputChars,
      temperature: TEMPERATURE_RANGE,
      maxOutputTokens: MAX_OUTPUT_TOKENS_RANGE,
      timeoutMs: TIMEOUT_RANGE,
    },
    presets: resolved.presets.map(preset => ({ id: preset.id, label: preset.label })),
    styles: effective.styles.map(style => ({ id: style.id, label: style.label, source: style.source })),
    effective: {
      provider: effective.provider ?? null,
      model: effective.model ?? null,
      temperature: effective.temperature ?? null,
      maxOutputTokens: effective.maxOutputTokens,
      timeoutMs: effective.timeoutMs,
      sources: effective.sources,
    },
    configPath: pluginConfigPath(),
  }
}

/**
 * 从 query 里取 provider。
 * @param {object} request - 请求对象。
 * @returns {string | undefined} provider id。
 */
function providerQuery(request) {
  const raw = typeof request.url === 'string' ? request.url : ''
  let parsed
  try {
    parsed = new URL(raw, 'http://localhost')
  } catch {
    return undefined
  }
  const value = parsed.searchParams.get('provider')
  return value === null || value.trim() === '' ? undefined : value.trim()
}

/**
 * 某 provider 的模型列表。适配器没有 catalog 时返回空数组（不是错误）——
 * 设置页因此允许手填模型 id。
 * @param {object} ctx - 宿主上下文。
 * @param {object} request - 请求对象。
 * @returns {Promise<Record<string, unknown>>} 响应体。
 */
async function modelsPayload(ctx, request) {
  const provider = providerQuery(request)
  if (provider === undefined) {
    throw new RequestError('missing-provider', 400, '缺少 provider 查询参数')
  }
  const models = await ctx.llm.listModels(provider)
  return {
    provider,
    models: (models ?? []).map(model => ({
      id: String(model.id),
      name: typeof model.name === 'string' && model.name !== '' ? model.name : String(model.id),
    })),
  }
}

/**
 * 试调一条模型路由：只做「宿主能不能解析这个 provider/model」，不发真实请求、不产生费用。
 * @param {object} ctx - 宿主上下文。
 * @param {object} request - 请求对象。
 * @returns {Promise<Record<string, unknown>>} 响应体。
 */
async function checkPayload(ctx, request) {
  const body = await readJsonObject(request, MAX_BODY_BYTES)
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (provider === '' || model === '') {
    throw new RequestError('missing-model', 400, 'provider 与模型名称都必须填写')
  }
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model)
    // 形状以 dsh-llm 的 `LlmResolvedModelInfo` 为准：`context?: LlmModelContext`
    // 即 `{ contextWindow: number }`，**不是数字**（types.d.ts:275-306）。
    const context = info?.context?.contextWindow
    return {
      ok: true,
      provider,
      model,
      name: typeof info?.name === 'string' ? info.name : model,
      ...typeof context === 'number' ? { context } : {},
      ...typeof info?.defaultMaxTokens === 'number' ? { defaultMaxTokens: info.defaultMaxTokens } : {},
    }
  } catch (error) {
    return { ok: false, provider, model, message: error instanceof Error ? error.message : String(error) }
  }
}

/* ── 插件配置文件（设置页的「打开插件配置文件」按钮） ──────────────────────── */

/**
 * 插件自己的 bundle patch（= 组合层配置文件）的绝对路径。
 *
 * 用**模块自身位置**推导，而不是猜 `$DSH_HOME`/profile 的目录布局：`package.json` 的
 * `dsh.bundle.patch` 声明的就是包根目录下这个文件，所以「包根 + PLUGIN_CONFIG_FILENAME」
 * 在任何安装方式下都对——`link:` 安装指向仓库，正式安装指向 profile 的 `node_modules`。
 * @returns {string} 绝对路径。
 */
function pluginConfigPath() {
  return join(fileURLToPath(new URL('..', import.meta.url)), PLUGIN_CONFIG_FILENAME)
}

/**
 * 起一个不托管的子进程，**只在真的 spawn 成功之后**才 resolve。
 *
 * 必须等 `spawn` 事件而不是立刻 resolve：可执行文件不存在时错误是**异步**发的
 * （`error` 事件 / ENOENT），立刻 resolve 会把"这台机器上没有 xdg-open"报成"已打开"——
 * 而那正是这个按钮最需要如实讲清楚的情形。
 * @param {string} file - 可执行文件。
 * @param {string[]} args - 参数。
 * @returns {Promise<void>} 进程已起。
 * @throws {Error} 起不来时抛错（ENOENT/EACCES 等）。
 */
function spawnDetached(file, args) {
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(file, args, { detached: true, stdio: 'ignore' })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolve()
    })
  })
}

/**
 * 这个候选是不是「本地已经装好的可执行文件」。
 *
 * 绝对路径的候选（VS Code 的 Code.exe）必须先存在才值得一试；裸命令名（notepad.exe / open /
 * xdg-open）交给 PATH 去解析，这里一律放行。
 * @param {string} file - 候选可执行文件。
 * @returns {boolean} 是否值得尝试。
 */
function looksInstalled(file) {
  return isAbsolute(file) ? existsSync(file) : true
}

/**
 * 打开插件配置文件：按 `openerCandidates` 的优先级挑一个能起的编辑器。
 *
 * 三种失败都给出**可直接照做**的文案（都带上绝对路径）：文件不在、平台不支持、全都起不来。
 * @returns {Promise<Record<string, unknown>>} `{ ok: true, path, openedWith }`。
 * @throws {RequestError} 任一步失败时抛出可展示的请求级错误。
 */
async function openConfigPayload() {
  const target = pluginConfigPath()
  if (!existsSync(target)) {
    throw new RequestError('config-missing', 404, `找不到插件配置文件：${target}`)
  }
  const candidates = openerCandidates(process.platform, target, {
    localAppData: process.env.LOCALAPPDATA,
    programFiles: process.env.ProgramFiles,
    programFilesX86: process.env['ProgramFiles(x86)'],
  })
  if (candidates.length === 0) {
    throw new RequestError(
      'open-unsupported',
      501,
      `当前平台（${process.platform}）不支持自动打开文件，请手动打开：${target}`,
    )
  }
  const failures = []
  for (const candidate of candidates) {
    if (!looksInstalled(candidate.file)) continue
    try {
      await spawnDetached(candidate.file, candidate.args)
      return { ok: true, path: target, openedWith: candidate.file }
    } catch (error) {
      failures.push(`${candidate.file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new RequestError(
    'open-failed',
    500,
    `打开失败（${failures.length === 0 ? '没有可用的编辑器' : failures.join('；')}）；请手动打开：${target}`,
  )
}

/**
 * 宿主半入口：挂载优化路由与设置页支撑路由，并注册设置命名空间。
 * @param {object} ctx - 宿主上下文。
 * @param {unknown} config - cordis 传进来的插件配置。
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const log = logger(ctx)
  if (!resolved.enabled) {
    log.info('better-input: disabled by config; no route mounted')
    return
  }
  // 设置是可选依赖：没有提供者、或注册失败（例如外部手改出的非法段）都只降级，绝不拖垮基础功能。
  // **注意**：注册挂在「settings 服务就绪」这一刻上，不能在 apply 里一次性读（见 lib/settings.js）。
  const settings = bindSettings(ctx, log)
  // 并发闸门随 fiber 生命周期：插件重载/卸载即归零。
  const gate = createGate(resolved.maxConcurrentCalls)
  const routes = [
    { path: ROUTE, handler: createOptimizeHandler(ctx, resolved, settings, gate) },
    { path: ROUTE_STREAM, handler: createStreamHandler(ctx, resolved, settings, gate) },
    {
      path: ROUTE_CATALOG,
      handler: createReadHandler(ctx, 'GET', () => Promise.resolve(catalogPayload(ctx, resolved, settings))),
    },
    { path: ROUTE_CATALOG_MODELS, handler: createReadHandler(ctx, 'GET', request => modelsPayload(ctx, request)) },
    { path: ROUTE_CHECK, handler: createReadHandler(ctx, 'POST', request => checkPayload(ctx, request)) },
    {
      path: ROUTE_OPEN_CONFIG,
      // 会在宿主上起进程（系统默认程序），所以与 /optimize 同级：必须有浏览器会话。
      handler: createReadHandler(
        ctx,
        'POST',
        () => openConfigPayload(),
        { session: true },
        'open-config-failed',
      ),
    },
  ]
  for (const route of routes) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      `better-input: ${route.path}`,
    )
  }
  // 这一行只反映"路由挂上了"；设置命名空间的注册结论由 bindSettings 自己打日志（它可能晚一拍）。
  log.info('better-input: mounted %s (+stream/catalog/check/open-config)', ROUTE)
}
