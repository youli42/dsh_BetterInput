/**
 * better-input —— 插件 Config schema（dsh 0.2.0+ 设置通道）。
 *
 * dsh 0.2.0 移除了独立的 `ctx.settings.register(namespace, schema)` 与客户端 `settingsScope`
 * 服务，改为「插件自己的 Config schema 自动投影成设置表单」：
 *   · 组合层（组合的 `config:`）= base；
 *   · 用户在设置页改的值 = user 层，写进**当前 profile 的 Cordis patch**
 *     （`~/.dsh/profiles/<profile>/cordis.patch.yml`）；
 *   · loader 合并两层后交给 `apply(ctx, config)`。
 *
 * **哪些字段能在设置页编辑，由 `.volatile()` 决定，这不是可选项**：dsh-settings 的
 * `describe()` 对 `volatileForm(schema) === undefined` 的条目直接返回空（表单根本不下发），
 * 而 `write()` 对没有 volatile 字段的条目抛 `Plugin entry "…" has no volatile fields`、
 * 对任何不落在 volatile 节点下的路径抛 `Config field "…" is not volatile`。
 * 所以**用户层字段一个都不能漏标**——`test/smoke.mjs` 有一条结构断言把
 * `SETTINGS_FIELD_KEYS` 与这里的 volatile 标记钉在一起。
 *
 * volatile 的语义是 "editable **without remounting**"：保存**不会**重新 apply，而且框架交给
 * `apply` 的是只读引用（`Volatile`，`.get()` 现读）。所以宿主半必须每次请求现读这些字段，
 * 见 lib/index.js 的 `liveSection`。
 *
 * schema 只管单字段的类型/区间；跨字段约束（追加提示词三全、id 唯一、activeProfileId 存在等）
 * 由 `lib/policy.js` 的 `validateSettingsSection` 负责——它在**客户端**保存前复跑（宿主侧刻意
 * 不跑，避免用户层配置非法时整个插件 apply 挂掉），schemastery 的 object schema 也不便表达
 * 「某项缺名称时按内置标签补齐」这类组合规则。
 *
 * @module dsh-better-input/settings
 */

import z from '@deepseek-ai/schemastery'

import {
  ACTIVE_PROFILE_FIELD,
  DEFAULT_REASONING_EFFORT_FIELD,
  PROMPT_PROFILES_FIELD,
  SHOW_REASONING_FIELD,
  STYLE_DEFINITIONS,
  USER_FIELD_KEYS,
  stylePromptField,
} from './policy.js'

/**
 * 每个优化风格一个**独立的提示词字段**（`stylePromptConcise` / `stylePromptSpec`）。
 *
 * 字段名从 `policy.js` 的风格清单生成，而不是在这里手写两遍：清单一旦增删风格，
 * schema、跨字段校验、`SETTINGS_FIELD_KEYS`（重置用）与客户端表单会一起跟上，
 * 不会出现"宿主收了字段、客户端不发"这类漂移。测试里另有一条把 schema 键与
 * `SETTINGS_FIELD_KEYS` 对齐钉住的用例。
 */
const stylePromptFields = Object.fromEntries(
  STYLE_DEFINITIONS.map(style => [stylePromptField(style.id), z.string().volatile()]),
)

/**
 * 插件 Config schema（同时是组合层 base 与用户层 user 的字段集）。
 *
 * **组合层字段照旧不给默认值**（`enabled` 除外）：未设置 = undefined = 回落到内置默认，
 * 这正是「未配置时使用默认模型与默认提示词」的实现方式。
 * 用户层字段同样不给默认值（`customPromptEnabled` 除外）：未设置 = undefined = 回落到
 * 组合层/内置默认。两层**不共用键**（见 `policy.js` 的 `USER_FIELD_KEYS`），
 * 所以每个键只属于一层，`/catalog` 的 `sources.*` 能如实标注来源。
 */
export const Config = z.object({
  // ── 组合层（组合的 `config:`；普通字段，设置页不可改） ──
  /** 总开关；false 时不挂路由。 */
  enabled: z.boolean().default(true),
  /** 默认系统提示词（基底；追加提示词接在它之后）。 */
  systemPrompt: z.string(),
  /** 固定模型路由；provider 与 model 必须成对出现。 */
  model: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  /** 预设；调用方可用 presetId 选中，其 prompt 追加到 system。 */
  presets: z.array(z.object({
    id: z.string(),
    label: z.string(),
    prompt: z.string(),
  })),
  /** 输入字数上限。 */
  maxInputChars: z.number().step(1).min(1),
  /** 输出 token 上限（1..200000）。 */
  maxOutputTokens: z.number().step(1).min(1).max(200000),
  /** 单次调用超时（毫秒，1000..600000）。 */
  timeoutMs: z.number().step(1).min(1000).max(600000),
  /** 采样温度（0..2；缺省交给适配器决定）。 */
  temperature: z.number().min(0).max(2),
  /** 全局并发调用上限（1..64）。 */
  maxConcurrentCalls: z.number().step(1).min(1).max(64),

  // ── 用户层（设置页写入；**每个字段都必须 .volatile()**，未设置 = 回落组合层/内置默认） ──
  /** 是否启用自定义系统提示词（默认 false = 用组合层/内置的系统提示词）。 */
  customPromptEnabled: z.boolean().default(false).volatile(),
  /** 自定义系统提示词正文（与组合层 `systemPrompt` 分键，来源才分得清）。 */
  [USER_FIELD_KEYS.systemPrompt]: z.string().volatile(),
  /** 模型路由 provider id（与 modelId 成对；用户层标量，与组合层 `model` 对象分写）。 */
  modelProvider: z.string().volatile(),
  /** 模型 id（与 modelProvider 成对）。 */
  modelId: z.string().volatile(),
  /** 采样温度覆盖（与组合层 `temperature` 分键）。 */
  [USER_FIELD_KEYS.temperature]: z.number().min(0).max(2).volatile(),
  /** 输出 token 上限覆盖（与组合层 `maxOutputTokens` 分键）。 */
  [USER_FIELD_KEYS.maxOutputTokens]: z.number().step(1).min(1).max(200000).volatile(),
  /** 单次调用超时覆盖（与组合层 `timeoutMs` 分键）。 */
  [USER_FIELD_KEYS.timeoutMs]: z.number().step(1).min(1000).max(600000).volatile(),
  /**
   * 是否把模型的**思考过程**透传给浏览器（P11）。未设置 = 默认开，只有显式的 false 才关
   * （见 policy.js 的 `SHOW_REASONING_FIELD`）。关掉时宿主**根本不发** reasoning 增量，
   * 而不是"发了不显示"——思考正文因此不出宿主。
   */
  [SHOW_REASONING_FIELD]: z.boolean().volatile(),
  /**
   * 优化时使用的**思考强度**（调用参数之一，对所有模型生效）。未设置 = 内置 `low`（见
   * policy.js 的 `DEFAULT_REASONING_EFFORT`）：与其它字段同一条规矩——未设置就回落到默认，
   * 而不是往设置文档里写一个恰好等于默认值的字符串。
   * 这里是 `z.string()` 而不是枚举：强度 id 归适配器所有（opaque），白名单会把新适配器挡在门外。
   */
  [DEFAULT_REASONING_EFFORT_FIELD]: z.string().volatile(),
  /**
   * 各优化风格的独立提示词：留空 = 回落到组合配置里同 id 的预设，再往下是内置默认。
   * 风格 id 是内置常量（`STYLE_DEFINITIONS`），所以这里能给出**静态**字段名。
   */
  ...stylePromptFields,
  /**
   * 追加提示词（可切换的追加提示词）。整个列表是**一个数组字段**：设置通道的 path ops
   * 允许对单字段 set 任意 JSON 值，整表一次 set 天然原子，也不需要为每个追加提示词留静态字段名。
   * 项内的组合规则（三全非空、id 唯一、数量上限）由 `validateSettingsSection` 负责，schema 只管形状。
   */
  [PROMPT_PROFILES_FIELD]: z.array(z.object({
    id: z.string(),
    name: z.string(),
    prompt: z.string(),
  })).volatile(),
  /** 当前启用的追加条目 id；空串/缺省 = 不追加（走默认提示词链）。 */
  [ACTIVE_PROFILE_FIELD]: z.string().volatile(),
})
