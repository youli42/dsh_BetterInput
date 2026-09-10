/**
 * better-input —— 宿主半（Node）类型。
 *
 * 只声明本包的对外契约；DSH 侧的 `WebRoute` / `GenerateOptions` 等类型
 * 由 @deepseek-ai/dsh-host-webserver、@deepseek-ai/dsh-llm 提供（作为 devDependencies
 * 装好后再 import type 即可；此处刻意不引，保证没有依赖也能被编辑器打开）。
 */

/** 稳定 cordis 插件名。 */
export declare const name = 'better-input'

/** 需要就绪的服务（设置服务是可选依赖，走 `ctx.get('settings')`，缺了只降级不报错）。 */
export declare const inject: readonly ['webServer', 'llm']

/** 能力路由：优化输入内容。 */
export declare const ROUTE = '/api/dsh-input-optimizer/optimize'
/** 流式优化路由（SSE）；客户端默认走它，`ROUTE` 是回退。 */
export declare const ROUTE_STREAM = '/api/dsh-input-optimizer/optimize/stream'
/** 目录 + 当前生效配置（设置页首屏用）。 */
export declare const ROUTE_CATALOG = '/api/dsh-input-optimizer/catalog'
/** 某 provider 的模型列表。 */
export declare const ROUTE_CATALOG_MODELS = '/api/dsh-input-optimizer/catalog/models'
/** 试调一条模型路由（只解析，不发真实请求）。 */
export declare const ROUTE_CHECK = '/api/dsh-input-optimizer/check'
/** 用系统默认程序打开插件配置文件（会在宿主上起进程 → 能力路由，要求浏览器会话）。 */
export declare const ROUTE_OPEN_CONFIG = '/api/dsh-input-optimizer/open-config'

/** 插件配置文件名（相对包根；与 package.json 的 `dsh.bundle.patch` 同源）。 */
export declare const PLUGIN_CONFIG_FILENAME = 'cordis.patch.yml'

/** 内置优化风格的 id（客户端可多选；提示词逐项可配）。 */
export declare const STYLE_IDS: readonly ['concise', 'spec']

/** 用户设置命名空间：宿主注册、客户端 `settingsScope` 绑定同一个。 */
export declare const SETTINGS_NAMESPACE = 'better-input'

/** 设置段的扁平字段（与宿主 schema、客户端表单一一对应）。 */
export interface BetterInputSettingsSection {
  /** 是否启用自定义提示词（默认 false = 用内置/组合配置的提示词）。 */
  customPromptEnabled?: boolean
  /** 自定义 system prompt 正文。 */
  systemPrompt?: string
  /** 模型 provider id（与 modelId 成对）。 */
  modelProvider?: string
  /** 模型 id（与 modelProvider 成对）。 */
  modelId?: string
  /** 采样温度。 */
  temperature?: number
  /** 输出 token 上限。 */
  maxOutputTokens?: number
  /** 单次调用超时（毫秒）。 */
  timeoutMs?: number
  /** 「精简」风格的独立提示词；留空 = 用组合配置同 id 的预设 / 内置默认。 */
  stylePromptConcise?: string
  /** 「转规格」风格的独立提示词；留空 = 用组合配置同 id 的预设 / 内置默认。 */
  stylePromptSpec?: string
}

/** 插件配置（全部可选；优先级低于设置页里的用户设置）。 */
export interface Config {
  /** 总开关；false 时不挂路由。 @default true */
  enabled?: boolean
  /** 默认优化提示词。 */
  systemPrompt?: string
  /** 固定模型路由；provider 与 model 必须成对出现。 */
  model?: { provider: string, model: string }
  /** 预设：调用方可用 `presetId` 选择，其 prompt 会追加到 system。 */
  presets?: ReadonlyArray<{ id: string, label?: string, prompt: string }>
  /** 输入字数上限。 @default 8000 */
  maxInputChars?: number
  /** 输出 token 上限（1..200000）。 @default 1024 */
  maxOutputTokens?: number
  /** 单次调用超时（毫秒，1000..600000）。 @default 30000 */
  timeoutMs?: number
  /** 采样温度（0..2；缺省不传，由适配器决定）。 */
  temperature?: number
}

/**
 * 宿主半入口：挂载 6 条路由并注册设置命名空间。
 * @param ctx - 需要提供 `webServer` 与 `llm` 的宿主上下文。
 * @param config - 插件配置。
 */
export declare function apply(ctx: unknown, config?: Config): void

/**
 * 计算**实际生效**的配置：内置默认 ← cordis 组合配置 ← 用户设置。
 * `section` 为 undefined（未配置 / 没有设置服务）时结果与加设置页之前完全一致。
 * @param config - resolveConfig 的产物。
 * @param section - 设置段。
 */
export declare function effectiveConfig(
  config: Readonly<object>,
  section: unknown,
): {
  systemPrompt: string
  provider?: string
  model?: string
  temperature?: number
  maxOutputTokens: number
  timeoutMs: number
  /** 每个风格的生效提示词与它来自哪一层（正文**不下发**给浏览器）。 */
  styles: ReadonlyArray<{ id: string, label: string, prompt: string, source: 'settings' | 'config' | 'default' }>
  /** 每个值实际来自哪一层，供设置页如实标注。 */
  sources: { prompt: string, model: string, temperature: string, limits: string }
}

/**
 * 校验请求体里的 `styleIds`（多选优化风格）：去重、未知 id 报 400。
 * @param raw - 请求体里的 styleIds。
 * @returns 校验后的风格 id 列表。
 */
export declare function parseStyleIds(raw: unknown): string[]

/**
 * 打开配置文件的候选命令（按优先级；纯函数，便于单测）。
 * @param platform - `process.platform`。
 * @param target - 文件绝对路径。
 * @param roots - 安装位置根目录（测试注入用）。
 */
export declare function openerCandidates(
  platform: string,
  target: string,
  roots?: { localAppData?: string, programFiles?: string, programFilesX86?: string },
): ReadonlyArray<{ file: string, args: string[] }>

/**
 * 校验设置段的跨字段约束（schema 之外的部分）；规则的客户端镜像在 lib/client.js。
 * @param section - 解析后的设置段。
 * @returns 错误消息列表（空数组 = 通过）。
 */
export declare function validateSettingsSection(section: unknown): string[]

/** 一次成功响应。 */
export interface OptimizeResponse {
  /** 优化后的文本。 */
  text: string
  /** 实际使用的模型路由。 */
  modelUsed: { provider: string, model: string }
  /** 命中的预设 id。 */
  presetId?: string
  /** 本次选中的优化风格（一个都没选时**不带这个字段**）。 */
  styleIds?: string[]
  /** 输出被 maxTokens 截断。 */
  truncated?: true
}

/** 一次失败响应。 */
export interface OptimizeFailure {
  /** 机器可读错误码：bad-request | empty-text | text-too-long | unknown-preset | unknown-style |
   * body-too-large | forbidden | method-not-allowed | no-model-route | model-failed |
   * timeout | client-gone | config-missing | open-failed | open-unsupported。 */
  error: string
  /** 面向用户的说明（前端可直接展示）。 */
  message: string
}
