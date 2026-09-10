/**
 * better-input —— 浏览器半。
 *
 * 只做三件事：
 *   1. 往 ui-conversation 的 `conversation.input.right` 座位（模型选择器紧左边）注册一个按钮条目；
 *   2. 读当前草稿（座位组件被框架注入的标准道具 `useInput` / owner props `input`）；
 *   3. 【P0】按钮就位，点击行为待 P2 接线；届时用 `inputActions.setDraft(text)` 写回，
 *      并按 DESIGN.md §3.4 压撤销栈。
 *
 * 红线：不碰 DOM 输入框。已安装版本的 composer 是 Lexical contenteditable + 芯片节点，
 * 官方契约是 `InputState.draft`（读）与 `InputActions.setDraft()`（写）。
 *
 * 形态说明：客户端 bundle 是 `window.__ModuleLoader__.load({ id, factory })` 的 CJS 工厂，
 * 所以可以手写、无需构建工具。只在工厂里 `require` 平台种子模块
 * （react / react-dom / cordis / dsh-client-store / dsh-client-ui-slots / dsh-client-ui-primitives），
 * 跨插件的值导入在构建期就是错误。
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
    /** 宿主路由（与 lib/policy.js 的 ROUTE 保持一致；P2 接线时使用）。 */
    const ROUTE = '/api/dsh-input-optimizer/optimize'
    /** 样式标签 id（HMR 重载时按 id 去重/回收）。 */
    const STYLE_ID = 'dsh-better-input-style'

    /** 图标走平台种子模块；缺失时降级为文字符号，避免整个条目抛错被边界回收。 */
    const IconSparkle = primitives.IconSparkle16 ?? null
    const IconLoading = primitives.IconLoadingOutline16 ?? null

    const zh = {
      optimize: '优化输入',
      optimizing: '正在优化…',
      fromLabel: 'AI 优化输入',
      empty: '输入框是空的，先写点内容',
      busy: '当前输入正在提交或等待处理',
      pending: '宿主路由已就绪，前端接线（P2）待实现',
      undone: '已撤销上一次优化',
    }
    const en = {
      optimize: 'Optimize input',
      optimizing: 'Optimizing…',
      fromLabel: 'AI optimize input',
      empty: 'The input box is empty',
      busy: 'The composer is busy',
      pending: 'Host route is ready; client wiring (P2) is pending',
      undone: 'Reverted the last optimization',
    }

    /** 组件样式：跟随主题的 currentColor，尽量不引入自有配色。 */
    const CSS = [
      `.dsh-better-input{display:inline-flex;align-items:center;justify-content:center;gap:4px;`,
      `height:24px;min-width:24px;padding:0 6px;border:0;border-radius:6px;background:transparent;`,
      `color:inherit;opacity:.72;cursor:pointer;font:inherit;font-size:12px;line-height:1}`,
      `.dsh-better-input:hover:not(:disabled){opacity:1;background:color-mix(in srgb,currentColor 12%,transparent)}`,
      `.dsh-better-input:disabled{opacity:.35;cursor:default}`,
      `.dsh-better-input[data-state="running"]{opacity:1}`,
      `.dsh-better-input__note{opacity:.7;font-size:11px;white-space:nowrap}`,
    ].join('')

    /** 幂等地注入样式表。 */
    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.append(style)
    }

    /**
     * 座位条目组件。
     * 框架注入的标准道具（会话作用域）：`useInput`、`inputActions`、`sessionId`、`useSession`、
     * plus owner props `session` / `input`（InputZone）与本插件的 `t`。
     * @param {object} props - 组件道具。
     * @returns {object} React 元素。
     */
    function BetterInputButton(props) {
      const t = props.t
      const draft = props.useInput((state) => state.draft)
      const phase = props.useInput((state) => state.phase)
      const [note, setNote] = React.useState(null)
      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      const busy = phase !== 'plain'
      const empty = draft.trim() === ''
      const disabled = busy || empty

      const flash = (message) => {
        setNote(message)
        window.setTimeout(() => { if (alive.current) setNote(null) }, 2400)
      }

      const onClick = () => {
        if (disabled) return
        // ── P2 接线点（DESIGN.md §3.3）─────────────────────────────────────
        // const before = draft, rev = input.draftRev       // CAS 基准
        // const res = await fetch(ROUTE, { method: 'POST',
        //   headers: { 'content-type': 'application/json' },
        //   body: JSON.stringify({ text: draft, sessionId: props.sessionId }) })
        // const data = await res.json()
        // if (res.ok) { props.inputActions.setDraft(data.text); pushUndo(...) }
        // ──────────────────────────────────────────────────────────────────
        console.info('[better-input] P0 骨架：按钮已就位。宿主路由 ' + ROUTE + ' 已实现，前端接线（P2）待做。')
        flash(t('pending'))
      }

      const label = note ?? (busy ? t('busy') : empty ? t('empty') : t('optimize'))
      return React.createElement(
        'span',
        { className: 'dsh-better-input-wrap', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
        note !== null && React.createElement('span', { className: 'dsh-better-input__note' }, label),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-better-input',
            'data-dsh-better-input': ENTRY_ID,
            'data-state': busy ? 'running' : 'idle',
            'aria-label': t('optimize'),
            title: label,
            disabled,
            // 保持输入框焦点，与同一行的 +/模型按钮一致。
            onMouseDown: (event) => { event.preventDefault() },
            onClick,
          },
          busy
            ? (IconLoading === null ? '…' : React.createElement(IconLoading, { size: 14 }))
            : (IconSparkle === null ? '✨' : React.createElement(IconSparkle, { size: 14 })),
        ),
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
