# BetterInput — Web 输入框「AI 优化提示词」按钮插件设计

> 目标：在 DSH Web GUI 的输入框工具行里、**模型选择器左侧**加一个按钮；点击后把输入框当前内容交给 AI 按**可自定义的提示词**优化，把结果**替换回输入框**，并支持**撤销**。
>
> 本文所有接口结论都来自实际代码核对（已安装的 `@deepseek-ai/dsh@0.1.2-rc.1` + 本地源码检出 `D:\SSDWP\AI\deepseek-harness`），每条都给了证据路径，可直接查证。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 插件形态 | **单包双半**（Node 半 + 浏览器半），第三方 `dsh` 插件标准形态 |
| 按钮挂载点 | 座位 `conversation.input.right`（list 座位）→ 渲染在**模型选择器紧左边**；若想和左侧控件成组则用 `conversation.input.left` |
| 读输入框 | 座位组件被框架注入 `useInput(sel)` 与 owner props `input`，用 `input.draft` 读 |
| 写输入框 | `inputActions.setDraft(text)`（官方「整体替换草稿」接口），**不要碰 DOM** |
| 撤销 | 必须自建撤销栈（程序化写入不进编辑器原生 undo 历史），配 CAS 校验 + 栈深 |
| 自定义提示词 | L1 cordis 配置（schemastery `Config`）→ L2 settings 命名空间 → L3 GUI 预设菜单，分三期 |
| 调模型 | 宿主半用 `ctx.llm.stream()` + `BlockAssembler`（照抄 `dsh-session-title-llm` 的成熟姿势）；路由取插件配置或 `ctx.agentDefaultModel.currentSelection()` |
| 前后端传输 | 宿主半注册 HTTP 路由 `ctx.webServer.register(...)`，浏览器半同源 `fetch`（社区插件 `@linxin666/dsh-client-ui-skill-explorer` 已验证此路径） |
| 构建 | 客户端 bundle 是 `window.__ModuleLoader__.load({id, factory})` 的 CJS 工厂，**可手写 JS，无需构建工具** |
| 开发循环 | 客户端半改动：保存 `lib/client.js` 即被 `dsh-client-hmr`（500ms stat-poll）热替换；宿主半改动需重启 `dsh web` |

---

## 0.5 实施进展（P0 + P1 已交付）

| 文件 | 作用 |
|---|---|
| `package.json` | 双半声明（`main` + `exports["./client"]` + `dsh.client` / `dsh.bundle.patch`） |
| `cordis.patch.yml` | 把自己 insert 进插件树，内含唯一的配置入口 |
| `lib/policy.js` | 零依赖策略层：配置校验、信任围栏、提示词拼装、JSON 收发 |
| `lib/index.js` | 宿主半：`ctx.webServer` 路由 + `ctx.llm.stream()` + `BlockAssembler` |
| `lib/client.js` | 浏览器半：座位注册 + 按钮组件（手写 bundle，无构建步骤） |
| `lib/types/*.d.ts` | 对外契约类型 |
| `test/smoke.mjs`、`test/client.smoke.mjs` | 24 个用例：宿主 16 + 浏览器 8，全绿 |

**验收证据**：P0 已在 Web GUI 目视确认——按 README 的方式 A 装入 profile 后，按钮出现在输入框工具行右侧、模型选择器紧左边（2026-09-10）。P1 的路由尚未在真实宿主上 curl 过（单测用假 LLM 流覆盖了全部分支）。

实施期确认/修正的几点：

1. **包名与 bundle id 必须一致** —— 定为 `dsh-better-input`，客户端 bundle 里写死同名字面量（宿主按包名组合 boot graph，不一致会加载不到）。
2. **客户端半拿不到插件配置**（新发现，已影响设计）：web shell 用 `o.create({ name })` 创建客户端条目，boot graph 行只有 `{ id, url, rev, inject, immediately }`，没有 config 字段。所以 `seat` / `presets` 这类**客户端**选项只能由插件自己的 HTTP 路由下发；P0 先把座位写死为 `conversation.input.right`（改 `left` 是一行）。
3. **`presets` 已在宿主侧实现**：`presetId` → 对应 `prompt` 追加到 system，未知名报 400。P4 只是补前端菜单 UI。
4. **max-tokens 截断改为「返回已获得文本 + `truncated: true`」**，不当失败——撤销按钮兜底，比丢结果更有用。
5. **可测性驱动分层**：`lib/policy.js` 刻意零 `@deepseek-ai` 依赖，因此宿主半能用假 ctx 驱动**真实**路由处理器（真的 `createUserMessage` / `BlockAssembler`，只把 `ctx.llm.stream` 换成替身）；浏览器半用极小 React 替身钉住「框架注入 props 的假设」与座位注册参数。

---

## 1. 需求拆解

| # | 需求 | 落点 |
|---|---|---|
| R1 | 按钮在模型左侧 | 座位系统（`conversation.input.right` / `.left`） |
| R2 | 点击 → AI 优化输入框内容 | 浏览器半取 draft → 宿主半调 LLM → 返回文本 |
| R3 | 提示词可自定义 | 插件配置 / settings 命名空间 / GUI 预设菜单 |
| R4 | 结果替换回输入框 | `inputActions.setDraft()` |
| R5 | 可撤销 | 插件自建撤销栈 + 撤销按钮 |

**非目标（v1 明确不做）**：流式逐字回填、只优化选中片段、保留 `@引用/斜杠` 芯片的语义化重写、把优化历史持久化到会话。

---

## 2. 架构：单包双半

```
D:\SSDWP\AI\dsh\BetterInput\        (包根 = 工作区根)
├─ package.json                     dsh.client / dsh.bundle.patch 声明
├─ cordis.patch.yml                 把自己 insert 进 profile 插件树
├─ lib\index.js                     宿主半：HTTP 路由 + LLM 调用
├─ lib\client.js                    浏览器半：座位注册 + 按钮组件 + 撤销栈
├─ lib\types\*.d.ts                 对外类型（构建产物，手写亦可）
└─ src\  tests\                     可选：TS 源码与测试
```

两条链路：

```
[浏览器半]                                  [宿主半]
conversation.input.right 座位
  └ OptimizeButton
      ├ 读 draft ─────────────────────────► POST /api/dsh-input-optimizer/optimize
      │                                      { text, presetId, sessionId }
      │                                        └ 信任围栏(loopback+同源)
      │                                        └ 取 system prompt(配置)
      │                                        └ ctx.llm.stream() + BlockAssembler
      │◄─────────────────────────────────────  { text: "优化后文本" }
      ├ inputActions.setDraft(text)
      └ 压入撤销栈（before/after/draftRev）
```

**为什么必须是双半**：浏览器里没有模型凭据，也不该有；LLM 调用必须发生在宿主进程。这一点由 `dsh-llm-deepseek` 的凭据存储方式决定（`~/.dsh/.credentials.yaml`）。

---

## 3. 客户端半设计

### 3.1 按钮挂在哪个座位（R1）

座位是 `ui-slots` 的声明式扩展点。`conversation.input.*` 家族的定义在
`packages/client/ui-conversation/src/client/contract/slots.ts`：

| 座位 | kind | 语义（原文注释） |
|---|---|---|
| `conversation.input.left` | list | 「Compact controls at the left of the composer tool row」 |
| `conversation.input.right` | list | 「Compact controls before the composer submit action」 |
| `conversation.input.plan` | single | 紧贴 access-mode 控件右侧 |
| `conversation.input.model` | **single** | 「the named model-select seat at the right end of the composer tool row, **left of the send button**」 |
| `conversation.input.overlay` | list | 卡片内浮层（弹窗/popover 专用） |

实际渲染顺序（`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:732-795`）：

```tsx
<div className={css.row}>
  <div className={css.tools}>            {/* 左组 */}
    [+]  {accessSelect}  {renderSlot('conversation.input.plan')}  {leftItems}
  </div>
  <div className={css.trailing}>         {/* 右组：右对齐 */}
    {rightItems}  {renderSlot('conversation.input.model')}  <ContextMeter/>  [发送]
  </div>
</div>
```

**结论**：
- 要「模型紧左边」→ 注册进 **`conversation.input.right`**（同组、就在 model 座之前）。
- 要「和左侧那排控件一起」→ 注册进 **`conversation.input.left`**。
- 默认推荐 `conversation.input.right`，并在配置里留 `seat: 'right' | 'left'` 开关，让用户自己选（两条注册路径代码只差一个字符串）。

### 3.2 注册代码（已核对签名）

`SlotRegistry.register` 的语义来自 `packages/client/ui-renderer/src/client/registry.ts` 与
`packages/client/ui-slots/src/index.ts`（`SlotCore.register`）：**list 座位必须给 `id`**；重复 `(id, priority)` 会抛错；
注册用调用者 fiber 的 `ctx.effect` 托管，插件卸载即回收。
`slots.inject(key, cb)` 解决「座位还没被父条目声明」的启动顺序问题（回调在声明提交后同步执行）。

参考实现（`dsh-client-ui-model-selection/lib/client.js:873-892`）的写法：

```js
/** 浏览器半入口 */
const inject = ['slots', 'locale']            // slots 来自 ui-renderer，locale 来自 dsh-client-locale
const NS = 'inputOptimizer'

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'better-input: dictionaries')

  ctx.inject(['slots'], (scope) => {
    // 座位由 ui-conversation 的 composer bar 声明；inject 保证按声明先后执行
    scope.slots.inject(SEAT, () => scope.slots.register({
      name: SEAT,                 // 'conversation.input.right'
      id: 'better-input',         // list 座位必需
      order: 10,                  // 同组内排序
      locale: NS,                 // 注入 t()
      inject: (sessionId) => ({    // 业务面（本插件自己的注入）
        optimize: (presetId) => callHost({ text: ..., presetId, sessionId }),
        undo: () => undoStack.pop(sessionId),
        canUndo: (sessionId) => undoStack.canUndo(sessionId),
      }),
    }, OptimizeButton))
  })
}
```

> 组件只需要 `react`（平台种子模块），不需要 import 任何 DSH 客户端包——**类型**从
> `@deepseek-ai/dsh-client-ui-slots` 之类引入，构建时被擦除，不产生运行时依赖。

### 3.3 组件拿到什么 props（读写输入框的关键）

会话作用域座位组件的 props 由三段合并而成（`ui-slots/src/index.ts:211` 的 `PropsRuntime`）：

1. **owner props**：`conversation.input.left/right` 的 owner 是 `InputZone = { session, input }`
   （`ui-conversation/src/client/contract/slots.ts:274`），其中 `input: InputState` 是**点快照**，骨架在任一 store 变化时重渲染，条目无需自己订阅。
2. **session standard kit**（两处 declaration merge 合并的结果）：
   - `ui-conversation`：`useInput: SnapshotSelectorHook<InputState>`、`inputActions: InputActions`
   - `client/runtime`：`sessionId`、`useSession`、`useProjection`
3. **本插件的 inject 面** + `t()`。

`InputState`（`ui-conversation/lib/types/client/contract/input.d.ts:295`）关键字段：

```ts
readonly draft: string            // 剪贴板投影：芯片已展开为剪贴板形态
readonly draftRev: number         // 单调编辑器修订号（span CAS 基准）
readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
readonly occurrences: readonly Occurrence[]   // 编辑器里芯片（引用/命令）的出现位置
readonly imageIds: readonly DraftAttachmentId[]
```

`InputActions` 里的写入口：`setDraft(text)`、`submit()`、`addImages/removeImage/pruneImages`。

所以：

```jsx
function OptimizeButton(props) {
  const { input, useInput, inputActions, sessionId, t, optimize, undo } = props
  const draft = useInput(s => s.draft)          // 响应式读
  const busy = input.phase !== 'plain'
  const hasChips = input.occurrences.length > 0

  const onClick = async () => {
    const before = draft
    const rev = input.draftRev
    if (before.trim() === '' || busy) return
    const after = await optimize(presetId)      // 宿主往返
    // CAS：只有草稿没被别人改过才替换
    if (inputActions /* 当前 */ && currentRev() === rev) inputActions.setDraft(after)
    pushUndo(sessionId, { before, after })
  }
  ...
}
```

**红线**：
- ❌ 不要 `querySelector` 改输入框 DOM。已安装版本的 composer 是 Lexical contenteditable + 芯片节点（`lib/types/client/input/editor/ComposerContentEditable.d.ts`、`chip-node.d.ts`），DOM 改法会被下一次渲染冲掉，还会绕过输入机状态机。（本地源码检出的 `InputBar.tsx` 已改为 `textarea + backdrop` 方案——**两版都靠同一套 `draft`/`setDraft` 契约**，这正是不要碰 DOM 的理由。）
- ❌ 不要用 `ComposerKeyboard.caretSpan()/paste()` 做「只替换选区」：那是 `InputBar` 私有面，
  注释明确「package-internal, never across a plugin boundary」。

### 3.4 撤销设计（R5）

**为什么必须自建**：`setDraft` 的注释是「Replace the whole draft (persisted-draft seed and programmatic writes)」——程序化写入不会进 Lexical 的原生 undo 历史，用户按 Ctrl+Z 不一定能回到原文。

设计：

```ts
type UndoRecord = { before: string; after: string; rev: number; at: number; presetId: string }
// 每会话一条栈；插件生命周期内有效（放模块级 Map，不放 React state —— 避免座位重挂载/切会话丢栈）
const stacks = new Map<SessionId, UndoRecord[]>()
const MAX_DEPTH = 10
```

撤销时的三条规则：

1. **CAS 校验**：仅当 `input.draft === record.after` 时才允许撤销，避免覆盖用户后续手改的内容。
2. **不匹配时**：按钮变为「内容已被修改，无法撤销」的禁用态（并提供「仍要恢复原文本」的二次确认，写进 tooltip）。
3. **栈式多次撤销**：连按可逐层回退（默认 10 层，配置可调）。

UI：同一个 entry 组件渲染两个按钮（`[✨ 优化]` 与 `[↶ 撤销]`），撤销按钮仅在栈非空且 CAS 通过时出现，避免再注册一个座位。

可选增强：撤销后把光标/焦点交回输入框（`inputActions` 无 focus API，需在组件里对编辑器宿主元素 `focus()`，属于可选的锦上添花）。

---

## 4. 提示词自定义（R3）：三层方案，分三期

### L1 · cordis 插件配置（第一期，最快可用）

插件导出 schemastery `Config`，用户在 `~/.dsh/profiles/web/cordis.patch.yml` 的插件行里写 `config:`：

```yaml
- insert:
    - id: better-input
      name: 'better-input'
      config:
        seat: right
        model: { provider: deepseek-official, model: deepseek-v4-flash }  # 省略则用当前选择
        systemPrompt: |
          你是提示词工程师。把用户草稿改写成更清晰、无歧义、结构化的任务描述。
          保留原有语言；不要回答问题本身；只输出改写后的文本。
        presets:
          - { id: concise,  label: '精简',   prompt: '压缩冗余，保留全部约束。' }
          - { id: spec,     label: '转规格', prompt: '改写成含验收标准的需求条目。' }
        maxInputChars: 8000
        timeoutMs: 30000
        maxOutputTokens: 1024
        undoDepth: 10
```

规范要求（`docs/user/develop/basic/config.md`、`dsh-session-title-llm` 的 `resolve*Config` 模式）：
- 用 `z.object({...})` 显式声明字段；**`required()` 的字段缺失会让 profile 启动失败**（fail loud），所以除 `systemPrompt` 外一律给 `.default()`。
- 未知 key 要主动报错（照抄 `session-title-llm` 的 `CONFIG_KEYS` 校验），避免用户拼错字段却以为生效了。
- `provider`/`model` 必须成对出现，只给一个是配置错误。

### L2 · settings 命名空间（第二期）

`ctx.settings.register(settingsNamespace('better-input'), schema, ...)`：
- 用户级配置从 `cordis.patch.yml` 挪到 `settings.yaml`，可运行时热更新（`applies: 'live'`，宿主半必须**订阅**该命名空间的变化，而不是构造期读一次）。
- `ctx.settings.describe()` 会把命名空间（含 schemastery `toJSON()`）暴露给配置界面；但 Settings 面板的每个分区都是手写组件（`settings.section` 是 list 座位，`packages/client/ui-settings-plugins`、`ui-settings-models` 各自注册自己的分区），**不会自动为你渲染表单**。所以「图形化编辑提示词」需要自己注册 `settings.section` 或 `settings.general.item` 座位。

### L3 · 输入框旁的预设菜单（第三期）

预设列表做成按钮上的下拉/popover：
- 浮层挂在 `conversation.input.overlay`（list 座位，「Floating entries rendered inside the resident composer card」）——这正是 `ui-commands` 的 popupSelect 外壳用的位置，属于官方推荐姿势；
- 或者注册一个客户端命令 `/optimize`（`ctx.commandUi.register({ ui: { kind: 'popupSelect', ... } })`，照抄 `dsh-client-ui-model-selection` 的 `/model`），让预设走键盘流。
- 提示词编辑（增删改）复用 L2 的 settings 写入，避免自己造持久化。

---

## 5. 宿主半设计

### 5.1 HTTP 路由（前后端传输）

`ctx.webServer`（`@deepseek-ai/dsh-host-webserver`）：
`register({ kind: 'exact' | 'prefix', path, handler }): () => void`，handler 是原生
`(req: IncomingMessage, res: ServerResponse) => void | Promise<void>`，**自己负责完整响应生命周期**。

```js
// lib/index.js（宿主半）
export const name = 'better-input'
export const inject = ['webServer', 'llm']        // + 'agentDefaultModel' 可选

export function apply(ctx, config) {
  const resolved = resolveConfig(config)          // 校验 + 填默认值 + 冻结
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-input-optimizer/optimize',
    async handler(req, res) {
      if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' })
      if (!isLoopbackRequest(req)) return send(res, 403, { error: 'forbidden' })   // 信任围栏
      const body = await readJsonBody(req, MAX_BODY_BYTES)                        // 上限保护
      ...
      const text = await optimize(ctx, resolved, body)
      send(res, 200, { text })
    },
  })
  ctx.effect(() => dispose)
}
```

**信任围栏**：这条路由能用宿主里存的模型凭据去调模型，必须只服务本机浏览器。
社区插件 `dsh-client-ui-skill-explorer` 的做法（其 `lib/types/loopback.d.ts`）可直接照搬：
socket 远端地址属于 `127/8`、`::1`、`::ffff:127/8`；`Host` 头为本机名；再加浏览器同源标记
（`Sec-Fetch-Site` / `Origin`）。**绝不信任 `X-Forwarded-For`**。

别的保护：body 大小上限、`text` 长度上限、请求超时（`deadline()`）、每会话并发 1 次、客户端断开时 `AbortSignal` 取消上游调用。

### 5.2 调 LLM（已核对的确切姿势）

照抄 `packages/session/session-title-llm/src/index.ts:229-294`（官方唯一的「辅助一次性模型调用」范式）：

```js
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'

const messages = [createUserMessage({
  content: [{ type: 'text', text: framedUserPayload }],   // JSON 包裹，防止用户文本破坏结构
  source: { kind: 'plugin', plugin: 'better-input' },
})]
const options = {
  provider, model,
  messages, system: systemPrompt,
  maxTokens: resolved.maxOutputTokens,
  sessionId,                       // 可选：适配器可能映射为对模型隐藏的传输元数据
  signal: deadline.signal,
  // purpose 保持不填（见风险 R-1）
}
const assembler = new BlockAssembler()
for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
// finish 检查：'stop' 正常；'max-tokens' / 'error' / 'aborted' / 'tool-calls' 都转成错误
const text = assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('\n')
```

**路由（provider/model）解析优先级**：
1. 插件配置显式给出的 `model.provider` / `model.model`；
2. 否则 `ctx.agentDefaultModel.currentSelection()`（用户在模型选择器里当前选的那个，`dsh-api-proxy` 的 `selectModel` 会同步写入这个默认值）；
3. 都没有 → 返回明确错误，前端提示「请先在配置里指定模型」。

### 5.3 数据契约

```
POST /api/dsh-input-optimizer/optimize
→ { text: string, presetId?: string, sessionId?: string }

200 { text: string, presetId?: string, modelUsed?: { provider, model } }
400 { error: 'bad-request' | 'text-too-long' | 'empty-text', message }
403 { error: 'forbidden' }
405 { error: 'method-not-allowed' }
502 { error: 'model-failed', message }
504 { error: 'timeout' }
```

约定：**永远返回 UTF-8 JSON**；错误体带人类可读 `message`，前端直接展示（可走 composer 通知）。

---

## 6. 状态机与边界情况

| 场景 | 行为 |
|---|---|
| 空/纯空白草稿 | 按钮禁用 |
| 输入超长 | 前端先截断提示；宿主二次校验并 400 |
| 生成中再次点击 | 按钮变 spinner 且禁用；提供「取消」（abort） |
| 生成中用户继续打字 | 结果返回时 CAS 失败 → 不覆盖，底部提示「草稿已变化，结果已丢弃」 |
| 草稿含 `@引用/斜杠命令` 芯片 | `occurrences.length > 0` → v1 默认拒绝并在 tooltip 说明（整体 `setDraft` 会把芯片拉平成纯文本）；配置 `allowChips: true` 可强制（明确提示会丢引用） |
| 会话已切换 | 请求带 `sessionId`；返回时校验当前会话一致，否则丢弃 |
| 模型不可路由 | 宿主返回 `model-failed`，前端提示到配置/模型选择器处理 |
| 宿主路由未挂载（enabled: false） | 前端 `fetch` 404 → 按钮降级为禁用并提示插件宿主半未启用 |
| 多次优化 | 每次压栈；撤销逐层回退；栈满丢最旧 |

---

## 7. 打包、安装、开发循环

### 7.1 package.json 关键字段（照抄已上架插件 `@linxin666/dsh-client-ui-skill-explorer`）

```json
{
  "name": "better-input",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".":        { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "dsh": {
    "engines": { "dsh": ">=0.1.2-rc.1" },
    "bundle":  { "patch": "./cordis.patch.yml" },
    "client":  { "platform": "web",
                 "inject": ["@deepseek-ai/dsh-client-locale",
                            "@deepseek-ai/dsh-client-ui-renderer",
                            "@deepseek-ai/dsh-client-ui-conversation"] }
  },
  "peerDependencies": { "react": "^18.2.0" }
}
```

字段语义（`packages/client/modules/src/index.ts:46-139`）：
- `dsh.client.platform` 必须是 `'web'`；`exports['./client']` 必须存在，否则组合期报错。
- `inject` 是包名依赖边（加载顺序/校验用），**不是**运行时的值导入。
- `immediately`（可选）：boot 第一阶段预取。
- 运行时 `require()` 只能命中平台种子表：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
  `@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-primitives`（证据：shell bundle 的 `staticModules` 种子表）。
  **跨插件的值导入是构建期错误**——所以本插件只 `require("react")`（+ 可选 primitives），其余全靠 props/服务。

### 7.2 cordis.patch.yml（把自己插入插件树）

```yaml
# 与 profile 里已有的 mcp-everything insert 同构
- insert:
    - id: better-input
      name: 'better-input'
      config:
        seat: right
        systemPrompt: |
          你是提示词工程师……
```

### 7.3 客户端 bundle 形态（可手写，无需 tsdown）

```js
// lib/client.js
window.__ModuleLoader__.load({
  id: 'better-input',                 // 必须等于包名
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports
    const React = require('react')
    const { useState } = React
    // ... 组件与 apply ...
    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
```

（构建工具版等价物见 `dsh-client-ui-model-selection/lib/client.js` 头部；用 tsdown 时它会生成同样的包装。）

### 7.4 安装

两种方式，任选：

**A. bundle 方式（与已装插件一致，推荐）**
1. `dsh plugin --profile web add link:D:\SSDWP\AI\dsh\BetterInput`（转发 pnpm，装进 profile 的 `node_modules`）
2. 在 `C:\Users\20799\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles` 里追加 `"better-input"`
3. 重启 `dsh web`

**B. 直接 patch insert（本地开发更省事）**
在 `C:\Users\20799\.dsh\profiles\web\cordis.patch.yml` 里加 7.2 的 insert 块（`name` 用绝对路径或包名均可，绝对路径见 `docs/user/develop/basic/index.md`）。

### 7.5 开发循环（重要）

- **客户端半**：`dsh-client-hmr` 每 500ms stat-poll 每行的 `lib/client.js`（比对 `mtimeMs + size`），变化即 `clientModules.rebuilt(id)` → 浏览器**原地热替换该插件**，无需刷新页面。所以**逻辑尽量放客户端半**，迭代最快（保存即生效，约 0.5s）。
  - 代价：插件内 React state 会丢（撤销栈放模块级 Map 正好不受影响）。
- **宿主半**：`lib/index.js` 改动需要重启 `dsh web`（`patchReload: live` 只监听 patch 文件，不监听插件源码）。
- 类型检查用 monorepo 检出的 `tsconfig.base.client.json`/`client.json` 参照，或独立 tsconfig + `@deepseek-ai/dsh-client-ui-slots` 等 devDependencies（已上架插件的做法）。

> 注意当前会话的沙箱是 `workspace-write`：写 `D:\SSDWP\AI\dsh\BetterInput` 没问题，但 `dsh plugin ... add` 与 `~/.dsh/profiles/web/**` 的写入会越界，需要用户手动执行或提权。

---

## 8. 分阶段实施计划与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** 骨架 | 包结构 + 空座位注册 + 按钮出现在模型左侧 | ✅ 已在 GUI 目视确认（2026-09-10） |
| **P1** 宿主路由 | `/api/dsh-input-optimizer/optimize` + 固定 system prompt + `ctx.llm.stream` | ✅ 已实现（16 例绿；真实 curl 待确认） |
| **P2** 前后端接线 | 读 `input.draft` → POST → `setDraft` + 失败提示 | ⬜ 待做 |
| **P3** 撤销 | 撤销栈 + CAS + 撤销按钮 + `draftRev` 校验 | ⬜ 待做 |
| **P4** 提示词自定义 | L1 配置已完成（含 `presets`）；再做客户端 `GET /config` + 预设菜单 | ⬜ 部分待做 |
| **P5** 打磨 | 流式回填、芯片策略、i18n、并发/超时/取消、vitest 化单测 | ⬜ 待做 |

---

## 9. 风险与待核对清单

| # | 风险 | 影响 | 处理 |
|---|---|---|---|
| R-1 | `GenerateOptions.purpose` 是封闭联合 `'compaction' \| 'session-title'`（`packages/llm/llm/src/types.ts:355`） | 不能声明本插件专属 purpose | v1 省略（可选字段，语义=普通请求）。想要专属语义需改 `dsh-llm` 核心（不建议第三方做） |
| R-2 | `setDraft` 会**拉平芯片**（`/命令`、`@引用`） | 破坏结构化引用 | v1 用 `input.occurrences` 检测并默认拒绝；v2 研究 `insertReference` 重建 |
| R-3 | 已安装版本（0.1.2-rc.1）与本地源码检出的 composer 实现不同（Lexical contenteditable vs textarea+backdrop） | 样例代码可能与运行版不符 | 一切只依赖 `draft` / `draftRev` / `inputActions.setDraft` 这套稳定契约；动手前先用 P0 验证真实 DOM |
| R-4 | `conversation.input.right` 的渲染顺序依赖 `InputBar.tsx` 的 JSX（`{rightItems}` 在 model 座之前） | 位置可能随版本变化 | P0 阶段肉眼确认；配置里留 `seat` 开关，必要时切 `left` |
| R-5 | 客户端 `dsh.client.inject` 名字写错 → 启动期报「pending (waiting for service)」 | 整个 GUI 起不来 | inject 列表先只写必需的三个；boot 失败页会直接点名缺失服务 |
| R-6 | 路由与 `api-gateway` 的 `/api` 前缀冲突 | 注册失败/被拦截 | 使用独立前缀 `/api/dsh-input-optimizer/...`；`register` 对重复 `(kind, path)` 会抛错，启动即可发现 |
| R-7 | 宿主半 `inject: ['llm']` 在 profile 未装 LLM 时插件不激活 | 静默不工作 | 前端加「宿主半不可用」降级提示；boot 日志会显示 pending 原因 |
| R-8 | 每会话并发/超时/取消没做 | 慢模型下体验崩坏 | P5 必做：`deadline()` + `AbortSignal` + 单航班 |
| R-9 | 提示词注入（用户草稿里包含指令） | 优化结果跑偏 | system 里明确「只改写、不回答」；用户文本用 JSON 包裹（`session-title-llm` 同款防越界手法） |
| R-10 | 客户端半没有配置通道（shell 用 `loader.create({name})` 建条目，boot graph 行不含 config） | 座位/预设等客户端选项无法直接由 `cordis.patch.yml` 配置 | 客户端选项改由插件自己的 HTTP 路由下发（P4 加 `GET /config`）；P0 座位先写死 |
| R-11 | 本地开发时 `@deepseek-ai/dsh-llm` 在本工作区不可解析 | 宿主半单测跑不起来 | 建开发用 junction `node_modules/@deepseek-ai/dsh-llm`（`.gitignore` 已忽略）；装进 profile 后天然可见 |
| R-12 | Windows 上 patch 的 `name` 写绝对路径不解析（Loader 对非 `.` specifier 直接 `import(name)`，`D:\` 被当成 URL scheme `d:`）；相对 specifier 又相对 profile 目录（C 盘）解析，跨盘无解 | 无法用「绝对路径直挂」这个便捷开发方式 | 必须先用 `dsh plugin --profile web add link:<本目录>` 装进 profile 的 node_modules，再用包名引用（README 安装章节已写明） |

---

## 10. 附录 A：关键接口索引（证据路径）

| 主题 | 路径 |
|---|---|
| 座位声明（composer 工具行） | `packages/client/ui-conversation/src/client/contract/slots.ts:190-241` |
| 工具行渲染顺序 | `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:732-795` |
| 座位注册语义（list/single/keyed/chain、id/order/priority、inject/children/locale） | `packages/client/ui-slots/src/index.ts:678-`（`SlotCore.register`） |
| 服务层（`slots.inject/register/entries/subscribe`） | `packages/client/ui-renderer/src/client/registry.ts`（`SlotRegistry`） |
| 标准 props 契约 | `ui-slots/src/index.ts:178-221`（`PropsRuntime`）、`packages/client/runtime/src/client/index.ts:124-151`（`sessionId/useSession/useProjection`）、`ui-conversation/.../contract/slots.ts:224-241`（`useInput/inputActions`） |
| 输入机状态与动作 | `ui-conversation/lib/types/client/contract/input.d.ts:157-313` |
| 平台种子模块表 / 客户端模块系统 | shell bundle 的 `staticModules`；`packages/client/modules/src/index.ts`、`src/client/manifest.ts` |
| 客户端插件清单字段 | `packages/client/modules/src/index.ts:46-139` |
| 一次性 LLM 调用范式 | `packages/session/session-title-llm/src/index.ts:229-294` |
| LLM 请求结构 | `packages/llm/llm/src/types.ts:319-356` |
| 宿主 HTTP 路由 | `@deepseek-ai/dsh-host-webserver` 的 `WebRoute` / `ctx.webServer.register` |
| 循环信任围栏范例 | 已装插件 `@linxin666/dsh-client-ui-skill-explorer` 的 `lib/types/loopback.d.ts` |
| 客户端热替换 | `@deepseek-ai/dsh-client-hmr`（`pollIntervalMs` 默认 500，stat-poll `lib/client.js`） |
| 插件配置/安装教程 | `docs/user/develop/basic/index.md`、`config.md`；`dsh plugin --profile web <pnpm 参数>` |
| 参考实现（座位注册） | `@deepseek-ai/dsh-client-ui-model-selection/lib/client.js:828-892` |

## 11. 附录 B：最小可跑骨架（P0 验收用）

**lib/client.js**
```js
window.__ModuleLoader__.load({
  id: 'better-input',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports
    const React = require('react')
    const SEAT = 'conversation.input.right'
    const NS = 'inputOptimizer'
    const zh = { optimize: '优化输入', running: '优化中…', undo: '撤销' }
    const en = { optimize: 'Optimize input', running: 'Optimizing…', undo: 'Undo' }

    function OptimizeButton(props) {
      const { t, useInput } = props
      const draft = useInput(s => s.draft)
      const [running, setRunning] = React.useState(false)
      const disabled = running || draft.trim() === ''
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          type: 'button',
          className: 'dsh-bi-btn',
          'aria-label': t('optimize'),
          title: t('optimize'),
          disabled,
          onMouseDown: e => e.preventDefault(),          // 不抢焦点
          onClick: async () => {
            setRunning(true)
            try {
              const res = await fetch('/api/dsh-input-optimizer/optimize', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text: draft }),
              })
              const data = await res.json()
              if (res.ok && typeof data.text === 'string') props.inputActions.setDraft(data.text)
            } finally { setRunning(false) }
          },
        }, running ? '…' : '✨'))
    }

    const inject = ['slots', 'locale']
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'better-input: dictionaries')
      ctx.inject(['slots'], (scope) => {
        scope.slots.inject(SEAT, () => scope.slots.register({
          name: SEAT, id: 'better-input', order: 10, locale: NS,
        }, OptimizeButton))
      })
    }
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
```

**lib/index.js**（P0 可先只留路由占位，P1 再补 LLM）
```js
export const name = 'better-input'
export const inject = ['webServer']
export function apply(ctx, config = {}) {
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-input-optimizer/optimize',
    handler: (req, res) => { res.statusCode = 501; res.end('{"error":"not-implemented"}') },
  })
  ctx.effect(() => dispose)
}
```
