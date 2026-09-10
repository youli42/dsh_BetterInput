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
  /** 必须等于包名（宿主按包名组合 boot graph）；与工厂内的 PLUGIN_ID 同值。 */
  id: 'dsh-better-input',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** 插件 id（= 包名）：boot 注册键，也用作样式标签的归属标记。 */
    const PLUGIN_ID = 'dsh-better-input'
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
    /** 流式路由（SSE）；不可用时回退到 ROUTE。 */
    const ROUTE_STREAM = '/api/dsh-input-optimizer/optimize/stream'
    /** 流式回填的最小写入间隔（毫秒）：避免每个 token 都触发一次编辑器整体重写。 */
    const STREAM_WRITE_MS = 80
    /** 样式标签 id（本文件幂等注入时用来判重）。 */
    const STYLE_ID = `${PLUGIN_ID}-style`
    /** 每会话撤销栈深度（客户端读不到插件配置，见 DESIGN.md R-10；与宿主默认值保持一致）。 */
    const MAX_UNDO = 10
    /**
     * 同时保留撤销栈的会话数上限（LRU）。
     * 会话被删除/归档时没有任何通知能到达插件，不设上限这张 Map 只会单向长大。
     */
    const MAX_UNDO_SESSIONS = 20
    /** 各语气提示的停留时长（毫秒）；错误留久一点。 */
    const NOTE_MS = { ok: 3000, warn: 5000, error: 7000 }

    /* ── 设置页（P4）─────────────────────────────────────────────────────── */

    /** 设置命名空间：与宿主 `ctx.settings.register` 用的是同一个（lib/policy.js）。 */
    const SETTINGS_NAMESPACE = 'better-input'
    /** 设置页在导航里的条目 id。 */
    const SETTINGS_SECTION_ID = 'better-input'
    /** 导航排序：排在模型(10)/通用之后。 */
    const SETTINGS_SECTION_ORDER = 60
    /**
     * 内置优化风格 id（与宿主 `lib/policy.js` 的 `STYLE_DEFINITIONS` 同 id、同序）。
     *
     * 客户端 bundle 不能跨包 import（见本文件头），所以这里是**镜像**。镜像本身不可怕，
     * 可怕的是漂移没人发现——所以 `test/client.smoke.mjs` 有一条用例把这个数组与宿主导出的
     * `STYLE_IDS` 逐项对齐，改了任何一边都会当场红。
     */
    const STYLE_IDS = ['concise', 'spec']
    /**
     * 风格 id → 设置命名空间里的扁平字段名（与宿主 `stylePromptField` 同规则）。
     * @param {string} id - 风格 id。
     * @returns {string} 字段名。
     */
    const stylePromptField = id => `stylePrompt${id.charAt(0).toUpperCase()}${id.slice(1)}`
    /** 逐风格提示词字段清单（表单初值 / 保存 / 恢复默认共用）。 */
    const STYLE_FIELDS = STYLE_IDS.map(stylePromptField)
    /** 设置段的扁平字段清单（与宿主 schema 一一对应）。 */
    const FIELD_KEYS = [
      'customPromptEnabled',
      'systemPrompt',
      'modelProvider',
      'modelId',
      'temperature',
      'maxOutputTokens',
      'timeoutMs',
      ...STYLE_FIELDS,
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
      'preset.menu': '按预设优化',
      'style.menu': '优化风格（可多选）',
      'style.apply': '按所选风格优化',
      'style.concise': '精简',
      'style.spec': '转规格',
      'style.noneSelected': '没有勾选风格，将用默认提示词优化',
      tooLong: '草稿过长，超过宿主上限',
      empty: '输入框是空的，先写点内容',
      busy: '当前输入正在提交或等待处理',
      chips: '草稿里有 @引用 或 /命令 芯片，整体替换会丢引用，请先删掉它们',
      done: '已替换为优化结果',
      doneTruncated: '结果被输出上限截断，已替换',
      streamReverted: '已还原原文',
      staleResult: '草稿在优化过程中被修改，结果已丢弃',
      emptyResult: '模型没有返回可用文本',
      network: '请求失败：无法连接宿主路由',
      forbidden: '宿主拒绝：这条路由只服务本机浏览器',
      unauthorized: '宿主需要浏览器会话：请在本页面里操作（页面 cookie 会自动带上）',
      notMounted: '宿主路由未挂载（插件宿主半未启用？）',
      server: '宿主返回错误',
      fail: '优化失败',

      // ── 设置页 ──
      'settings.nav': '输入优化',
      'settings.intro': '按钮出现在输入框工具行、模型选择器左侧。这里配置它用哪个模型、哪段提示词，以及每个优化风格的独立提示词。',
      'settings.unavailable': '设置服务不可用：宿主端没有挂载设置提供者（或插件宿主半未加载）。配置无法保存，但优化按钮仍用默认模型与默认提示词工作。',
      'settings.unavailableReason': '宿主返回的原因：',
      'settings.readonly': '当前连接不接受写入（远程页面可能是进程内模式），因此无法保存设置。',
      'settings.prompt.legend': '提示词',
      'settings.prompt.enable': '使用自定义提示词',
      'settings.prompt.enableHint': '关闭时使用默认提示词（内置文案或插件配置里的 systemPrompt）',
      'settings.prompt.body': '提示词内容',
      'settings.prompt.placeholder': '例如：你是提示词工程师，把用户草稿改写成更清晰、无歧义、可执行的任务描述……',
      'settings.model.legend': '模型',
      'settings.model.provider': 'Provider',
      'settings.model.providerPlaceholder': '留空则使用默认模型',
      'settings.model.id': '模型名称',
      'settings.model.idPlaceholder': '留空则使用默认模型',
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
      'settings.err.maxOutputTokens': '输出 token 上限需为 1 到 200000 的整数',
      'settings.err.timeoutMs': '超时需为 1000 到 600000 的整数（毫秒）',
      'settings.err.loadCatalog': '读取模型目录失败，可手动填写模型名称',
      'settings.err.notApplied': '宿主没有接受这次写入（可能已被其他窗口改动，或字段超出宿主允许的范围）；请刷新后重试',
      'settings.style.legend': '优化风格提示词',
      'settings.style.hint': '每个风格可以单独配提示词；留空则用组合配置里同 id 的预设，再往下才是内置默认。勾选是每次优化时在输入框下拉框里选的，不在这里保存。',
      'settings.style.placeholder': '留空 = 使用该风格的默认提示词',
      'settings.style.source': '当前生效来源',
    }
    const en = {
      optimize: 'Optimize input',
      cancel: 'Cancel optimization',
      undo: 'Undo last optimization',
      undone: 'Reverted to the draft from before optimization',
      undoneForced: 'Force-restored the pre-optimization draft',
      undoDirty: 'The draft changed after optimization; click again to force-restore',
      undoEmpty: 'Nothing to undo',
      'preset.menu': 'Optimize with a preset',
      'style.menu': 'Optimization styles (multi-select)',
      'style.apply': 'Optimize with the selected styles',
      'style.concise': 'Concise',
      'style.spec': 'Spec',
      'style.noneSelected': 'No style selected; the default prompt is used',
      tooLong: 'The draft is longer than the host limit',
      empty: 'The input box is empty',
      busy: 'The composer is busy',
      chips: 'The draft has @reference or /command chips; replacing it wholesale would drop them',
      done: 'Replaced with the optimized text',
      doneTruncated: 'Output hit the token cap; replaced',
      streamReverted: 'the original draft was restored',
      staleResult: 'The draft changed while optimizing; the result was discarded',
      emptyResult: 'The model returned no usable text',
      network: 'Request failed: cannot reach the host route',
      forbidden: 'Host refused: this route serves the local browser only',
      unauthorized: 'The host requires a browser session: act from this page (its cookie is sent automatically)',
      notMounted: 'The host route is not mounted (host half disabled?)',
      server: 'The host returned an error',
      fail: 'Optimization failed',

      // ── settings page ──
      'settings.nav': 'Input optimizer',
      'settings.intro': 'The button sits in the composer tool row, just left of the model selector. Configure which model and which prompt it uses, plus a separate prompt for each optimization style.',
      'settings.unavailable': 'Settings service unavailable: this deployment mounts no settings provider (or the host half is not loaded). Values cannot be saved, but the button keeps working with the default model and prompt.',
      'settings.unavailableReason': 'Reason reported by the host: ',
      'settings.readonly': 'This connection does not accept writes (a remote page may run in memory mode), so settings cannot be saved.',
      'settings.prompt.legend': 'Prompt',
      'settings.prompt.enable': 'Use a custom prompt',
      'settings.prompt.enableHint': 'Off uses the default prompt (built-in text or the systemPrompt from the plugin config)',
      'settings.prompt.body': 'Prompt text',
      'settings.prompt.placeholder': 'e.g. You are a prompt engineer: rewrite the draft into a clearer, unambiguous, actionable task…',
      'settings.model.legend': 'Model',
      'settings.model.provider': 'Provider',
      'settings.model.providerPlaceholder': 'Empty uses the default model',
      'settings.model.id': 'Model name',
      'settings.model.idPlaceholder': 'Empty uses the default model',
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
      'settings.err.maxOutputTokens': 'Max output tokens must be an integer between 1 and 200000',
      'settings.err.timeoutMs': 'Timeout must be an integer between 1000 and 600000 ms',
      'settings.err.loadCatalog': 'Could not read the model catalog; type the model name manually',
      'settings.err.notApplied': 'The host did not accept this write (another window may have changed it, or a value is out of the host range); refresh and retry',
      'settings.style.legend': 'Style prompts',
      'settings.style.hint': 'Each style can have its own prompt. Empty falls back to a preset with the same id in the composition config, then to the built-in default. Which styles are active is chosen per optimization in the composer dropdown, not saved here.',
      'settings.style.placeholder': 'Empty = this style\'s default prompt',
      'settings.style.source': 'Effective source',
    }

    /** 组件样式：优先复用 GUI 的设计令牌，令牌缺失时回落到 currentColor 派生值。 */
    const CSS = [
      // 工具行右侧本来就拥挤（模型座 + 上下文计量 + 发送键），所以本条目必须可收缩。
      // position:relative 是预设菜单的定位基准。
      `.dsh-better-input-wrap{display:inline-flex;align-items:center;gap:6px;min-width:0;flex:0 1 auto;position:relative}`,
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
      // ── 预设菜单：向上弹出（工具行在输入框下方，上方是对话区，不易被裁剪） ──
      `.dsh-better-input-menu{position:absolute;bottom:calc(100% + 6px);right:0;z-index:30;`,
      `display:flex;flex-direction:column;gap:2px;min-width:120px;max-width:min(260px,60vw);padding:4px;`,
      `border-radius:10px;background:var(--dsw-alias-bg-layer-2,Canvas);`,
      `border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 20%,transparent));`,
      `box-shadow:0 8px 24px color-mix(in srgb,currentColor 18%,transparent)}`,
      `.dsh-better-input-menu-item{display:block;width:100%;text-align:left;font:inherit;font-size:12px;`,
      `padding:6px 8px;border:0;border-radius:6px;background:transparent;cursor:pointer;`,
      `color:var(--dsw-alias-label-primary,currentColor);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
      `.dsh-better-input-menu-item:hover{background:var(--dsw-alias-button-tool-bar-hover,color-mix(in srgb,currentColor 12%,transparent))}`,
      // 风格区（多选）：小标题 + 复选行 + 底部的「按所选风格优化」。
      `.dsh-better-input-menu-head{padding:4px 8px 2px;font-size:10px;`,
      `color:var(--dsw-alias-label-tertiary,currentColor)}`,
      `.dsh-better-input-menu-check{display:flex;align-items:center;gap:6px;padding:5px 8px;`,
      `border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;`,
      `color:var(--dsw-alias-label-primary,currentColor)}`,
      `.dsh-better-input-menu-check:hover{background:var(--dsw-alias-button-tool-bar-hover,color-mix(in srgb,currentColor 12%,transparent))}`,
      `.dsh-better-input-menu-check input{margin:0;flex:none}`,
      `.dsh-better-input-menu-action{margin-top:2px;font-weight:600}`,

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
      // 逐风格提示词比主提示词短，压矮一点，免得两个风格的框把整页撑得很长。
      `.dsh-bi-textarea--style{min-height:76px;font-size:12px}`,
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

    /**
     * 幂等地注入样式表。
     *
     * **必须自己打 `data-plugin`/`data-plugin-css`**：框架在**物化期**把所有"未打标的
     * `<style>`"认领给当时正在物化的那个插件（dsh-client-modules 的 `claimStyles`），而
     * `apply()` 晚于物化执行——不打标的话，下一个物化的插件会把这张表认领成自己的，
     * 那个插件 HMR 重载时按 `style[data-plugin]` 逐个删除（dsh-client-hmr 的
     * `removeOwnedStyles`），本插件的样式就被顺手删掉，只有整页刷新才恢复。
     * 官方 apply 期注入的写法也是这样自打标（dsh-client-ui-theme 的 STYLES 循环）。
     * @returns {void}
     */
    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.dataset.plugin = PLUGIN_ID
      style.dataset.pluginCss = `${PLUGIN_ID}/style.css`
      style.textContent = CSS
      document.head.append(style)
    }

    /* ── 撤销栈：模块级、按会话隔离（插件生命周期内有效，不随组件重挂载丢失） ── */

    /**
     * 每会话一条撤销栈，最近使用的排在末尾。
     *
     * 记录里**只有 `before`/`after` 两个文本**：撤销的 CAS 判据就是"当前草稿是否仍等于
     * `after`"（文本相等是比 revision 相等更强的条件——内容一样就不可能覆盖用户的新输入），
     * 所以不需要再存 `draftRev`/时间戳。
     * @type {Map<string, Array<{ before: string, after: string }>>}
     */
    const undoStacks = new Map()

    /**
     * 把某会话的栈标记为"最近使用"，并按 LRU 淘汰多余会话。
     * @param {string} sessionId - 会话 id。
     * @param {Array<object>} stack - 该会话的栈。
     * @returns {void}
     */
    function touchStack(sessionId, stack) {
      // Map 保序：先删再插 = 冒泡到末尾（最近使用）。
      undoStacks.delete(sessionId)
      undoStacks.set(sessionId, stack)
      for (const oldest of undoStacks.keys()) {
        if (undoStacks.size <= MAX_UNDO_SESSIONS) break
        undoStacks.delete(oldest)
      }
    }

    /**
     * 取（必要时创建）某会话的撤销栈。
     * @param {string} sessionId - 会话 id。
     * @returns {Array<object>} 撤销栈。
     */
    function stackFor(sessionId) {
      let stack = undoStacks.get(sessionId)
      if (stack === undefined) stack = []
      touchStack(sessionId, stack)
      return stack
    }

    /**
     * 取栈顶记录。
     * @param {string} sessionId - 会话 id。
     * @returns {object | null} 栈顶记录。
     */
    function peekUndo(sessionId) {
      const stack = undoStacks.get(sessionId)
      if (stack === undefined || stack.length === 0) return null
      touchStack(sessionId, stack)
      return stack[stack.length - 1]
    }

    /**
     * 压入一条记录，超出深度丢最旧的。
     * @param {string} sessionId - 会话 id。
     * @param {{ before: string, after: string }} entry - 记录。
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
     * 组装请求体（JSON 路由与 SSE 路由共用，避免两条路各写一份字段清单）。
     * @param {{ text: string, sessionId?: string, presetId?: string, styleIds?: string[] }} call - 调用参数。
     * @returns {object} 请求体。
     */
    function optimizeBody(call) {
      const styleIds = call.styleIds ?? []
      return {
        text: call.text,
        ...call.sessionId === undefined ? {} : { sessionId: call.sessionId },
        ...call.presetId === undefined ? {} : { presetId: call.presetId },
        // 没勾风格时**不带这个字段**：老宿主不认识它、老客户端也不发它，两边互不打扰。
        ...styleIds.length === 0 ? {} : { styleIds },
      }
    }

    /**
     * 按 HTTP 状态码给一句兜底说明（响应体带 message 时优先用它的）。
     *
     * 404 与 405 都算"路由没挂上"：web 组合里未匹配的路径由 SPA fallback 接管，而它对
     * 非 GET/HEAD 的请求**先**回 405 空体、再去找文件（dsh-host-frontend-static 在
     * 读盘之前就拦掉了非 GET/HEAD），所以宿主半没挂载时 `POST /optimize` 拿到的是 405，
     * 不是 404——只映射 404 的话"路由未挂载"这条专门文案永远不会出现。
     * 插件自己的 405 是带 JSON message 的（"只接受 POST"），走不到这里。
     * @param {number} status - 状态码。
     * @param {(key: string) => string} t - 词典。
     * @returns {string} 说明文本。
     */
    function statusMessage(status, t) {
      if (status === 401) return t('unauthorized')
      if (status === 403) return t('forbidden')
      if (status === 404 || status === 405) return t('notMounted')
      return `${t('server')} (HTTP ${String(status)})`
    }

    /**
     * 解析一帧 SSE。
     *
     * 只认 `event:` 与 `data:` 两行（其余字段忽略），以 `:` 开头的注释帧返回 null——
     * 宿主就是靠注释帧做"流已开"的即时 flush。
     * @param {string} frame - 一帧文本（不含结束空行）。
     * @returns {{ event: string, data: any } | null} 解析结果。
     */
    function parseSseFrame(frame) {
      const lines = frame.split('\n')
      if (lines.length > 0 && lines[0].startsWith(':')) return null
      const event = lines.find(line => line.startsWith('event: '))?.slice(7)
      const data = lines.find(line => line.startsWith('data: '))?.slice(6)
      if (event === undefined) return null
      try {
        return { event, data: data === undefined ? undefined : JSON.parse(data) }
      } catch {
        return null
      }
    }

    /**
     * 流式调用宿主路由：把增量实时交给 `onDelta`，返回最终文本。
     *
     * 返回 `{ unavailable: true }` 表示"这条路走不通，请回退到一次性 JSON"——包括
     * 旧宿主没有这条路由（404/405）、浏览器拿不到 `response.body`、以及网络层失败。
     * 之所以要回退而不是报错：流式是**增强**，不该让它在任何环境下变成新的失败面。
     * @param {{ text: string, sessionId?: string, presetId?: string, styleIds?: string[], signal: AbortSignal,
     *   t: (key: string) => string, onDelta: (delta: string) => void }} call - 调用参数。
     * @returns {Promise<{ ok: true, text: string, truncated: boolean } | { ok: false, message: string }
     *   | { ok: false, unavailable: true }>} 结果。
     */
    async function requestOptimizeStream(call) {
      let response
      try {
        response = await fetch(ROUTE_STREAM, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(optimizeBody(call)),
          signal: call.signal,
        })
      } catch (error) {
        if (call.signal.aborted) throw error
        return { ok: false, unavailable: true }
      }
      if (response.status === 404 || response.status === 405) return { ok: false, unavailable: true }
      if (!response.ok) {
        let data = null
        try {
          data = await response.json()
        } catch {
          data = null
        }
        const message = data !== null && typeof data.message === 'string' && data.message !== ''
          ? data.message
          : statusMessage(response.status, call.t)
        return { ok: false, message }
      }
      if (response.body === null || response.body === undefined || typeof response.body.getReader !== 'function') {
        return { ok: false, unavailable: true }
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let final = null
      let failure = null
      for (;;) {
        const { value, done } = await reader.read()
        if (done === true) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = parseSseFrame(buffer.slice(0, boundary))
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
          if (frame === null) continue
          if (frame.event === 'delta' && typeof frame.data?.text === 'string') call.onDelta(frame.data.text)
          else if (frame.event === 'done') final = frame.data
          else if (frame.event === 'error') failure = frame.data
        }
      }
      if (failure !== null) {
        return { ok: false, message: typeof failure?.message === 'string' && failure.message !== '' ? failure.message : call.t('fail') }
      }
      if (final === null || typeof final.text !== 'string' || final.text.trim() === '') {
        return { ok: false, message: call.t('emptyResult') }
      }
      return { ok: true, text: final.text, truncated: final.truncated === true }
    }

    /**
     * 调宿主路由做一次优化（一次性 JSON，回退路径）。
     * @param {{ text: string, sessionId?: string, presetId?: string, styleIds?: string[], signal: AbortSignal,
     *   t: (key: string) => string }} call - 调用参数。
     * @returns {Promise<{ ok: true, text: string, truncated: boolean } | { ok: false, message: string }>} 结果。
     */
    async function requestOptimize(call) {
      let response
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(optimizeBody(call)),
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
     * `renderSlot(name, {})`——**没有任何 owner props**。所以输入状态只能从 `useInput` 读，
     * 绝不能读 `props.input`（新版本源码才把它传给 left/right，属于版本差异，见 DESIGN.md R-3/R-13）。
     * 注意别把"没有 owner props"扩大化：`conversation.input.plan`/`.model`/`.attachments` 是拿得到
     * owner props 的（`{ locked }` 等），只是它们也拿不到 `input` 快照。
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

      const [running, setRunning] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [, setStackVersion] = React.useState(0)
      /** 宿主下发的预设（`/catalog` 的 presets，只有 id/label）与区间（limits）。 */
      const [presets, setPresets] = React.useState([])
      /** 宿主下发的**优化风格**（`/catalog` 的 styles：id/label/source）。 */
      const [styles, setStyles] = React.useState([])
      /**
       * 当前勾选的风格 id（多选）。
       *
       * 只放在组件 state 里、**不落设置**：勾选是"这一次想怎么改写"的即时选择，
       * 而"每个风格的提示词是什么"才是需要持久化的配置（在设置页里配）。
       */
      const [selectedStyles, setSelectedStyles] = React.useState([])
      const [limits, setLimits] = React.useState(LIMITS_FALLBACK)
      const [menuOpen, setMenuOpen] = React.useState(false)

      const alive = React.useRef(true)
      const abort = React.useRef(null)
      /** 当前提示的自动消失计时器：换提示时先撤掉旧的，否则旧计时器会提前清掉新提示。 */
      const noteTimer = React.useRef(null)
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
        if (noteTimer.current !== null) window.clearTimeout(noteTimer.current)
      }, [])

      // 风格/预设与区间来自宿主（单一事实来源）：每次页面加载最多一次往返，失败就退回兜底值。
      React.useEffect(() => {
        let live = true
        void catalogShared()
          .then(({ presets: list, styles: styleList, limits: fromHost }) => {
            if (!live || !alive.current) return
            setPresets(list)
            setStyles(styleList)
            setLimits(fromHost)
          })
          .catch(() => {})
        return () => { live = false }
      }, [])

      // 菜单打开期间的关闭手势：点外面 / 按 Esc。真实 DOM 一定有这两个方法，测试替身要补齐。
      React.useEffect(() => {
        if (!menuOpen) return () => {}
        /**
         * 点在菜单**内部**不关。
         *
         * 必须自己判一次：document 上的监听会收到**所有**冒泡上来的 mousedown，包括菜单里
         * 那个风格勾选框的。不多这一判，勾第一个风格就会把菜单收起来，"多选"根本用不了
         * （单选的预设菜单看不出这个问题——它点完本来就要收起）。
         * @param {object} event - mousedown 事件。
         * @returns {void}
         */
        const onDown = (event) => {
          if (event?.target?.closest?.(`[data-dsh-better-input-menu]`) != null) return
          setMenuOpen(false)
        }
        const onKey = (event) => { if (event?.key === 'Escape') setMenuOpen(false) }
        document.addEventListener?.('mousedown', onDown)
        document.addEventListener?.('keydown', onKey)
        return () => {
          document.removeEventListener?.('mousedown', onDown)
          document.removeEventListener?.('keydown', onKey)
        }
      }, [menuOpen])

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
        if (noteTimer.current !== null) window.clearTimeout(noteTimer.current)
        setNote({ text, tone })
        noteTimer.current = window.setTimeout(() => {
          noteTimer.current = null
          if (alive.current) setNote(null)
        }, NOTE_MS[tone] ?? NOTE_MS.ok)
      }

      const busy = phase !== 'plain'
      const empty = draft.trim() === ''

      /**
       * 发起优化；生成中再次点击 = 取消。
       *
       * 走**流式**路由（SSE）：增量到达就写回草稿，所以用户能看到文本被"边生成边替换"。
       * 流式不可用（旧宿主 404/405、浏览器拿不到 `response.body`、网络层失败）时自动回退到
       * 一次性 JSON 路由——流式是增强，不该在任何环境里变成新的失败面。
       *
       * CAS 在流式下必须换个判据：写入是我们自己做的，所以不能用 `draftRev`（每次写入都会变），
       * 而是记下"本次调用里我们写过的每一版文本"——用户手改会让当前草稿落在集合之外，此时立即中止
       * （详见 `write()` 的注释）。
       * @param {string | undefined} presetId - 宿主预设 id（`/catalog` 下发），省略即用默认提示词。
       * @returns {Promise<void>} 完成。
       */
      const onOptimize = async (presetId) => {
        if (running) {
          abort.current?.abort()
          return
        }
        setMenuOpen(false)
        const current = live.current.input
        if (current.phase !== 'plain') { flash(t('busy'), 'warn'); return }
        if (current.draft.trim() === '') { flash(t('empty'), 'warn'); return }
        // 整体 setDraft 会把芯片拉平成纯文本，宁可不做也不悄悄毁掉引用。
        // （老版本 InputState 可能没有 occurrences，缺字段按"无芯片"处理。）
        if ((current.occurrences ?? []).length > 0) { flash(t('chips'), 'warn'); return }
        // 长度上限也以宿主为准（limits 来自 /catalog）：先在本地说清楚，别等宿主 400。
        if (current.draft.length > limits.maxInputChars) {
          flash(`${t('tooLong')}（${String(current.draft.length)}/${String(limits.maxInputChars)}）`, 'warn')
          return
        }

        const before = current.draft
        // 勾选的风格在**发起这一刻**定住：之后用户再改勾选不该影响这一次请求。
        const styleIds = [...selectedStyles]
        const controller = new AbortController()
        abort.current = controller
        forceArmed.current = null
        setRunning(true)
        /**
         * 本次调用里"可能是我们自己造成的"草稿取值集合：原文 + 我们写过的每一版。
         *
         * 为什么不用 `draftRev`：流式下每次写入都会推进 revision，自己写的东西会被自己判成"用户改过"。
         * 也不用"最后一次写入 == 当前草稿"这种精确比对：写完之后组件未必立刻重渲染，于是渲染快照里的
         * `draft` 可能还停在上一版——那也会被误判。用集合就同时容忍"快照滞后"和"多次写入"，
         * 而真正的用户手改几乎不可能恰好等于我们写过的某一版。
         */
        const own = new Set([before])
        /** 已到达的增量（用于节流写入）。 */
        let accumulated = ''
        let lastWriteAt = 0
        /** 是否因为"用户中途手改"而中止（决定收尾要不要提示）。 */
        let userEdited = false

        /**
         * 写回一次草稿（节流；`force` 用于收尾那次）。
         * @param {string} text - 要写入的文本。
         * @param {boolean} force - 是否忽略节流。
         * @returns {boolean} 是否写成功（false = 用户中途改过，调用方应中止）。
         */
        const write = (text, force) => {
          const now = Date.now()
          if (!force && now - lastWriteAt < STREAM_WRITE_MS) return true
          if (!own.has(live.current.input.draft)) return false
          live.current.inputActions.setDraft(text)
          own.add(text)
          lastWriteAt = now
          return true
        }

        /**
         * 收尾：写入最终文本、压一条撤销记录、提示结果。
         * @param {string} text - 最终文本。
         * @param {boolean} truncated - 是否被输出上限截断。
         * @returns {void}
         */
        const commit = (text, truncated) => {
          pushUndo(sessionId, { before, after: text })
          setStackVersion((version) => version + 1)
          flash(truncated ? t('doneTruncated') : t('done'), 'ok')
        }

        try {
          const outcome = await requestOptimizeStream({
            text: before,
            sessionId,
            ...presetId === undefined ? {} : { presetId },
            styleIds,
            signal: controller.signal,
            t,
            onDelta: (delta) => {
              accumulated += delta
              if (!write(accumulated, false)) {
                // 用户在中途改了草稿：立刻停止（宿主侧也会因断开而取消上游），收尾时给一句提示。
                userEdited = true
                controller.abort()
              }
            },
          })
          if (!alive.current) return
          if (controller.signal.aborted) {
            if (userEdited) flash(t('staleResult'), 'warn')
            return
          }

          if (outcome.unavailable === true) {
            // 回退：先把增量留下的痕迹还原，再用一次性 JSON 的结果走原本的 CAS 与收尾。
            if (own.size > 1) write(before, true)
            const fallback = await requestOptimize({
              text: before,
              sessionId,
              ...presetId === undefined ? {} : { presetId },
              styleIds,
              signal: controller.signal,
              t,
            })
            if (!alive.current || controller.signal.aborted) return
            if (!fallback.ok) { flash(fallback.message, 'error'); return }
            if (live.current.input.draft !== before) { flash(t('staleResult'), 'warn'); return }
            write(fallback.text, true)
            commit(fallback.text, fallback.truncated)
            return
          }

          if (!outcome.ok) {
            // 流中途失败（error 帧 / 空结果）：把已经写进去的增量还原成原文，别留半截草稿。
            const partialWritten = own.size > 1
            if (partialWritten) write(before, true)
            flash(partialWritten ? `${outcome.message}（${t('streamReverted')}）` : outcome.message, 'error')
            return
          }
          if (!write(outcome.text, true)) { flash(t('staleResult'), 'warn'); return }
          commit(outcome.text, outcome.truncated)
        } catch {
          if (!controller.signal.aborted) {
            if (own.size > 1) write(before, true)
            flash(t('fail'), 'error')
          }
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
        // 返回 promise 便于测试驱动（React 不关心返回值）；生成中再点 = 取消。
        onClick: () => onOptimize(undefined),
      }, running
        ? (IconLoading === null ? '…' : React.createElement(IconLoading, { size: 14 }))
        : (IconSparkle === null ? '✨' : React.createElement(IconSparkle, { size: 14 }))))

      // 菜单：只有宿主真给了风格或预设才出现，所以拿不到目录（离线）时视觉与从前一致。
      // 风格区（多选勾选）+ 预设区（点一次就跑）分开，因为两者的语义不同：
      // 风格是"叠加的长期偏好"，预设是"本次额外要求"，主机侧也是按这个顺序拼 system prompt 的。
      const oneShotPresets = presets.filter(preset => !styles.some(style => style.id === preset.id))
      const toggleStyle = (id) => {
        setSelectedStyles(current => current.includes(id)
          ? current.filter(item => item !== id)
          : [...current, id])
      }
      if (styles.length > 0 || oneShotPresets.length > 0) {
        children.push(React.createElement('button', {
          key: 'preset-toggle',
          type: 'button',
          className: 'dsh-better-input',
          'data-dsh-better-input-preset-toggle': ENTRY_ID,
          'data-state': menuOpen ? 'open' : 'closed',
          'data-selected': selectedStyles.length,
          'aria-label': t('preset.menu'),
          'aria-haspopup': 'menu',
          'aria-expanded': menuOpen,
          title: t('preset.menu'),
          disabled: running || disabled,
          onMouseDown: (event) => { event.preventDefault() },
          onClick: () => setMenuOpen(open => !open),
        }, selectedStyles.length === 0 ? '▾' : `▾${String(selectedStyles.length)}`))
        if (menuOpen) {
          const items = []
          if (styles.length > 0) {
            items.push(React.createElement('div', {
              key: 'style-head',
              className: 'dsh-better-input-menu-head',
            }, t('style.menu')))
            items.push(...styles.map(style => React.createElement('label', {
              key: `style-${style.id}`,
              className: 'dsh-better-input-menu-check',
              title: style.label,
            }, [
              React.createElement('input', {
                key: 'box',
                type: 'checkbox',
                checked: selectedStyles.includes(style.id),
                'data-dsh-better-input-style': style.id,
                onChange: () => { toggleStyle(style.id) },
              }),
              React.createElement('span', { key: 'label' }, style.label),
            ])))
            items.push(React.createElement('button', {
              key: 'style-apply',
              type: 'button',
              className: 'dsh-better-input-menu-item dsh-better-input-menu-action',
              'data-dsh-better-input-apply': ENTRY_ID,
              title: selectedStyles.length === 0 ? t('style.noneSelected') : t('style.apply'),
              onMouseDown: (event) => { event.preventDefault() },
              onClick: () => onOptimize(undefined),
            }, t('style.apply')))
          }
          if (oneShotPresets.length > 0) {
            items.push(React.createElement('div', {
              key: 'preset-head',
              className: 'dsh-better-input-menu-head',
            }, t('preset.menu')))
            items.push(...oneShotPresets.map(preset => React.createElement('button', {
              key: preset.id,
              type: 'button',
              role: 'menuitem',
              className: 'dsh-better-input-menu-item',
              'data-dsh-better-input-preset': preset.id,
              title: preset.label,
              onMouseDown: (event) => { event.preventDefault() },
              onClick: () => onOptimize(preset.id),
            }, preset.label)))
          }
          children.push(React.createElement('div', {
            key: 'preset-menu',
            className: 'dsh-better-input-menu',
            role: 'menu',
            'data-dsh-better-input-menu': ENTRY_ID,
          }, items))
        }
      }

      return React.createElement(
        'span',
        { className: 'dsh-better-input-wrap', 'data-dsh-better-input-wrap': ENTRY_ID },
        children,
      )
    }

    /* ── 宿主只读路由（目录 / 试调 / 规则与预设） ────────────────────────── */

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
     * `/catalog` 的兜底值：宿主没到（离线/请求失败）时用它保证功能不瘫。
     *
     * 正常路径下**一律以宿主下发的 `limits` 为准**（见 `LIMITS_FALLBACK` 的注释）：
     * 客户端不再维护一份会漂移的镜像。
     */
    const LIMITS_FALLBACK = Object.freeze({
      maxInputChars: 8000,
      temperature: { min: 0, max: 2 },
      maxOutputTokens: { min: 1, max: 200000 },
      timeoutMs: { min: 1000, max: 600000 },
    })

    /** 输入框与设置页共用的 `/catalog` 缓存（每次页面加载最多一次往返）。 */
    let catalogOnce

    /**
     * 取一次 `/catalog`（成功结果缓存；失败不缓存，下次再试）。
     * @returns {Promise<{ limits: object, presets: object[], styles: object[], raw: object }>} 规则、预设与风格。
     */
    function catalogShared() {
      if (catalogOnce === undefined) {
        catalogOnce = requestCatalog()
          .then((data) => {
            const limits = data?.limits !== undefined && data.limits !== null ? data.limits : LIMITS_FALLBACK
            const presets = Array.isArray(data?.presets) ? data.presets.filter(preset => typeof preset?.id === 'string') : []
            // 风格清单同样以宿主为准（客户端只镜像"字段名"，不镜像"有哪些风格"）。
            const styles = Array.isArray(data?.styles) ? data.styles.filter(style => typeof style?.id === 'string') : []
            return { limits, presets, styles, raw: data }
          })
          .catch((error) => {
            catalogOnce = undefined
            throw error
          })
      }
      return catalogOnce
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
        // 逐风格提示词：空串 = 未配置，宿主会回落到组合配置同 id 的预设/内置默认。
        ...Object.fromEntries(STYLE_FIELDS.map(field => [field, text(value[field])])),
      }
    }

    /**
     * 客户端预校验：规则**以宿主下发的 `limits` 为准**（`/catalog` 的 `limits` 字段，
     * 来源就是宿主 `lib/policy.js` 的 `TEMPERATURE_RANGE` / `MAX_OUTPUT_TOKENS_RANGE` /
     * `TIMEOUT_RANGE`）。宿主没到（离线/请求失败）时才退到 `LIMITS_FALLBACK`。
     *
     * 上界必须查：宿主 `validate` 会拒绝超界写入，而 `settingsScope.mutate()` 在宿主拒绝时
     * **不会 reject**——只查下界的话，填 700000 会先过预校验、再由宿主静默拒绝
     * （见 `opsApplied` 的注释）。
     * @param {object} form - 表单值。
     * @param {(key: string) => string} t - 词典。
     * @param {object} limits - 区间（宿主下发或兜底）。
     * @returns {Record<string, string>} 字段 → 错误文案。
     */
    function validateForm(form, t, limits) {
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
      if (temperature === null
        || (temperature !== undefined
          && (temperature < limits.temperature.min || temperature > limits.temperature.max))) {
        errors.temperature = t('settings.err.temperature')
      }
      const maxOutputTokens = integerOr(form.maxOutputTokens)
      if (maxOutputTokens === null
        || (maxOutputTokens !== undefined
          && (maxOutputTokens < limits.maxOutputTokens.min || maxOutputTokens > limits.maxOutputTokens.max))) {
        errors.maxOutputTokens = t('settings.err.maxOutputTokens')
      }
      const timeoutMs = integerOr(form.timeoutMs)
      if (timeoutMs === null
        || (timeoutMs !== undefined
          && (timeoutMs < limits.timeoutMs.min || timeoutMs > limits.timeoutMs.max))) {
        errors.timeoutMs = t('settings.err.timeoutMs')
      }
      return errors
    }

    /**
     * 校验一批 path ops 是否真的落到了设置镜像上。
     *
     * **必须自己查**：`settingsScope.mutate()` 在宿主拒绝时**不会 reject**——它内部
     * `recover()` 之后正常返回（`dsh-client-ui-settings` 的 `SettingsScopeController.mutate`：
     * `if (!response.ok) { await this.recover(generation); return }`），而 Remote 把载体失败
     * 折进 `{ ok:false }` 分支、只有装配错误才抛。所以直接 `await` 就报"已保存"是假的。
     * 判据用**值**而不是 revision：并发写入被拒时 revision 也可能已被别人推进过。
     * @param {Array<{ op: string, path: string[], value?: unknown }>} ops - 刚发出的 ops。
     * @param {unknown} value - 提交后镜像里的用户层值。
     * @returns {boolean} 是否全部生效。
     */
    function opsApplied(ops, value) {
      const section = value !== null && typeof value === 'object' ? value : {}
      return ops.every(op => op.op === 'set'
        ? section[op.path[0]] === op.value
        : section[op.path[0]] === undefined)
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
      // 逐风格提示词：清空就 unset（回落到组合配置/内置默认），与 systemPrompt 同一套语义。
      for (const field of STYLE_FIELDS) {
        const prompt = form[field].trim() === '' ? undefined : form[field]
        push(field, prompt, typeof base[field] === 'string' ? base[field] : undefined)
      }
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
      /** 提示的自动消失计时器：换提示前先撤掉旧的。 */
      const noteTimer = React.useRef(null)

      const flash = (text, tone) => {
        if (noteTimer.current !== null) window.clearTimeout(noteTimer.current)
        setNote({ text, tone })
        noteTimer.current = window.setTimeout(() => {
          noteTimer.current = null
          if (alive.current) setNote(null)
        }, NOTE_MS[tone] ?? NOTE_MS.ok)
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

      React.useEffect(() => () => {
        alive.current = false
        if (noteTimer.current !== null) window.clearTimeout(noteTimer.current)
      }, [])
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
        const validation = validateForm(form, t, limits)
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
          // mutate 不抛也可能没写成（见 opsApplied）：先验后报，别假报"已保存"。
          if (!opsApplied(ops, scope.getSnapshot().value)) {
            flash(`${t('settings.saveFailed')}：${t('settings.err.notApplied')}`, 'error')
            void loadCatalog()
            return
          }
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
        const ops = FIELD_KEYS.map(field => ({ op: 'unset', path: [field] }))
        setBusy(true)
        try {
          await scope.mutate(ops, snapshot.revision)
          if (!opsApplied(ops, scope.getSnapshot().value)) {
            flash(`${t('settings.resetFailed')}：${t('settings.err.notApplied')}`, 'error')
            void loadCatalog()
            return
          }
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
        // 笼统的一句"设置服务不可用"没法排查：宿主侧 `/catalog` 会带上具体原因
        // （注册被拒的错误消息），有就照实显示。真正的原因多半在启动日志里。
        const reason = catalogData?.settings?.available === false && typeof catalogData.settings.reason === 'string'
          ? catalogData.settings.reason
          : null
        return React.createElement('div', { className: 'dsh-bi-form', 'data-dsh-bi-settings': 'unavailable' },
          React.createElement('p', { className: 'dsh-bi-note', 'data-tone': 'warn' }, t('settings.unavailable')),
          reason === null
            ? null
            : React.createElement('p', {
              className: 'dsh-bi-note',
              'data-tone': 'error',
              'data-dsh-bi-unavailable-reason': 'host',
            }, `${t('settings.unavailableReason')}${reason}`),
          snapshot.mode === 'memory'
            ? React.createElement('p', { className: 'dsh-bi-note', 'data-tone': 'warn' }, t('settings.readonly'))
            : null,
        )
      }

      const editable = snapshot.writable === true && busy !== true
      const providers = Array.isArray(catalogData?.providers) ? catalogData.providers : []
      // 区间以宿主下发为准（`/catalog` 的 limits）；宿主没到才用兜底，避免离线时功能瘫掉。
      const limits = catalogData?.limits ?? LIMITS_FALLBACK
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
        // 用 <label for> 给出可访问名：之前这个 textarea 只有 placeholder，没有关联标签。
        React.createElement('label', { className: 'dsh-bi-label', htmlFor: 'dsh-bi-prompt' }, t('settings.prompt.body')),
        React.createElement('textarea', {
          id: 'dsh-bi-prompt',
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
            min: limits.temperature.min,
            step: 0.1,
          }), { error: errors.temperature }),
          row('settings.params.maxOutputTokens', numberInput('maxOutputTokens', {
            placeholder: t('settings.params.placeholder'),
            min: limits.maxOutputTokens.min,
            step: 1,
          }), { error: errors.maxOutputTokens }),
          row('settings.params.timeoutMs', numberInput('timeoutMs', {
            placeholder: t('settings.params.placeholder'),
            min: limits.timeoutMs.min,
            step: limits.timeoutMs.min,
          }), { error: errors.timeoutMs }),
        ),
      )

      // ── 优化风格：每个风格一个独立提示词输入框（下拉框里勾哪个就用哪个的提示词）──
      // 清单以宿主下发的 `styles` 为准（含它算出来的生效来源）；宿主没到（离线）时退回
      // 本地镜像的 id + 词典里的标签，保证表单仍可编辑、仍能保存。
      const hostStyles = Array.isArray(catalogData?.styles)
        ? catalogData.styles.filter(style => typeof style?.id === 'string' && STYLE_FIELDS.includes(stylePromptField(style.id)))
        : []
      const styleEntries = hostStyles.length > 0
        ? hostStyles
        : STYLE_IDS.map(id => ({ id, label: t(`style.${id}`), source: 'default' }))
      const styleFieldset = React.createElement(
        'fieldset',
        { className: 'dsh-bi-fieldset' },
        React.createElement('legend', { className: 'dsh-bi-legend' }, t('settings.style.legend')),
        React.createElement('span', { className: 'dsh-bi-hint' }, t('settings.style.hint')),
        ...styleEntries.map((style) => {
          const field = stylePromptField(style.id)
          const source = typeof style.source === 'string' ? style.source : 'default'
          return React.createElement('div', { className: 'dsh-bi-row', key: field },
            React.createElement('label', { className: 'dsh-bi-label', htmlFor: `dsh-bi-${field}` },
              style.label ?? style.id),
            React.createElement('textarea', {
              id: `dsh-bi-${field}`,
              className: 'dsh-bi-textarea dsh-bi-textarea--style',
              value: form[field] ?? '',
              disabled: !editable,
              placeholder: t('settings.style.placeholder'),
              'data-dsh-bi-field': field,
              onChange: event => { update(field, event.target.value) },
            }),
            // 只显示"当前生效的是哪一层"，不回灌提示词正文（正文留在宿主）。
            React.createElement('span', { className: 'dsh-bi-hint' },
              `${t('settings.style.source')}：${t(`settings.source.${source}`)}`),
          )
        }),
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
        styleFieldset,
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
