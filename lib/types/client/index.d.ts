/**
 * better-input —— 浏览器半类型。
 *
 * 座位组件的真实 props 由框架三段合并而成（ui-slots 的 PropsRuntime）：
 *   owner props（InputZone: session/input）+ 会话标准道具（useInput/inputActions/sessionId…）
 *   + 本插件的 inject 面 + locale 的 t。
 * 完整类型要 import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
 * 并依赖 ui-conversation 的 SlotMap/SessionStandardProps 合并；这里用结构化描述代替，
 * 保证没有安装 DSH 依赖时也能被编辑器打开。
 */

/** 座位组件收到的、本插件真正用到的那部分道具。 */
export interface BetterInputProps {
  /** locale 座位（注册时 `locale: 'inputOptimizer'` 注入）。 */
  t: (key: string) => string
  /** 会话输入机状态选择器钩子（框架注入）。 */
  useInput: <T>(selector: (state: BetterInputState) => T) => T
  /** 公开输入动作面（框架注入）——写回草稿的唯一正确入口。 */
  inputActions: { setDraft: (text: string) => void }
  /** 框架解析出的会话 id。 */
  sessionId: string
  /** 输入区 owner props 的点快照。 */
  input: BetterInputState
}

/** InputState 中本插件用到的字段。 */
export interface BetterInputState {
  /** 剪贴板投影的草稿全文（芯片已展开）。 */
  readonly draft: string
  /** 单调编辑器修订号（CAS 基准）。 */
  readonly draftRev: number
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  /** 编辑器里的芯片出现位置；非空意味着整体 setDraft 会把引用拉平成纯文本。 */
  readonly occurrences: readonly unknown[]
}

/** 需要就绪的客户端服务。 */
export declare const inject: readonly ['slots', 'locale']

/**
 * 浏览器半入口。
 * @param ctx - 浏览器端 cordis 上下文。
 */
export declare function apply(ctx: unknown): void

/** 宿主路由（与宿主半 lib/policy.js 的 ROUTE 一致）。 */
export declare const ROUTE = '/api/dsh-input-optimizer/optimize'

/** 座位 key：模型选择器紧左边。 */
export declare const SEAT = 'conversation.input.right'
