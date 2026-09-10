/**
 * better-input —— 宿主半（Node）。
 *
 * 职责：把「优化输入框内容」这一个能力做成本机可访问的 HTTP 路由，
 * 用宿主里已注册的 LLM 服务做一次性辅助调用。浏览器半只负责取草稿、
 * 调这条路由、把结果写回输入框。
 *
 * 为什么走 HTTP 而不是 Typert remote：remote 需要仓库内的 codegen 构建管线，
 * 第三方插件无法参与；HTTP 路由是社区插件的既有成熟路径（同 dsh 的 api-gateway
 * 一样直接注册在 ctx.webServer 上）。代价是必须自己做信任围栏。
 *
 * @module dsh-better-input
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

import {
  MAX_BODY_BYTES,
  ROUTE,
  RequestError,
  isLoopbackRequest,
  frameUserPayload,
  readJsonObject,
  resolveConfig,
  sendJson,
  systemPromptFor,
} from './policy.js'

/** 稳定 cordis 插件名。 */
export const name = 'better-input'

/** 需要就绪的服务：路由宿主与 LLM 运行时。 */
export const inject = ['webServer', 'llm']

/** 路由路径（浏览器半镜像同一字面量）。 */
export { ROUTE }

/**
 * 取日志器：不 inject logger，缺了也不影响功能。
 * @param {object} ctx - 宿主上下文。
 * @returns {{ info: (m: string) => void, warn: (m: string) => void }} 日志门面。
 */
function logger(ctx) {
  const service = /** @type {{ info?: Function, warn?: Function } | undefined} */ (ctx.get?.('logger'))
  return {
    info: message => service?.info?.(message),
    warn: message => service?.warn?.(message),
  }
}

/**
 * 解析本次调用使用的模型路由：插件配置优先，其次宿主的默认/当前选择。
 * @param {object} ctx - 宿主上下文。
 * @param {Readonly<object>} resolved - 已校验的插件配置。
 * @returns {{ provider: string, model: string }} 路由。
 */
function resolveRoute(ctx, resolved) {
  if (resolved.provider !== undefined && resolved.model !== undefined) {
    return { provider: resolved.provider, model: resolved.model }
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
    '没有可用的模型路由：请在插件配置的 config.model 里显式指定 provider/model，或先在选择器里选一个模型',
  )
}

/**
 * 把 finish reason 翻译成失败（'stop' 之外的终态都不能当成完整结果）。
 * @param {object} finish - BlockAssembler 的 finish。
 * @returns {Error | undefined} 终态错误，正常结束返回 undefined。
 */
function finishError(finish) {
  switch (finish?.kind) {
    case 'stop':
    case 'max-tokens':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure?.message ?? '模型调用失败')
      error.code = finish.failure?.code
      return error
    }
    case 'tool-calls':
      return new Error('模型意外发起了工具调用；优化输入不应带工具')
    default:
      return new Error(`模型返回了未知终止原因 "${String(finish?.kind)}"`)
  }
}

/**
 * 一次性辅助 LLM 调用：与官方 dsh-session-title-llm 同构（stream + BlockAssembler + finish 校验）。
 * @param {object} ctx - 宿主上下文。
 * @param {Readonly<object>} resolved - 已校验的插件配置。
 * @param {{ provider: string, model: string, system: string, text: string, sessionId?: string, signal: AbortSignal }} call - 本次调用参数。
 * @returns {Promise<{ text: string, truncated: boolean }>} 优化结果。
 */
async function optimizeText(ctx, resolved, call) {
  const messages = [createUserMessage({
    content: [{ type: 'text', text: frameUserPayload(call.text) }],
    source: { kind: 'plugin', plugin: 'better-input' },
  })]
  const options = {
    provider: call.provider,
    model: call.model,
    messages,
    system: call.system,
    maxTokens: resolved.maxOutputTokens,
    signal: call.signal,
    ...call.sessionId === undefined ? {} : { sessionId: call.sessionId },
    // purpose 是封闭联合（'compaction' | 'session-title'），第三方插件无法新增取值，
    // 这里保持省略 = 普通请求语义。
  }
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const failure = finishError(assembler.finish)
  if (failure !== undefined) throw failure
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
 * 构建路由处理器。
 * @param {object} ctx - 宿主上下文。
 * @param {Readonly<object>} resolved - 已校验的插件配置。
 * @returns {(request: object, response: object) => Promise<void>} 处理器。
 */
function createHandler(ctx, resolved) {
  const log = logger(ctx)
  return async function handler(request, response) {
    const client = clientAbortSource(response)
    const timeout = AbortSignal.timeout(resolved.timeoutMs)
    try {
      if (request.method !== 'POST') {
        throw new RequestError('method-not-allowed', 405, '只接受 POST')
      }
      if (!isLoopbackRequest(request)) {
        throw new RequestError('forbidden', 403, '这条路由只服务本机浏览器')
      }
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
      const presetId = typeof body.presetId === 'string' && body.presetId !== '' ? body.presetId : undefined
      const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
      const system = systemPromptFor(resolved, presetId)
      const route = resolveRoute(ctx, resolved)
      const result = await optimizeText(ctx, resolved, {
        ...route,
        system,
        text,
        ...sessionId === undefined ? {} : { sessionId },
        signal: AbortSignal.any([timeout, client.signal]),
      })
      sendJson(response, 200, {
        text: result.text,
        modelUsed: route,
        ...presetId === undefined ? {} : { presetId },
        ...result.truncated ? { truncated: true } : {},
      })
    } catch (error) {
      const aborted = client.signal.aborted || timeout.aborted
      if (aborted && !response.writableEnded) {
        // 客户端已经走了（或超时）：给出可读原因，别把上游错误原样抛给空气。
        const timedOut = timeout.aborted && !client.signal.aborted
        log.warn(`better-input: ${timedOut ? 'timed out' : 'client disconnected'}`)
        sendJson(response, timedOut ? 504 : 499, {
          error: timedOut ? 'timeout' : 'client-gone',
          message: timedOut ? `超过 ${String(resolved.timeoutMs)} ms 未完成` : '客户端已断开',
        })
        return
      }
      if (error instanceof RequestError) {
        sendJson(response, error.status, { error: error.code, message: error.message })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`better-input: optimize failed: ${message}`)
      sendJson(response, 502, { error: 'model-failed', message })
    } finally {
      client.dispose()
    }
  }
}

/**
 * 宿主半入口：挂载优化路由。
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
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: createHandler(ctx, resolved) }),
    'better-input: optimize route',
  )
  log.info(`better-input: mounted ${ROUTE}`)
}
