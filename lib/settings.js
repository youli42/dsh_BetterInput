/**
 * better-input —— 宿主半的设置命名空间。
 *
 * 持久化走 dsh 的标准设置通道：`ctx.settings.register(namespace, schema, options)`。
 * 文档由 settings 提供者（web profile 里是 `dsh-settings-file`）落在 `$DSH_HOME/settings.yaml`，
 * 所以「应用重启 / 页面刷新后配置仍在」是框架保证的，本插件不自造存储。
 *
 * 客户端用 `ctx.settingsScope.bind({ namespace })` 读同一个命名空间——同一份文档、
 * 同一个版本栅栏，两边不会各说各话。
 *
 * @module dsh-better-input/settings
 */

import z from '@deepseek-ai/schemastery'

import { SETTINGS_NAMESPACE, validateSettingsSection } from './policy.js'

export { SETTINGS_NAMESPACE }

/**
 * 设置段 schema。
 *
 * 字段**刻意扁平**（客户端 `SettingsScope.set(field, value)` 只处理命名空间内的标量字段），
 * 且除 `customPromptEnabled` 外一律**不给默认值**：未设置 = undefined = 回落到组合配置/内置默认，
 * 这正是「未配置时使用默认模型与默认提示词」的实现方式。
 */
export const BetterInputSettingsSchema = z.object({
  /** 是否启用下面这段自定义提示词（默认关闭 = 用内置/组合配置的提示词）。 */
  customPromptEnabled: z.boolean().default(false),
  /** 自定义 system prompt 正文。 */
  systemPrompt: z.string(),
  /** 模型路由 provider id（与 modelId 成对）。 */
  modelProvider: z.string(),
  /** 模型 id（与 modelProvider 成对）。 */
  modelId: z.string(),
  /** 采样温度。 */
  temperature: z.number().min(0).max(2),
  /** 输出 token 上限。 */
  maxOutputTokens: z.number().step(1).min(1),
  /** 单次调用超时（毫秒）。 */
  timeoutMs: z.number().step(1).min(1000),
})

/**
 * schema 表达不了的跨字段约束：抛错即拒绝这次写入，调用方（设置页的「保存」）会收到这条消息。
 * @param {unknown} value - 解析后的设置段。
 * @returns {void}
 * @throws {Error} 任一规则不满足时抛错，消息可直接展示给用户。
 */
export function validateBetterInputSettings(value) {
  const errors = validateSettingsSection(value)
  if (errors.length > 0) throw new Error(errors.join('；'))
}

/**
 * 在宿主侧注册（或降级跳过）设置命名空间。
 *
 * `ctx.settings` 是**可选**依赖：某些部署可能没挂设置提供者。那种情况下不注册、不报错，
 * 插件其余功能照常（读到的设置段恒为 undefined → 走默认值），设置页会显示「不可用」。
 * @param {object} ctx - 宿主上下文。
 * @returns {{ available: boolean, read: () => unknown }} 读取门面。
 */
export function openSettings(ctx) {
  const settings = /** @type {{ register?: Function } | undefined} */ (ctx.get?.('settings'))
  if (settings === undefined || typeof settings.register !== 'function') {
    return { available: false, read: () => undefined }
  }
  const scope = settings.register(SETTINGS_NAMESPACE, BetterInputSettingsSchema, {
    applies: 'live',
    validate: validateBetterInputSettings,
  })
  return {
    available: true,
    // 每次请求现读：设置提交后无需重启/刷新，下一次优化即用新值。
    read: () => scope.get(),
  }
}
