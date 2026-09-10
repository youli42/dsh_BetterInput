/**
 * better-input —— 宿主半（Node）类型。
 *
 * 只声明本包的对外契约；DSH 侧的 `WebRoute` / `GenerateOptions` 等类型
 * 由 @deepseek-ai/dsh-host-webserver、@deepseek-ai/dsh-llm 提供（作为 devDependencies
 * 装好后再 import type 即可；此处刻意不引，保证没有依赖也能被编辑器打开）。
 */

/** 稳定 cordis 插件名。 */
export declare const name = 'better-input'

/** 需要就绪的服务。 */
export declare const inject: readonly ['webServer', 'llm']

/** 宿主路由路径（浏览器半镜像同一字面量）。 */
export declare const ROUTE = '/api/dsh-input-optimizer/optimize'

/** 插件配置（全部可选；`model` 省略时用宿主当前/默认模型选择）。 */
export interface Config {
  /** 总开关；false 时不挂路由。 @default true */
  enabled?: boolean
  /** 优化用的 system prompt。 */
  systemPrompt?: string
  /** 固定模型路由；provider 与 model 必须成对出现。 */
  model?: { provider: string, model: string }
  /** 预设：调用方可用 `presetId` 选择，其 prompt 会追加到 system。 */
  presets?: ReadonlyArray<{ id: string, label?: string, prompt: string }>
  /** 输入字数上限。 @default 8000 */
  maxInputChars?: number
  /** 输出 token 上限。 @default 1024 */
  maxOutputTokens?: number
  /** 单次调用超时（毫秒）。 @default 30000 */
  timeoutMs?: number
}

/**
 * 宿主半入口。
 * @param ctx - 需要提供 `webServer` 与 `llm` 的宿主上下文。
 * @param config - 插件配置。
 */
export declare function apply(ctx: unknown, config?: Config): void

/** 一次成功响应。 */
export interface OptimizeResponse {
  /** 优化后的文本。 */
  text: string
  /** 实际使用的模型路由。 */
  modelUsed: { provider: string, model: string }
  /** 命中的预设 id。 */
  presetId?: string
  /** 输出被 maxTokens 截断。 */
  truncated?: true
}

/** 一次失败响应。 */
export interface OptimizeFailure {
  /** 机器可读错误码：bad-request | empty-text | text-too-long | unknown-preset |
   * body-too-large | forbidden | method-not-allowed | no-model-route | model-failed |
   * timeout | client-gone。 */
  error: string
  /** 面向用户的说明（前端可直接展示）。 */
  message: string
}
