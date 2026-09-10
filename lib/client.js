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
     * 框架注入的标准道具（会话作用域）：`useInput`、`inputActions`、`sessionId`、`useSession`、
     * `useProjection`；owner props（InputZone）：`session`、`input`；本插件另有词典 `t`。
     * @param {object} props - 组件道具。
     * @returns {object} React 元素。
     */
    function BetterInputButton(props) {
      const t = props.t
      const draft = props.useInput((state) => state.draft)
      const phase = props.useInput((state) => state.phase)
      // 老版本 InputState 可能没有 occurrences，缺字段按「无芯片」处理。
      const occurrences = props.useInput((state) => state.occurrences) ?? []

      const [running, setRunning] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [, setStackVersion] = React.useState(0)

      const alive = React.useRef(true)
      const abort = React.useRef(null)
      /** 最新 props 盒子：异步回调里必须读它，不能读闭包捕获的旧 props。 */
      const latest = React.useRef(props)
      latest.current = props
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
        const current = latest.current.input
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
          const now = latest.current.input
          // CAS：草稿在往返期间被改动过就丢弃结果，绝不覆盖用户此刻的输入。
          if (now.draft !== before || now.draftRev !== rev) { flash(t('staleResult'), 'warn'); return }
          latest.current.inputActions.setDraft(outcome.text)
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
        const forced = latest.current.input.draft !== entry.after
        if (forced && forceArmed.current !== entry) {
          forceArmed.current = entry
          flash(t('undoDirty'), 'warn')
          return
        }
        latest.current.inputActions.setDraft(entry.before)
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

    /** 需要就绪的客户端服务：座位注册表与词典注册表。 */
    const inject = ['slots', 'locale']

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
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
