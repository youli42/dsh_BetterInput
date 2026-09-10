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

import { SETTINGS_NAMESPACE, STYLE_DEFINITIONS, stylePromptField, validateSettingsSection } from './policy.js'

export { SETTINGS_NAMESPACE }

/**
 * 每个优化风格一个**独立的提示词字段**（`stylePromptConcise` / `stylePromptSpec`）。
 *
 * 字段名从 `policy.js` 的风格清单生成，而不是在这里手写两遍：清单一旦增删风格，
 * schema、跨字段校验、`SETTINGS_FIELD_KEYS`（重置用）与客户端表单会一起跟上，
 * 不会出现"宿主收了字段、客户端不发"这类漂移。测试里另有一条把 schema 键与
 * `SETTINGS_FIELD_KEYS` 对齐钉住的用例。
 */
const stylePromptFields = Object.fromEntries(
  STYLE_DEFINITIONS.map(style => [stylePromptField(style.id), z.string()]),
)

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
  /**
   * 各优化风格的独立提示词：留空 = 回落到组合配置里同 id 的预设，再往下是内置默认。
   * 风格 id 是内置常量（`STYLE_DEFINITIONS`），所以这里能给出**静态**字段名。
   */
  ...stylePromptFields,
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
 * 把设置命名空间挂到「settings 服务就绪」这一刻上，而不是在 `apply()` 里读一次。
 *
 * **为什么不能在 apply() 里一次性 `ctx.get('settings')`**（本轮真机事故的根因）：
 *
 *   1. `SettingsProvider`（dsh-settings）用 `super(ctx, 'settings')` 提供这个服务，而它的
 *      `async *[Service.init]()` 里要 `await this.load()`（读 `settings.yaml`）**之后**服务才
 *      publish、才对依赖者可注入。
 *   2. `ctx.get(name)` 等价于 `ctx.reflect.get(name, strict = true)`；cordis 的 `_getImpl` 对
 *      「已 provide 但 fiber 还没 ACTIVE」的服务返回 `undefined`。
 *
 *   两条合起来：只要本插件（`inject: ['webServer','llm']`）比设置提供者先激活——这是**竞态**，
 *   会随启动顺序/磁盘快慢而变——一次性读就会拿到 `undefined`，然后**永久**降级：命名空间
 *   永不注册，而客户端设置页只能显示"设置服务不可用"。它也能解释"同一份代码昨天还好、今天坏了"。
 *
 * 用 `ctx.inject(['settings'], cb)`：`cb` 是个子 fiber，settings 服务就绪时执行、卸载时回收
 * （注册本身就是 calling context 上的 effect，故会随子 fiber 一起注销，服务替换后可重新注册）。
 * 这样既不会把 settings 变成硬依赖（没有提供者的部署照常只降级），又不会漏掉"后到"的服务。
 * @param {object} ctx - 宿主上下文。
 * @param {{ info: Function, warn: Function }} log - 日志门面（可选注入，用于如实记录结论）。
 * @returns {{ available: boolean, reason: string | undefined, read: () => unknown }} 读取门面。
 */
export function bindSettings(ctx, log) {
  /** @type {{ available: boolean, reason: string | undefined, read: () => unknown }} */
  const facade = {
    available: false,
    reason: undefined,
    // 每次请求现读：设置提交后无需重启/刷新，下一次优化即用新值。
    read: () => undefined,
  }
  ctx.inject(['settings'], (settingsCtx) => {
    // 服务消失/被替换时回到降级态；下一次注入会重新注册。
    settingsCtx.effect(() => () => {
      facade.available = false
      facade.read = () => undefined
    }, 'better-input: settings availability')
    try {
      const settings = /** @type {{ register: Function }} */ (settingsCtx.settings)
      const scope = settings.register(SETTINGS_NAMESPACE, BetterInputSettingsSchema, {
        applies: 'live',
        validate: validateBetterInputSettings,
      })
      facade.available = true
      facade.reason = undefined
      facade.read = () => scope.get()
      log?.info('better-input: settings namespace "%s" registered', SETTINGS_NAMESPACE)
    } catch (error) {
      // 注册失败（例如外部手改出的非法段会让 register 直接抛）：基础功能照常，只降级。
      facade.available = false
      facade.reason = error instanceof Error ? error.message : String(error)
      log?.warn('better-input: settings namespace unavailable: %s', facade.reason)
    }
  })
  return facade
}
