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
  /** 会话输入机状态选择器钩子（框架注入，ui-conversation 的 kit 合并）。 */
  useInput: <T>(selector: (state: BetterInputState) => T) => T
  /** 公开输入动作面（框架注入）——写回草稿的唯一正确入口。 */
  inputActions: { setDraft: (text: string) => void }
  /** 框架解析出的会话 id（ui-session 的 kit 合并；缺包时实现回落到 'current'）。 */
  sessionId: string
  /**
   * 输入区 owner props 点快照——**只有新版本 dsh 才给 `conversation.input.left/right` 传**。
   * 已安装的 0.1.2-rc.1 传的是 `renderSlot(name, {})`，这里必然是 undefined：
   * 所以状态一律从 `useInput` 读，`input` 仅作为可选加速项。
   */
  input?: BetterInputState
}

/** InputState 中本插件用到的字段。 */
export interface BetterInputState {
  /** 剪贴板投影的草稿全文（芯片已展开）。 */
  readonly draft: string
  /** 单调编辑器修订号（CAS 基准）。 */
  readonly draftRev: number
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  /** 编辑器里的芯片出现位置；非空意味着整体 setDraft 会把引用拉平成纯文本 → 本插件拒绝优化。 */
  readonly occurrences: readonly unknown[]
}

/**
 * 组件行为契约（与实现、测试一一对应）：
 *
 * - 点击 → `POST /api/dsh-input-optimizer/optimize`（body `{ text, sessionId }`），
 *   生成中再点 = 取消（abort，宿主侧同时取消上游模型调用）。
 * - 返回后做 CAS（`draftRev` + 文本双比对），草稿在往返期间被改过就丢弃结果。
 * - 成功后 `inputActions.setDraft(text)` 写回，并压入撤销栈。
 * - 撤销按钮只在栈非空时渲染；CAS（"当前草稿仍等于 `after`"）通过才回退，
 *   不通过时同一条记录连点两次强制还原。
 * - 撤销栈按会话隔离、深度 10、最多保留 20 个会话（LRU：会话被删除时没有任何通知能到达插件）、
 *   仅存活于插件生命周期（不进 React state，避免重挂载丢栈）。
 * - 草稿含芯片（`occurrences` 非空）或输入机非 `plain` 时拒绝发起。
 *   （`occurrences` 只覆盖 `@引用` 芯片；`/命令` 是纯文本，不在其中。）
 */
export interface BetterInputBehavior {
  /** 宿主路由。 */
  route: '/api/dsh-input-optimizer/optimize'
  /** 每会话撤销栈深度。 */
  maxUndo: 10
  /** 同时保留撤销栈的会话数上限（LRU）。 */
  maxUndoSessions: 20
  /** 生成中是否可取消。 */
  cancellable: true
}

/** 需要就绪的客户端服务。 */
export declare const inject: readonly ['slots', 'locale', 'settingsScope']

/**
 * 浏览器半入口：注册输入框按钮（`conversation.input.right`）与设置页分区（`settings.section`）。
 * @param ctx - 浏览器端 cordis 上下文。
 */
export declare function apply(ctx: unknown): void

/** 宿主路由（与宿主半 lib/policy.js 的一组常量一致）。 */
export declare const ROUTE = '/api/dsh-input-optimizer/optimize'
export declare const ROUTE_CATALOG = '/api/dsh-input-optimizer/catalog'
export declare const ROUTE_CATALOG_MODELS = '/api/dsh-input-optimizer/catalog/models'
export declare const ROUTE_CHECK = '/api/dsh-input-optimizer/check'

/** 座位 key：模型选择器紧左边。 */
export declare const SEAT = 'conversation.input.right'

/** 设置页在设置面板导航里的条目 id。 */
export declare const SETTINGS_SECTION_ID = 'better-input'

/**
 * 设置页的注入面（注册时 `inject` 工厂返回的对象会摊成组件 props）：
 * `props.settings` / `props.t` / `props.catalog`。
 */
export interface BetterInputSettingsInjected {
  /** 绑定到 `better-input` 命名空间的设置作用域（读快照、订阅、mutate）。 */
  settings: {
    getSnapshot: () => {
      status: 'loading' | 'ready' | 'unavailable'
      value: Partial<Record<string, unknown>> | undefined
      revision: number | undefined
      writable: boolean
      mode: 'host' | 'memory'
    }
    subscribe: (listener: () => void) => () => void
    /**
     * path ops 原子提交。
     *
     * **注意**：宿主拒绝（revision 冲突 / schema+validate 不过）时**不会 reject**——
     * 真实实现只 `recover()` 后正常返回，只有装配错误才抛。所以调用方必须自己核对
     * 镜像里的值是否真的变了（设置页用 `opsApplied()` 做这件事），否则会假报"已保存"。
     */
    mutate: (ops: ReadonlyArray<{ op: 'set' | 'unset', path: string[], value?: unknown }>, expectedRevision?: number) => Promise<void>
  }
  /** 本插件词典绑定。 */
  t: (key: string) => string
  /** 宿主只读路由门面。 */
  catalog: {
    load: () => Promise<{
      providers?: Array<{ id: string, name: string }>
      /** 设置命名空间状态：`available=false` 时 `reason` 是宿主侧原因（注册失败消息），用于排查。 */
      settings?: { available?: boolean, reason?: string, section?: Record<string, unknown> }
      effective?: Record<string, unknown>
    }>
    models: (provider: string) => Promise<Array<{ id: string, name: string }>>
    check: (provider: string, model: string) => Promise<{ ok?: boolean, message?: string, name?: string, context?: number, defaultMaxTokens?: number }>
  }
}
