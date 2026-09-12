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
 * - **工具行只有两个控件（P12）**：✦ 优化（生成中 = 取消）与 ▾ 统一菜单。
 *   撤销、思考回看、追加提示词、预设全在 ▾ 菜单里；▾ 在有"本次调用的产物"（可撤销 / 可回看的思考）
 *   或目录数据时渲染，**不依赖 `/catalog` 单独决定**（否则目录失败会连撤销入口一起吞掉）。
 * - 可撤销时 ▾ 带 `data-undo="available"` 角标（圆点，只表达状态、不承担点击）。
 * - 撤销项在菜单的「本次调用」分区里，只在栈非空时渲染；CAS（"当前草稿仍等于 `after`"）通过才回退，
 *   不通过时同一条记录连点两次强制还原——**第一次点击后菜单保持展开**、菜单项文案变为强制还原
 *   （因此 `onUndo` 的返回值表示"是否真的执行了还原"，菜单据此决定收不收）。
 * - 撤销栈按会话隔离、深度 10、最多保留 20 个会话（LRU：会话被删除时没有任何通知能到达插件）、
 *   仅存活于插件生命周期（不进 React state，避免重挂载丢栈）。
 * - 草稿含芯片（`occurrences` 非空）或输入机非 `plain` 时拒绝发起。
 *   （`occurrences` 只覆盖 `@引用` 芯片；`/命令` 是纯文本，不在其中。）
 * - ▾ 菜单三个分区，顺序为「本次调用」（撤销 / 查看思考过程）→ 追加提示词（**单选**，含内置种子
 *   「精简/转规格」；点击把 `activeProfileId` 写进设置并落盘，被选中的那条会接在系统提示词之后，
 *   下一次优化生效）→ 预设（单次，请求带 `presetId`）。
 *   旧版浏览器半的「多选风格 + styleIds」已并入追加提示词；宿主仍兼容旧客户端的 styleIds 请求。
 * - 优化中显示进度行（阶段 `waiting`/`thinking`/`writing` + 本地时钟算出的耗时 + 该阶段字数），
 *   阶段由收到的事件推导（首个思考增量 → thinking，首个文本增量 → writing）；**不给百分比**
 *   （`maxOutputTokens` 是上限不是目标）。生成中图标带透明度呼吸。
 * - **成功不弹提示（P12）**：草稿被替换肉眼可见；只有界面上看不出来的结果才提示（截断 / 失败 /
 *   已还原原文 / 草稿已变化）。
 * - 思考增量（SSE `event: reasoning`）只进展示 state：出现第一段即自动展开面板（只自动展开一次），
 *   收尾（成功/失败/取消）自动收起，之后从菜单的「查看思考过程（n 字）」回看；
 *   正文最多保留尾部若干字、被截断时明确说明。
 *   **思考文本绝不进草稿与撤销栈**（宿主装配权威文本时也只取 text 块）。
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
export declare const ROUTE_STREAM = '/api/dsh-input-optimizer/optimize/stream'
export declare const ROUTE_CATALOG = '/api/dsh-input-optimizer/catalog'
export declare const ROUTE_CATALOG_MODELS = '/api/dsh-input-optimizer/catalog/models'
export declare const ROUTE_CHECK = '/api/dsh-input-optimizer/check'
export declare const ROUTE_OPEN_CONFIG = '/api/dsh-input-optimizer/open-config'

/** 内置优化风格 id（客户端镜像；与宿主 `STYLE_IDS` 有跨包对拍用例钉住）。 */
export declare const STYLE_IDS: readonly string[]

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
      /** 内置优化风格：只有 id/label/**生效来源**，提示词正文留在宿主（旧版浏览器半的兼容面）。 */
      styles?: Array<{ id: string, label?: string, source?: 'settings' | 'config' | 'default' }>
      /** 追加提示词行（内置种子在前）：只有 id/名称/来源/是否内置，正文留在宿主。 */
      profiles?: Array<{ id: string, name: string, source?: string, builtIn?: boolean }>
      /** 内置/组合层的默认系统提示词：设置页要"可见可编辑"，这一段有意下发。 */
      defaults?: { systemPrompt?: string }
      /** 插件配置文件的绝对路径（宿主按自己的模块位置解析），给「打开配置文件」用。 */
      configPath?: string
      effective?: Record<string, unknown>
    }>
    models: (provider: string) => Promise<Array<{ id: string, name: string }>>
    check: (provider: string, model: string) => Promise<{ ok?: boolean, message?: string, name?: string, context?: number, defaultMaxTokens?: number }>
    /**
     * 请宿主用系统默认程序打开插件配置文件。
     * 失败时 `message` 是宿主给的可展示原因（找不到文件 / 平台不支持 / 起不来），一定带绝对路径。
     */
    openConfig: () => Promise<{ ok: boolean, path?: string, openedWith?: string, message?: string }>
  }
}
