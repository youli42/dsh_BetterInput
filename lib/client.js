/**
 * better-input —— 浏览器半。
 *
 * 职责（P0→P3 已实现）：
 *   1. 往 ui-conversation 的 `conversation.input.right` 座位（模型选择器紧左边）注册条目；
 *   2. 读草稿（框架注入的 `useInput` + owner props `input`），调宿主路由拿优化文本，
 *      用 `inputActions.setDraft()` 写回；
 *   3. 每次成功替换压一条撤销记录，撤销时用 CAS 校验后回退（支持连按逐层回退）。
 *
 * 红线：不碰 DOM 输入框。已安装版本的 composer 是 Lexical contenteditable + 芯片节点，
 * 官方契约是 `InputState.draft`（读）与 `InputActions.setDraft()`（写）。
 *
 * 形态说明：客户端 bundle 是 `window.__ModuleLoader__.load({ id, factory })` 的 CJS 工厂，
 * 可以手写、无需构建工具。工厂里只能 `require` 平台种子模块
 * （react / react-dom / cordis / dsh-client-store / dsh-client-ui-slots / dsh-client-ui-primitives），
 * 跨插件的值导入在构建期就是错误——所以本文件不 import 任何 DSH 客户端包。
 */
window.__ModuleLoader__.load({
  /** 必须等于包名（宿主按包名组合 boot graph）。 */
  id: 'dsh-better-input',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** 座位：模型选择器紧左边（`InputBar.tsx` 的 `.trailing` 组里 rightItems 先于 model 座渲染）。 */
    const SEAT = 'conversation.input.right'
    /** 条目 id（list 座位必需，同一 id/priority 重复注册会抛错）。 */
    const ENTRY_ID = 'better-input'
    /** 同组内排序：数字小的靠左。 */
    const ORDER = 10
    /** 词典命名空间。 */
    const NS = 'inputOptimizer'
    /** 宿主路由（与 lib/policy.js 的 ROUTE 保持一致）。 */
    const ROUTE = '/api/dsh-input-optimizer/optimize'
    /** 样式标签 id（HMR 重载时按 id 去重/回收）。 */
    const STYLE_ID = 'dsh-better-input-style'
    /** 每会话撤销栈深度（客户端读不到插件配置，见 DESIGN.md R-10；与宿主默认值保持一致）。 */
    const MAX_UNDO = 10
    /** 各语气提示的停留时长（毫秒）；错误留久一点。 */
    const NOTE_MS = { ok: 3000, warn: 5000, error: 7000 }

    /* ── 设置页（P4）─────────────────────────────────────────────────────── */

    /** 设置命名空间：与宿主 `ctx.settings.register` 用的是同一个（lib/policy.js）。 */
    const SETTINGS_NAMESPACE = 'better-input'
    /** 设置页在导航里的条目 id。 */
    const SETTINGS_SECTION_ID = 'better-input'
    /** 导航排序：排在模型(10)/通用之后。 */
    const SETTINGS_SECTION_ORDER = 60
    /** 设置段的扁平字段清单（与宿主 schema 一一对应）。 */
    const FIELD_KEYS = [
      'customPromptEnabled',
      'systemPrompt',
      'modelProvider',
      'modelId',
      'temperature',
      'maxOutputTokens',
      'timeoutMs',
    ]
    /** 设置页首屏的数据来源（宿主只读路由）。 */
    const ROUTE_CATALOG = '/api/dsh-input-optimizer/catalog'
    const ROUTE_CATALOG_MODELS = '/api/dsh-input-optimizer/catalog/models'
    const ROUTE_CHECK = '/api/dsh-input-optimizer/check'

    /** 图标走平台种子模块；缺失时降级为文字符号，避免整个条目抛错被边界回收。 */
    const IconSparkle = primitives.IconSparkle16 ?? null
    const IconLoading = primitives.IconLoadingOutline16 ?? null
    const IconUndo = primitives.IconRefreshOutline14 ?? null

    const zh = {
      optimize: '优化输入',
      cancel: '取消优化',
      undo: '撤销上次优化',
      undone: '已撤销，回到优化前的草稿',
      undoneForced: '已强制还原优化前的草稿',
      undoDirty: '草稿在优化后已被修改；再点一次可强制还原原文',
      undoEmpty: '没有可撤销的优化',
      empty: '输入框是空的，先写点内容',
      busy: '当前输入正在提交或等待处理',
      chips: '草稿里有 @引用 或 /命令 芯片，整体替换会丢引用，请先删掉它们',
      done: '已替换为优化结果',
      doneTruncated: '结果被输出上限截断，已替换',
      staleResult: '草稿在优化过程中被修改，结果已丢弃',
      emptyResult: '模型没有返回可用文本',
      network: '请求失败：无法连接宿主路由',
      forbidden: '宿主拒绝：这条路由只服务本机浏览器',
      notMounted: '宿主路由未挂载（插件宿主半未启用？）',
      server: '宿主返回错误',
      fail: '优化失败',

      // ── 设置页 ──
      'settings.nav': '输入优化',
      'settings.title': '输入优化',
      'settings.intro': '按钮出现在输入框工具行、模型选择器左侧。这里配置它用哪个模型、哪段提示词。',
      'settings.unavailable': '设置服务不可用：宿主端没有挂载设置提供者（或插件宿主半未加载）。配置无法保存，但优化按钮仍用默认模型与默认提示词工作。',
      'settings.readonly': '当前连接不接受写入（远程页面可能是进程内模式），因此无法保存设置。',
      'settings.prompt.legend': '提示词',
      'settings.prompt.enable': '使用自定义提示词',
      'settings.prompt.enableHint': '关闭时使用默认提示词（内置文案或插件配置里的 systemPrompt）',
      'settings.prompt.body': '提示词内容',
      'settings.prompt.placeholder': '例如：你是提示词工程师，把用户草稿改写成更清晰、无歧义、可执行的任务描述……',
      'settings.prompt.effective': '当前生效：自定义提示词',
      'settings.model.legend': '模型',
      'settings.model.provider': 'Provider',
      'settings.model.providerPlaceholder': '留空则使用默认模型',
      'settings.model.id': '模型名称',
      'settings.model.idPlaceholder': '留空则使用默认模型',
      'settings.model.customOption': '（不在目录中，按手填处理）',
      'settings.model.listHint': '目录来自宿主已注册的适配器；目录为空时可直接手填模型名称。',
      'settings.model.none': '未配置（使用当前默认模型）',
      'settings.model.effective': '当前生效',
      'settings.model.test': '测试',
      'settings.model.testing': '测试中…',
      'settings.model.testOk': '可以调用',
      'settings.model.testFail': '无法调用',
      'settings.params.legend': '调用参数',
      'settings.params.temperature': 'Temperature',
      'settings.params.temperaturePlaceholder': '留空 = 用适配器默认值',
      'settings.params.maxOutputTokens': '输出 token 上限',
      'settings.params.timeoutMs': '超时（毫秒）',
      'settings.params.placeholder': '留空 = 默认',
      'settings.save': '保存',
      'settings.saving': '保存中…',
      'settings.reset': '恢复默认',
      'settings.resetting': '恢复中…',
      'settings.resetHint': '清空本页所有用户设置，回到内置默认与组合配置的值',
      'settings.saved': '已保存，下一次优化即生效',
      'settings.noChange': '没有需要保存的改动',
      'settings.saveFailed': '保存失败',
      'settings.resetDone': '已恢复默认值',
      'settings.resetFailed': '恢复默认失败',
      'settings.invalid': '有字段不合规，未保存',
      'settings.source.settings': '设置页',
      'settings.source.config': '插件配置',
      'settings.source.default': '内置默认',
      'settings.source.none': '未配置',
      'settings.err.promptEmpty': '已启用自定义提示词，请填写内容（或关闭开关）',
      'settings.err.modelPair': 'provider 与模型名称必须同时填写，或同时留空',
      'settings.err.temperature': 'temperature 需为 0 到 2 之间的数字',
      'settings.err.maxOutputTokens': '输出 token 上限需为不小于 1 的整数',
      'settings.err.timeoutMs': '超时需为不小于 1000 的整数（毫秒）',
      'settings.err.loadCatalog': '读取模型目录失败，可手动填写模型名称',
    }
    const en = {
      optimize: 'Optimize input',
      cancel: 'Cancel optimization',
      undo: 'Undo last optimization',
      undone: 'Reverted to the draft from before optimization',
      undoneForced: 'Force-restored the pre-optimization draft',
      undoDirty: 'The draft changed after optimization; click again to force-restore',
      undoEmpty: 'Nothing to undo',
      empty: 'The input box is empty',
      busy: 'The composer is busy',
      chips: 'The draft has @reference or /command chips; replacing it wholesale would drop them',
      done: 'Replaced with the optimized text',
      doneTruncated: 'Output hit the token cap; replaced',
      staleResult: 'The draft changed while optimizing; the result was discarded',
      emptyResult: 'The model returned no usable text',
      network: 'Request failed: cannot reach the host route',
      forbidden: 'Host refused: this route serves the local browser only',
      notMounted: 'The host route is not mounted (host half disabled?)',
      server: 'The host returned an error',
      fail: 'Optimization failed',

      // ── settings page ──
      'settings.nav': 'Input optimizer',
      'settings.title': 'Input optimizer',
      'settings.intro': 'The button sits in the composer tool row, just left of the model selector. Configure which model and which prompt it uses here.',
      'settings.unavailable': 'Settings service unavailable: this deployment mounts no settings provider (or the host half is not loaded). Values cannot be saved, but the button keeps working with the default model and prompt.',
      'settings.readonly': 'This connection does not accept writes (a remote page may run in memory mode), so settings cannot be saved.',
      'settings.prompt.legend': 'Prompt',
      'settings.prompt.enable': 'Use a custom prompt',
      'settings.prompt.enableHint': 'Off uses the default prompt (built-in text or the systemPrompt from the plugin config)',
      'settings.prompt.body': 'Prompt text',
      'settings.prompt.placeholder': 'e.g. You are a prompt engineer: rewrite the draft into a clearer, unambiguous, actionable task…',
      'settings.prompt.effective': 'Currently effective: custom prompt',
      'settings.model.legend': 'Model',
      'settings.model.provider': 'Provider',
      'settings.model.providerPlaceholder': 'Empty uses the default model',
      'settings.model.id': 'Model name',
      'settings.model.idPlaceholder': 'Empty uses the default model',
      'settings.model.customOption': '(not in the catalog — used as typed)',
      'settings.model.listHint': 'The catalog comes from the adapters registered in the host; type a model name when it is empty.',
      'settings.model.none': 'Not configured (the current default model is used)',
      'settings.model.effective': 'Effective now',
      'settings.model.test': 'Test',
      'settings.model.testing': 'Testing…',
      'settings.model.testOk': 'callable',
      'settings.model.testFail': 'not callable',
      'settings.params.legend': 'Call parameters',
      'settings.params.temperature': 'Temperature',
      'settings.params.temperaturePlaceholder': 'Empty = adapter default',
      'settings.params.maxOutputTokens': 'Max output tokens',
      'settings.params.timeoutMs': 'Timeout (ms)',
      'settings.params.placeholder': 'Empty = default',
      'settings.save': 'Save',
      'settings.saving': 'Saving…',
      'settings.reset': 'Restore defaults',
      'settings.resetting': 'Restoring…',
      'settings.resetHint': 'Clear every user value on this page and fall back to the built-in and composition defaults',
      'settings.saved': 'Saved; the next optimization uses it',
      'settings.noChange': 'Nothing to save',
      'settings.saveFailed': 'Save failed',
      'settings.resetDone': 'Defaults restored',
      'settings.resetFailed': 'Restore failed',
      'settings.invalid': 'Some fields are invalid; nothing was saved',
      'settings.source.settings': 'this page',
      'settings.source.config': 'plugin config',
      'settings.source.default': 'built-in default',
      'settings.source.none': 'not configured',
      'settings.err.promptEmpty': 'The custom prompt is enabled but empty (fill it in or turn the switch off)',
      'settings.err.modelPair': 'Fill in both provider and model name, or leave both empty',
      'settings.err.temperature': 'Temperature must be a number between 0 and 2',
      'settings.err.maxOutputTokens': 'Max output tokens must be an integer of at least 1',
      'settings.err.timeoutMs': 'Timeout must be an integer of at least 1000 ms',
      'settings.err.loadCatalog': 'Could not read the model catalog; type the model name manually',
    }

    /** 组件样式：优先复用 GUI 的设计令牌，令牌缺失时回落到 currentColor 派生值。 */
    const CSS = [
      // 工具行右侧本来就拥挤（模型座 + 上下文计量 + 发送键），所以本条目必须可收缩。
      `.dsh-better-input-wrap{display:inline-flex;align-items:center;gap:6px;min-width:0;flex:0 1 auto}`,
      `.dsh-better-input{display:inline-flex;align-items:center;justify-content:center;flex:none;`,
      `height:24px;min-width:24px;padding:0 6px;border:0;border-radius:6px;background:transparent;`,
      `color:var(--dsw-alias-label-secondary,currentColor);opacity:.8;cursor:pointer;font:inherit;`,
      `font-size:12px;line-height:1}`,
      `.dsh-better-input:hover:not(:disabled){opacity:1;color:var(--dsw-alias-label-primary,currentColor);`,
      `background:var(--dsw-alias-button-tool-bar-hover,color-mix(in srgb,currentColor 12%,transparent))}`,
      `.dsh-better-input:disabled{opacity:.35;cursor:default}`,
      `.dsh-better-input[data-state="running"]{opacity:1}`,
      `.dsh-better-input__note{min-width:0;max-width:min(240px,28vw);overflow:hidden;text-overflow:ellipsis;`,
      `white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary,currentColor)}`,
      `.dsh-better-input__note[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,currentColor)}`,
      `.dsh-better-input__note[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary,currentColor)}`,
      `.dsh-better-input__note[data-tone="error"]{color:var(--dsw-alias-state-error-primary,currentColor)}`,

      // ── 设置页：复用同一套设计令牌 ──
      `.dsh-bi-form{display:flex;flex-direction:column;gap:18px;max-width:620px;`,
      `font-size:13px;color:var(--dsw-alias-label-primary,currentColor)}`,
      `.dsh-bi-intro{margin:0;color:var(--dsw-alias-label-secondary,currentColor);line-height:1.6}`,
      `.dsh-bi-fieldset{display:flex;flex-direction:column;gap:10px;margin:0;padding:14px;`,
      `border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 18%,transparent));border-radius:10px}`,
      `.dsh-bi-legend{padding:0 6px;font-weight:600;color:var(--dsw-alias-label-secondary,currentColor)}`,
      `.dsh-bi-row{display:flex;flex-direction:column;gap:4px}`,
      `.dsh-bi-label{color:var(--dsw-alias-label-secondary,currentColor);font-size:12px}`,
      `.dsh-bi-hint{color:var(--dsw-alias-label-tertiary,currentColor);font-size:11px;line-height:1.5}`,
      `.dsh-bi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}`,
      `.dsh-bi-input,.dsh-bi-select,.dsh-bi-textarea{width:100%;box-sizing:border-box;font:inherit;font-size:13px;`,
      `padding:6px 8px;border-radius:8px;color:var(--dsw-alias-label-primary,currentColor);`,
      `background:var(--dsw-alias-bg-layer-2,transparent);`,
      `border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 20%,transparent))}`,
      `.dsh-bi-textarea{min-height:140px;resize:vertical;line-height:1.6}`,
      `.dsh-bi-input:disabled,.dsh-bi-select:disabled,.dsh-bi-textarea:disabled{opacity:.6}`,
      `.dsh-bi-error{color:var(--dsw-alias-state-error-primary,currentColor);font-size:11px}`,
      `.dsh-bi-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}`,
      `.dsh-bi-button{font:inherit;font-size:13px;padding:6px 14px;border-radius:8px;cursor:pointer;`,
      `border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 20%,transparent));`,
      `background:var(--dsw-alias-button-elevated-fill,transparent);color:inherit}`,
      `.dsh-bi-button[data-variant="primary"]{border-color:transparent;`,
      `background:var(--dsw-alias-button-primary-fill,color-mix(in srgb,currentColor 16%,transparent));`,
      `color:var(--dsw-alias-label-primary-foreground,inherit)}`,
      `.dsh-bi-button:disabled{opacity:.5;cursor:default}`,
      `.dsh-bi-note{font-size:12px;line-height:1.5}`,
      `.dsh-bi-note[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,currentColor)}`,
      `.dsh-bi-note[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary,currentColor)}`,
      `.dsh-bi-note[data-tone="error"]{color:var(--dsw-alias-state-error-primary,currentColor)}`,
      `.dsh-bi-check{display:flex;align-items:center;gap:8px;font-size:13px}`,
      `.dsh-bi-effective{font-size:12px;color:var(--dsw-alias-label-secondary,currentColor)}`,
      `.dsh-bi-effective code{font-family:var(--ds-font-family-code,monospace)}`,
    ].join('')

    /** 幂等地注入样式表。 */
    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.append(style)
    }

    /* ── 撤销栈：模块级、按会话隔离（插件生命周期内有效，不随组件重挂载丢失） ── */

    /** @type {Map<string, Array<{ before: string, after: string, rev: number, at: number }>>} */
    const undoStacks = new Map()

    /**
     * 取（必要时创建）某会话的撤销栈。
     * @param {string} sessionId - 会话 id。
     * @returns {Array<object>} 撤销栈。
     */
    function stackFor(sessionId) {
      let stack = undoStacks.get(sessionId)
      if (stack === undefined) {
        stack = []
        undoStacks.set(sessionId, stack)
      }
      return stack
    }

    /**
     * 取栈顶记录。
     * @param {string} sessionId - 会话 id。
     * @returns {object | null} 栈顶记录。
     */
    function peekUndo(sessionId) {
      const stack = undoStacks.get(sessionId)
      return stack === undefined || stack.length === 0 ? null : stack[stack.length - 1]
    }

    /**
     * 压入一条记录，超出深度丢最旧的。
     * @param {string} sessionId - 会话 id。
     * @param {{ before: string, after: string, rev: number, at: number }} entry - 记录。
     * @returns {void}
     */
    function pushUndo(sessionId, entry) {
      const stack = stackFor(sessionId)
      stack.push(entry)
      while (stack.length > MAX_UNDO) stack.shift()
    }

    /**
     * 弹出栈顶记录。
     * @param {string} sessionId - 会话 id。
     * @returns {object | null} 被弹出的记录。
     */
    function popUndo(sessionId) {
      const stack = undoStacks.get(sessionId)
      if (stack === undefined) return null
      const entry = stack.pop() ?? null
      if (stack.length === 0) undoStacks.delete(sessionId)
      return entry
    }

    /* ── 宿主路由调用 ── */

    /**
     * 按 HTTP 状态码给一句兜底说明（响应体带 message 时优先用它的）。
     * @param {number} status - 状态码。
     * @param {(key: string) => string} t - 词典。
     * @returns {string} 说明文本。
     */
    function statusMessage(status, t) {
      if (status === 403) return t('forbidden')
      if (status === 404) return t('notMounted')
      return `${t('server')} (HTTP ${String(status)})`
    }

    /**
     * 调宿主路由做一次优化。
     * @param {{ text: string, sessionId?: string, signal: AbortSignal, t: (key: string) => string }} call - 调用参数。
     * @returns {Promise<{ ok: true, text: string, truncated: boolean } | { ok: false, message: string }>} 结果。
     */
    async function requestOptimize(call) {
      let response
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: call.text,
            ...call.sessionId === undefined ? {} : { sessionId: call.sessionId },
          }),
          signal: call.signal,
        })
      } catch (error) {
        // 取消是调用方的正常路径，交给上层判定；其余是网络层失败。
        if (call.signal.aborted) throw error
        return { ok: false, message: call.t('network') }
      }
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok) {
        const message = data !== null && typeof data.message === 'string' && data.message !== ''
          ? data.message
          : statusMessage(response.status, call.t)
        return { ok: false, message }
      }
      if (data === null || typeof data.text !== 'string' || data.text.trim() === '') {
        return { ok: false, message: call.t('emptyResult') }
      }
      return { ok: true, text: data.text, truncated: data.truncated === true }
    }

    /**
     * 座位条目组件：撤销按钮 + 优化按钮 + 一行状态提示。
     *
     * 框架注入的标准道具（会话作用域，`SessionStandardProps`）：
     * `useInput`、`inputActions`（ui-conversation 合并）、`sessionId`、`useSession`、`useProjection`
     * （ui-session 合并）；本插件另有词典 `t`。
     *
     * **注意 owner props**：已安装版本（0.1.2-rc.1）对 `conversation.input.left/right` 调的是
     * `renderSlot(name, {})`——**没有任何 owner props**（只有 `conversation.input.dock` 拿得到
     * `InputZone`）。所以输入状态只能从 `useInput` 读，绝不能读 `props.input`（新版本源码才把它
     * 传给 left/right，属于版本差异，见 DESIGN.md R-3/R-13）。
     * @param {object} props - 组件道具。
     * @returns {object} React 元素。
     */
    function BetterInputButton(props) {
      const t = props.t
      // 无条件调用 hook（hook 顺序稳定）；新版本传了 owner 快照就用它，语义与 hook 值一致。
      const hooked = props.useInput((state) => state)
      const input = props.input ?? hooked
      const draft = input.draft
      const phase = input.phase
      // 老版本 InputState 可能没有 occurrences，缺字段按「无芯片」处理。
      const occurrences = input.occurrences ?? []

      const [running, setRunning] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [, setStackVersion] = React.useState(0)

      const alive = React.useRef(true)
      const abort = React.useRef(null)
      /**
       * 异步路径读取口：每次渲染写入最新值。
       * 异步回调里读闭包里的 props 会拿到过期数据（点快照/闭包陷阱），
       * 所以 CAS 判断、撤销校验、写回都必须走这个 ref。
       */
      const live = React.useRef(null)
      live.current = { input, inputActions: props.inputActions }
      /** 已就绪的「强制还原」目标：同一条记录连点两次才生效。 */
      const forceArmed = React.useRef(null)

      React.useEffect(() => () => {
        alive.current = false
        abort.current?.abort()
      }, [])

      const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : 'current'
      const top = peekUndo(sessionId)
      const undoClean = top !== null && top.after === draft

      /**
       * 显示一条带语气的提示，到点自动消失。
       * @param {string} text - 提示正文。
       * @param {'ok' | 'warn' | 'error'} tone - 语气。
       * @returns {void}
       */
      const flash = (text, tone) => {
        setNote({ text, tone })
        window.setTimeout(() => { if (alive.current) setNote(null) }, NOTE_MS[tone] ?? NOTE_MS.ok)
      }

      const busy = phase !== 'plain'
      const empty = draft.trim() === ''

      /** 发起优化；生成中再次点击 = 取消。 */
      const onOptimize = async () => {
        if (running) {
          abort.current?.abort()
          return
        }
        const current = live.current.input
        if (current.phase !== 'plain') { flash(t('busy'), 'warn'); return }
        if (current.draft.trim() === '') { flash(t('empty'), 'warn'); return }
        // 整体 setDraft 会把芯片拉平成纯文本，宁可不做也不悄悄毁掉引用。
        if ((current.occurrences ?? []).length > 0) { flash(t('chips'), 'warn'); return }

        const before = current.draft
        const rev = current.draftRev
        const controller = new AbortController()
        abort.current = controller
        forceArmed.current = null
        setRunning(true)
        try {
          const outcome = await requestOptimize({ text: before, sessionId, signal: controller.signal, t })
          if (!alive.current || controller.signal.aborted) return
          if (!outcome.ok) { flash(outcome.message, 'error'); return }
          const now = live.current.input
          // CAS：草稿在往返期间被改动过就丢弃结果，绝不覆盖用户此刻的输入。
          if (now.draft !== before || now.draftRev !== rev) { flash(t('staleResult'), 'warn'); return }
          live.current.inputActions.setDraft(outcome.text)
          pushUndo(sessionId, { before, after: outcome.text, rev, at: Date.now() })
          setStackVersion((version) => version + 1)
          flash(outcome.truncated ? t('doneTruncated') : t('done'), 'ok')
        } catch {
          if (!controller.signal.aborted) flash(t('fail'), 'error')
        } finally {
          if (abort.current === controller) abort.current = null
          if (alive.current) setRunning(false)
        }
      }

      /** 撤销栈顶记录；CAS 不通过时同一条记录连点两次强制还原。 */
      const onUndo = () => {
        const entry = peekUndo(sessionId)
        if (entry === null) { flash(t('undoEmpty'), 'warn'); return }
        const forced = live.current.input.draft !== entry.after
        if (forced && forceArmed.current !== entry) {
          forceArmed.current = entry
          flash(t('undoDirty'), 'warn')
          return
        }
        live.current.inputActions.setDraft(entry.before)
        popUndo(sessionId)
        forceArmed.current = null
        setStackVersion((version) => version + 1)
        flash(forced ? t('undoneForced') : t('undone'), 'ok')
      }

      const disabled = busy || empty
      const title = note !== null
        ? note.text
        : disabled ? (empty ? t('empty') : t('busy')) : t('optimize')

      const children = []
      if (note !== null) {
        children.push(React.createElement('span', {
          key: 'note',
          className: 'dsh-better-input__note',
          'data-tone': note.tone,
        }, note.text))
      }
      if (top !== null) {
        children.push(React.createElement('button', {
          key: 'undo',
          type: 'button',
          className: 'dsh-better-input',
          'data-dsh-better-input-undo': ENTRY_ID,
          'data-state': undoClean ? 'clean' : 'dirty',
          'aria-label': t('undo'),
          title: undoClean ? t('undo') : t('undoDirty'),
          onMouseDown: (event) => { event.preventDefault() },
          onClick: onUndo,
        }, IconUndo === null ? '↶' : React.createElement(IconUndo, { size: 14 })))
      }
      children.push(React.createElement('button', {
        key: 'optimize',
        type: 'button',
        className: 'dsh-better-input',
        'data-dsh-better-input': ENTRY_ID,
        'data-state': running ? 'running' : 'idle',
        'aria-label': running ? t('cancel') : t('optimize'),
        title: running ? t('cancel') : title,
        // 生成中保持可点 = 取消；其余情况由 busy/empty 决定。
        disabled: running ? false : disabled,
        // 保持输入框焦点，与同一行的 +/模型按钮一致。
        onMouseDown: (event) => { event.preventDefault() },
        onClick: onOptimize,
      }, running
        ? (IconLoading === null ? '…' : React.createElement(IconLoading, { size: 14 }))
        : (IconSparkle === null ? '✨' : React.createElement(IconSparkle, { size: 14 }))))

      return React.createElement(
        'span',
        { className: 'dsh-better-input-wrap', 'data-dsh-better-input-wrap': ENTRY_ID },
        children,
      )
    }

    /* ── 设置页：宿主只读路由（目录 / 试调） ─────────────────────────────── */

    /**
     * 读目录 + 当前生效配置。
     * @returns {Promise<object>} 宿主响应体。
     */
    async function requestCatalog() {
      const response = await fetch(ROUTE_CATALOG, { method: 'GET', headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      return await response.json()
    }

    /**
     * 读某个 provider 的模型列表（失败按空目录处理：目录只是增强，手填永远可用）。
     * @param {string} provider - provider id。
     * @returns {Promise<object[]>} 模型行。
     */
    async function requestModels(provider) {
      const url = `${ROUTE_CATALOG_MODELS}?provider=${encodeURIComponent(provider)}`
      const response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } })
      if (!response.ok) return []
      const data = await response.json()
      return Array.isArray(data?.models) ? data.models : []
    }

    /**
     * 试调一条模型路由（宿主只做解析，不发真实请求）。
     * @param {string} provider - provider id。
     * @param {string} model - 模型 id。
     * @returns {Promise<object>} `{ ok, message? , name? }`。
     */
    async function requestCheck(provider, model) {
      const response = await fetch(ROUTE_CHECK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, model }),
      })
      if (!response.ok) return { ok: false, message: `HTTP ${String(response.status)}` }
      return await response.json()
    }

    /* ── 设置页：表单模型 ────────────────────────────────────────────────── */

    /**
     * 文本 → 数字；空串 = 未设置，非法 = null。
     * @param {unknown} text - 输入框文本。
     * @returns {number | null | undefined} 解析结果。
     */
    function numberOr(text) {
      const trimmed = String(text ?? '').trim()
      if (trimmed === '') return undefined
      const value = Number(trimmed)
      return Number.isFinite(value) ? value : null
    }

    /**
     * 文本 → 整数；空串 = 未设置，非法 = null。
     * @param {unknown} text - 输入框文本。
     * @returns {number | null | undefined} 解析结果。
     */
    function integerOr(text) {
      const value = numberOr(text)
      if (value === undefined || value === null) return value
      return Number.isInteger(value) ? value : null
    }

    /**
     * 快照 → 表单初值（数字一律转成字符串，因为输入框是字符串世界）。
     * @param {object} snapshot - settingsScope 快照。
     * @returns {object} 表单值。
     */
    function formFromSnapshot(snapshot) {
      const value = snapshot?.value ?? {}
      const text = candidate => (typeof candidate === 'string' ? candidate : '')
      const numeric = candidate => (typeof candidate === 'number' ? String(candidate) : '')
      return {
        customPromptEnabled: value.customPromptEnabled === true,
        systemPrompt: text(value.systemPrompt),
        modelProvider: text(value.modelProvider),
        modelId: text(value.modelId),
        temperature: numeric(value.temperature),
        maxOutputTokens: numeric(value.maxOutputTokens),
        timeoutMs: numeric(value.timeoutMs),
      }
    }

    /**
     * 客户端预校验：与宿主 `validateSettingsSection` 是同一套规则的镜像
     * （客户端 bundle 不能相对 import policy.js，见 DESIGN.md；两边靠测试对夹具保证一致）。
     * @param {object} form - 表单值。
     * @param {(key: string) => string} t - 词典。
     * @returns {Record<string, string>} 字段 → 错误文案。
     */
    function validateForm(form, t) {
      const errors = {}
      if (form.customPromptEnabled && form.systemPrompt.trim() === '') {
        errors.systemPrompt = t('settings.err.promptEmpty')
      }
      const hasProvider = form.modelProvider.trim() !== ''
      const hasModel = form.modelId.trim() !== ''
      if (hasProvider !== hasModel) {
        errors.modelProvider = t('settings.err.modelPair')
        errors.modelId = t('settings.err.modelPair')
      }
      const temperature = numberOr(form.temperature)
      if (temperature === null || (temperature !== undefined && (temperature < 0 || temperature > 2))) {
        errors.temperature = t('settings.err.temperature')
      }
      const maxOutputTokens = integerOr(form.maxOutputTokens)
      if (maxOutputTokens === null || (maxOutputTokens !== undefined && maxOutputTokens < 1)) {
        errors.maxOutputTokens = t('settings.err.maxOutputTokens')
      }
      const timeoutMs = integerOr(form.timeoutMs)
      if (timeoutMs === null || (timeoutMs !== undefined && timeoutMs < 1000)) {
        errors.timeoutMs = t('settings.err.timeoutMs')
      }
      return errors
    }

    /**
     * 表单 → path ops：只发真正变化的字段；清空的字段发 unset（回落到组合配置/默认）。
     * @param {object} form - 表单值。
     * @param {object} snapshot - 当前快照（提供比对基线与用户层）。
     * @returns {Array<{ op: string, path: string[], value?: unknown }>} path ops。
     */
    function buildOps(form, snapshot) {
      const base = snapshot?.value ?? {}
      const ops = []
      const push = (field, next, current) => {
        if (next === undefined) {
          if (current !== undefined && current !== null) ops.push({ op: 'unset', path: [field] })
          return
        }
        if (next !== current) ops.push({ op: 'set', path: [field], value: next })
      }
      push('customPromptEnabled', form.customPromptEnabled === true, base.customPromptEnabled === true)
      const prompt = form.systemPrompt.trim() === '' ? undefined : form.systemPrompt
      push('systemPrompt', prompt, typeof base.systemPrompt === 'string' ? base.systemPrompt : undefined)
      const provider = form.modelProvider.trim() === '' ? undefined : form.modelProvider.trim()
      push('modelProvider', provider, typeof base.modelProvider === 'string' ? base.modelProvider : undefined)
      const model = form.modelId.trim() === '' ? undefined : form.modelId.trim()
      push('modelId', model, typeof base.modelId === 'string' ? base.modelId : undefined)
      push('temperature', numberOr(form.temperature) ?? undefined, typeof base.temperature === 'number' ? base.temperature : undefined)
      push(
        'maxOutputTokens',
        integerOr(form.maxOutputTokens) ?? undefined,
        typeof base.maxOutputTokens === 'number' ? base.maxOutputTokens : undefined,
      )
      push('timeoutMs', integerOr(form.timeoutMs) ?? undefined, typeof base.timeoutMs === 'number' ? base.timeoutMs : undefined)
      return ops
    }

    /* ── 设置页组件 ──────────────────────────────────────────────────────── */

    /**
     * 设置页：配置模型与提示词。
     *
     * 数据来源分两路：
     * - 读写设置段走 `ctx.settingsScope`（框架的文档镜像 + 版本栅栏 + 宿主校验）；
     * - provider/模型目录与「试调」走本插件的只读路由（目录属于宿主 LLM 服务的知识）。
     *
     * 注入面（注册时 `inject` 工厂的返回值会摊成 props）：`settings`、`t`、`catalog`。
     * @param {object} props - 组件道具。
     * @returns {object} React 元素。
     */
    function BetterInputSettings(props) {
      const t = props.t
      const scope = props.settings
      const catalog = props.catalog
      const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot())
      const [form, setForm] = React.useState(() => formFromSnapshot(scope.getSnapshot()))
      const [errors, setErrors] = React.useState({})
      const [note, setNote] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [testing, setTesting] = React.useState(false)
      const [catalogData, setCatalogData] = React.useState(null)
      const [catalogNote, setCatalogNote] = React.useState(null)
      const [models, setModels] = React.useState([])
      /** 有未保存改动时不被远端提交重置表单（否则镜像的任何一次提交都会吃掉正在编辑的内容）。 */
      const dirty = React.useRef(false)
      const alive = React.useRef(true)

      const flash = (text, tone) => {
        setNote({ text, tone })
        window.setTimeout(() => { if (alive.current) setNote(null) }, NOTE_MS[tone] ?? NOTE_MS.ok)
      }

      const loadCatalog = async () => {
        try {
          const data = await catalog.load()
          if (!alive.current) return
          setCatalogData(data)
          setCatalogNote(null)
        } catch {
          if (alive.current) setCatalogNote(t('settings.err.loadCatalog'))
        }
      }

      React.useEffect(() => () => { alive.current = false }, [])
      React.useEffect(() => scope.subscribe(() => {
        const next = scope.getSnapshot()
        setSnapshot(next)
        if (!dirty.current) {
          setForm(formFromSnapshot(next))
          setErrors({})
        }
      }), [scope])
      React.useEffect(() => { void loadCatalog() }, [])
      React.useEffect(() => {
        const provider = form.modelProvider.trim()
        if (provider === '') {
          setModels([])
          return () => {}
        }
        let live = true
        catalog.models(provider)
          .then(list => { if (live) setModels(Array.isArray(list) ? list : []) })
          .catch(() => { if (live) setModels([]) })
        return () => { live = false }
      }, [form.modelProvider])

      const update = (field, value) => {
        dirty.current = true
        setForm(current => ({ ...current, [field]: value }))
        setErrors(current => (current[field] === undefined ? current : { ...current, [field]: undefined }))
      }

      const messageOf = (value, fallback) => {
        // 兼容两种来源：Error 实例（宿主写入被拒），以及响应体里的 message 字符串（试调结论）。
        if (typeof value === 'string' && value !== '') return value
        const text = value instanceof Error ? value.message : ''
        return typeof text === 'string' && text !== '' ? text : fallback
      }

      const onSave = async () => {
        const validation = validateForm(form, t)
        setErrors(validation)
        if (Object.keys(validation).length > 0) {
          flash(t('settings.invalid'), 'error')
          return
        }
        const ops = buildOps(form, snapshot)
        if (ops.length === 0) {
          flash(t('settings.noChange'), 'ok')
          return
        }
        setBusy(true)
        try {
          await scope.mutate(ops, snapshot.revision)
          dirty.current = false
          flash(t('settings.saved'), 'ok')
          void loadCatalog()
        } catch (error) {
          flash(`${t('settings.saveFailed')}：${messageOf(error, t('settings.saveFailed'))}`, 'error')
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const onReset = async () => {
        setBusy(true)
        try {
          await scope.mutate(FIELD_KEYS.map(field => ({ op: 'unset', path: [field] })), snapshot.revision)
          dirty.current = false
          setErrors({})
          flash(t('settings.resetDone'), 'ok')
          void loadCatalog()
        } catch (error) {
          flash(`${t('settings.resetFailed')}：${messageOf(error, t('settings.resetFailed'))}`, 'error')
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const onTest = async () => {
        const provider = form.modelProvider.trim()
        const model = form.modelId.trim()
        if (provider === '' || model === '') {
          flash(t('settings.err.modelPair'), 'warn')
          return
        }
        setTesting(true)
        try {
          const result = await catalog.check(provider, model)
          if (result?.ok === true) flash(`${t('settings.model.testOk')}：${result.name ?? model}`, 'ok')
          else flash(`${t('settings.model.testFail')}：${messageOf(result?.message, model)}`, 'error')
        } catch (error) {
          flash(`${t('settings.model.testFail')}：${messageOf(error, model)}`, 'error')
        } finally {
          if (alive.current) setTesting(false)
        }
      }

      // ── 不可用 / 只读两态 ──
      if (snapshot.status === 'unavailable') {
        return React.createElement('div', { className: 'dsh-bi-form', 'data-dsh-bi-settings': 'unavailable' },
          React.createElement('p', { className: 'dsh-bi-note', 'data-tone': 'warn' }, t('settings.unavailable')),
          snapshot.mode === 'memory'
            ? React.createElement('p', { className: 'dsh-bi-note', 'data-tone': 'warn' }, t('settings.readonly'))
            : null,
        )
      }

      const editable = snapshot.writable === true && busy !== true
      const providers = Array.isArray(catalogData?.providers) ? catalogData.providers : []
      const effective = catalogData?.effective
      const sourceLabel = key => t(`settings.source.${String(key ?? 'none')}`)
      const effectiveText = effective?.provider !== undefined && effective?.provider !== null && effective?.model !== undefined && effective?.model !== null
        ? `${String(effective.provider)} / ${String(effective.model)}（${sourceLabel(effective.sources?.model)}）`
        : t('settings.model.none')

      const row = (labelKey, control, options = {}) => React.createElement(
        'div',
        { className: 'dsh-bi-row' },
        React.createElement('span', { className: 'dsh-bi-label' }, t(labelKey)),
        control,
        options.hint === undefined ? null : React.createElement('span', { className: 'dsh-bi-hint' }, options.hint),
        options.error === undefined ? null : React.createElement('span', { className: 'dsh-bi-error' }, options.error),
      )

      const textInput = (field, extra = {}) => React.createElement('input', {
        className: 'dsh-bi-input',
        type: 'text',
        value: form[field],
        disabled: !editable,
        list: extra.list,
        placeholder: extra.placeholder,
        'data-dsh-bi-field': field,
        onChange: event => { update(field, event.target.value) },
      })

      const numberInput = (field, extra = {}) => React.createElement('input', {
        className: 'dsh-bi-input',
        type: 'number',
        value: form[field],
        disabled: !editable,
        placeholder: extra.placeholder,
        min: extra.min,
        step: extra.step,
        'data-dsh-bi-field': field,
        onChange: event => { update(field, event.target.value) },
      })

      const datalist = (id, entries) => React.createElement(
        'datalist',
        { id },
        entries.map(entry => React.createElement('option', { key: entry.id, value: entry.id }, entry.name)),
      )

      const promptFieldset = React.createElement(
        'fieldset',
        { className: 'dsh-bi-fieldset' },
        React.createElement('legend', { className: 'dsh-bi-legend' }, t('settings.prompt.legend')),
        React.createElement('label', { className: 'dsh-bi-check' },
          React.createElement('input', {
            type: 'checkbox',
            checked: form.customPromptEnabled,
            disabled: !editable,
            'data-dsh-bi-field': 'customPromptEnabled',
            onChange: event => { update('customPromptEnabled', event.target.checked) },
          }),
          React.createElement('span', null, t('settings.prompt.enable')),
        ),
        React.createElement('span', { className: 'dsh-bi-hint' }, t('settings.prompt.enableHint')),
        React.createElement('textarea', {
          className: 'dsh-bi-textarea',
          value: form.systemPrompt,
          disabled: !editable,
          placeholder: t('settings.prompt.placeholder'),
          'data-dsh-bi-field': 'systemPrompt',
          onChange: event => { update('systemPrompt', event.target.value) },
        }),
        errors.systemPrompt === undefined ? null : React.createElement('span', { className: 'dsh-bi-error' }, errors.systemPrompt),
      )

      const modelFieldset = React.createElement(
        'fieldset',
        { className: 'dsh-bi-fieldset' },
        React.createElement('legend', { className: 'dsh-bi-legend' }, t('settings.model.legend')),
        React.createElement('div', { className: 'dsh-bi-grid' },
          row('settings.model.provider', textInput('modelProvider', {
            list: 'dsh-bi-providers',
            placeholder: t('settings.model.providerPlaceholder'),
          }), { error: errors.modelProvider }),
          row('settings.model.id', textInput('modelId', {
            list: 'dsh-bi-models',
            placeholder: t('settings.model.idPlaceholder'),
          }), { error: errors.modelId }),
        ),
        datalist('dsh-bi-providers', providers),
        datalist('dsh-bi-models', models),
        React.createElement('span', { className: 'dsh-bi-hint' }, t('settings.model.listHint')),
        catalogNote === null ? null : React.createElement('span', { className: 'dsh-bi-error' }, catalogNote),
        React.createElement('span', { className: 'dsh-bi-effective' }, `${t('settings.model.effective')}：${effectiveText}`),
      )

      const paramsFieldset = React.createElement(
        'fieldset',
        { className: 'dsh-bi-fieldset' },
        React.createElement('legend', { className: 'dsh-bi-legend' }, t('settings.params.legend')),
        React.createElement('div', { className: 'dsh-bi-grid' },
          row('settings.params.temperature', numberInput('temperature', {
            placeholder: t('settings.params.temperaturePlaceholder'),
            min: 0,
            step: 0.1,
          }), { error: errors.temperature }),
          row('settings.params.maxOutputTokens', numberInput('maxOutputTokens', {
            placeholder: t('settings.params.placeholder'),
            min: 1,
            step: 1,
          }), { error: errors.maxOutputTokens }),
          row('settings.params.timeoutMs', numberInput('timeoutMs', {
            placeholder: t('settings.params.placeholder'),
            min: 1000,
            step: 1000,
          }), { error: errors.timeoutMs }),
        ),
      )

      const actions = React.createElement('div', { className: 'dsh-bi-actions' },
        React.createElement('button', {
          type: 'button',
          className: 'dsh-bi-button',
          'data-variant': 'primary',
          'data-dsh-bi-action': 'save',
          disabled: !editable,
          onClick: onSave,
        }, busy ? t('settings.saving') : t('settings.save')),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-bi-button',
          'data-dsh-bi-action': 'test',
          disabled: !editable || testing,
          onClick: onTest,
        }, testing ? t('settings.model.testing') : t('settings.model.test')),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-bi-button',
          'data-dsh-bi-action': 'reset',
          disabled: !editable,
          title: t('settings.resetHint'),
          onClick: onReset,
        }, busy ? t('settings.resetting') : t('settings.reset')),
        note === null ? null : React.createElement('span', { className: 'dsh-bi-note', 'data-tone': note.tone }, note.text),
      )

      return React.createElement(
        'div',
        { className: 'dsh-bi-form', 'data-dsh-bi-settings': 'ready' },
        React.createElement('p', { className: 'dsh-bi-intro' }, t('settings.intro')),
        snapshot.writable === true
          ? null
          : React.createElement('p', { className: 'dsh-bi-note', 'data-tone': 'warn' }, t('settings.readonly')),
        promptFieldset,
        modelFieldset,
        paramsFieldset,
        actions,
      )
    }

    /**
     * 需要就绪的客户端服务：
     * `slots`（ui-renderer 提供）、`locale`（dsh-client-locale）、
     * `settingsScope`（ui-settings 提供的设置命名空间门面）。
     */
    const inject = ['slots', 'locale', 'settingsScope']

    /**
     * 浏览器半入口。
     * @param {object} ctx - 浏览器端 cordis 上下文。
     * @returns {void}
     */
    function apply(ctx) {
      ensureStyle()
      ctx.effect(() => () => { document.getElementById(STYLE_ID)?.remove() }, 'better-input: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'better-input: dictionaries')
      ctx.inject(['slots'], (scope) => {
        // `slots.inject` 等座位被 ui-conversation 的 composer bar 声明后再注册；
        // 用调用者 fiber 的 effect 托管，插件卸载即回收。
        scope.slots.inject(SEAT, () => scope.slots.register({
          name: SEAT,
          id: ENTRY_ID,
          order: ORDER,
          locale: NS,
        }, BetterInputButton))
      })
      ctx.inject(['slots', 'settingsScope'], (scope) => {
        // 本插件自己的设置命名空间：读写都走框架的文档镜像与版本栅栏（持久化由宿主负责）。
        const settings = scope.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
        const t = ctx.locale.bind(NS)
        const face = () => ({
          settings,
          t,
          catalog: {
            load: () => requestCatalog(),
            models: provider => requestModels(provider),
            check: (provider, model) => requestCheck(provider, model),
          },
        })
        // 设置页作为独立分区挂进设置面板的导航（label 是 thunk，随词典解析）。
        scope.slots.inject('settings.section', () => scope.slots.register({
          name: 'settings.section',
          id: SETTINGS_SECTION_ID,
          order: SETTINGS_SECTION_ORDER,
          label: () => t('settings.nav'),
          inject: face,
        }, BetterInputSettings))
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
