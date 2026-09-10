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

## 0.5 实施进展（P0–P5.1 已交付）

| 文件 | 作用 |
|---|---|
| `package.json` | 双半声明（`main` + `exports["./client"]` + `dsh.client` / `dsh.bundle.patch`） |
| `cordis.patch.yml` | 把自己 insert 进插件树，内含唯一的配置入口 |
| `lib/policy.js` | 零依赖策略层：配置校验、信任围栏、**生效配置解析**、JSON 收发 |
| `lib/settings.js` | 宿主半：设置命名空间 schema + 跨字段 `validate` |
| `lib/index.js` | 宿主半：4 条路由（optimize / catalog / catalog-models / check）+ `ctx.llm.stream()` |
| `lib/client.js` | 浏览器半：输入框按钮 + CAS + 撤销栈 + **设置页**（手写 bundle，无构建步骤） |
| `lib/types/*.d.ts` | 对外契约类型（含组件行为契约、设置段字段） |
| `scripts/link-dev-deps.mjs` | 把宿主的 `@deepseek-ai/*` 软链进本仓库（`pretest` 自动跑；`link:` 安装的运行时同样必需） |
| `test/smoke.mjs`（33 例）、`test/client.smoke.mjs`（36 例） | 共 69 例，全绿（`npm test`） |

**验收证据**：P0 曾在 Web GUI 目视确认（2026-09-10，当时用 `link:D:\SSDWP\AI\dsh\BetterInput` 装入 profile）。
2026-09-11 复核时发现该路径已不存在、profile 里也没有本插件（bundles 无条目、patch 为空、`node_modules` 无包），
所以"P0 目视确认"在**当前仓库位置上不可复现**；P5.0 补齐了可复现的运行前提（安装步骤 + dev 依赖软链脚本），
P1 的路由此后仍需在真机上 curl 一次（单测用假 LLM 流覆盖了全部分支）。

实施期确认/修正的几点：

1. **包名与 bundle id 必须一致** —— 定为 `dsh-better-input`，客户端 bundle 里写死同名字面量（宿主按包名组合 boot graph，不一致会加载不到）。
2. **客户端半拿不到插件配置**（新发现，已影响设计）：web shell 用 `o.create({ name })` 创建客户端条目，boot graph 行只有 `{ id, url, rev, inject, immediately }`，没有 config 字段。所以 `seat` / `presets` / 撤销深度这类**客户端**选项只能由插件自己的 HTTP 路由下发；座位写死为 `conversation.input.right`，撤销深度写死为 10（与宿主默认值一致）。
3. **owner props 是个陷阱，且随版本变化**（真机事故，见 R-13）：已装 0.1.2-rc.1 对
   `conversation.input.left/right` 调 `renderSlot(name, {})`，**没有** `input`/`session`；
   第一版按「owner 是 InputZone」读 `props.input.phase`，点击即 `TypeError`。
   现在状态只从 `props.useInput((state) => state)` 读，并在每次渲染把
   `{ input, inputActions }` 写进一个 `live` ref 供异步路径使用（CAS 与撤销校验都读 ref）。
4. **`presets` 已在宿主侧实现**：`presetId` → 对应 `prompt` 追加到 system，未知名报 400。P4 只是补前端菜单 UI。
5. **max-tokens 截断改为「返回已获得文本 + `truncated: true`」**，不当失败——撤销按钮兜底，比丢结果更有用。
6. **取消链路是闭环的**：浏览器半生成中再点 = `AbortController.abort()`；宿主半靠
   `res.on('close')` 感知断开并取消上游 `ctx.llm.stream()`（signal 合并了超时与客户端断开），
   所以取消不会留下仍在计费的模型调用。
7. **可测性驱动分层**：`lib/policy.js` 刻意零 `@deepseek-ai` 依赖，因此宿主半能用假 ctx 驱动**真实**
   路由处理器（真的 `createUserMessage` / `BlockAssembler`，只把 `ctx.llm.stream` 换成替身）；
   浏览器半用极小 React 替身 + 「真值 / 每次渲染新快照」的 harness，能真实复现「往返期间草稿被改 → CAS 失败」。

### P4（设置页）的实现选择与理由

8. **配置读写走 dsh 标准设置通道，而不是自造存储**：宿主 `ctx.settings.register('better-input', schema, { applies: 'live', validate })`，
   客户端 `ctx.settingsScope.bind({ namespace })`。收益是白拿四件事——持久化（`dsh-settings-file` 落到
   `$DSH_HOME/settings.yaml`）、宿主校验、版本栅栏（写入带 revision，冲突会拒绝）、双端一致（同一份文档镜像）。
   自造 JSON 文件或 localStorage 都要自己实现这四件事，且「重启/刷新后仍在」会变成我自己的责任。
9. **设置段刻意扁平**：客户端 `SettingsScope.set(field, value)` 只接受命名空间内的标量字段，嵌套结构得拼
   path ops。扁平让「保存」既保持原子（一次 `mutate(ops, revision)`）又不必写路径。
10. **除 `customPromptEnabled` 外一律不给 schema 默认值**：未设置 = `undefined` = 回落到组合配置/内置默认。
    「未配置时使用默认模型与默认提示词，且不报错」这条要求就落在 `effectiveConfig(config, undefined)`
    与加设置页之前**逐字节相同**（有专门用例守着）。
11. **跨字段校验放 `validate`，不放 schema**：`validate` 抛错即**拒绝这次写入**（调用方在 `mutate` 处收到消息），
    而 schema 同时也是配置界面渲染与「段缺失时的解析」依据——把跨字段规则塞进 schema 会连这两件事一起改。
    客户端的预校验是同一套规则的**镜像**（客户端 bundle 不能相对 import policy.js），靠「同一批夹具两边结论一致」的用例防漂移。
12. **目录与试调走插件自己的只读路由**：provider/模型列表与 `resolveModelInfo` 是宿主 LLM 服务的知识，
    客户端没有等价服务；这三条路由与 optimize 共用同一套信任围栏与体积上限。
13. **新增 `temperature` 到组合配置键**：原先只能配 `maxOutputTokens`/`timeoutMs`；温度是「调用参数」里最常调的一个。
    只在显式配置时下传（`...temperature === undefined ? {} : { temperature }`），未配置行为不变。

### P5.0 / P5.1（可运行性 + 缺陷修复，2026-09-11）

逐条把插件调用的每个宿主/客户端 API 与**装机版本**（dsh 0.1.2-rc.1）的源码对了一遍，修掉下面这些。
每条都附"为什么会错"的机制，因为其中多数不是拼写错误而是**契约误判**，且失败方式是静默的。

14. **`ctx.get('logger')` 恒为 `undefined`** —— logger 不是 reflect 注册的服务，而是 root context 的
    自有属性（cordis `Context.logger: LoggerService`）。实测：`typeof ctx.logger.warn === 'function'`
    而 `ctx.get('logger') === undefined`。后果不是报错而是**全静默**：mounted 行、超时、断开、
    `model-failed` 诊断一条都打不出来。改用 `ctx.logger`；顺带把消息改成 printf 风格传参
    （cordis logger 会对第一个字符串做 `%s` 替换，模型返回的消息里含 `%` 占位符会被吃成 `undefined`）。
15. **`/check` 的 `context` 判型错误** —— `LlmResolvedModelInfo.context` 是 `LlmModelContext`
    即 `{ contextWindow: number }`，不是数字，所以 `typeof info.context === 'number'` 永远为假，
    这个字段从来没返回过。改为读 `info.context?.contextWindow`（测试替身原先按错的形状造假，一并修正）。
16. **未知 `finish.kind` 不该整条失败** —— `FinishReasonMap` 在 dsh-llm 里是**可合并扩展**的
    （注释原文："Merge-extensible so adapters can surface provider-specific reasons"，
    官方指引是 "switch on `kind` and **fall through unknowns**"）。旧代码对未知终态抛错，
    适配器或后续版本新增一个 reason 就会让**每一次**优化 502。现在未知终态按"已拿到的文本可用"处理，
    只记一条 `unknown finish reason %s` 告警；`error`/`aborted`/`tool-calls` 仍是失败。
17. **"路由未挂载"的 405 误报** —— web 组合里未匹配的路径由 SPA fallback 接管，而它对非 GET/HEAD
    的请求**先**回 405 空体、再去找文件（`dsh-host-frontend-static` 在读盘前就拦掉了非 GET/HEAD）。
    所以宿主半没挂载时 `POST /optimize` 拿到的是 405，不是 404——只映射 404 的话专门文案永不出现。
18. **保存假成功（最严重的一条）** —— `settingsScope.mutate()` 在宿主拒绝时**不会 reject**：
    内部 `if (!response.ok) { await this.recover(generation); return }`，而 Typert 的 `RemoteResult`
    把载体失败折进 `{ ok:false }` 分支、只有装配错误才抛。旧代码 `await` 完就 flash「已保存」，
    于是 revision 冲突或宿主校验不过时用户以为存上了。现在写后自查镜像里的值
    （`opsApplied()`，判据用**值**而不是 revision——并发被拒时 revision 也可能被别人推进过），
    没生效就报错并保留用户的编辑。客户端镜像同时补上上界（`maxOutputTokens ≤ 200000`、
    `timeoutMs ≤ 600000`），否则"客户端放行 → 宿主拒绝"正好是这条假成功路径的触发器。
19. **组合层数值区间不校验** —— `positiveInt` 只查 `> 0`，于是 `config.timeoutMs = 5e9` 会让
    `AbortSignal.timeout()` 抛 `ERR_OUT_OF_RANGE`（实测上限 4294967295），**每次**请求都 502；
    `timeoutMs = 100` 也被接受，与文档矛盾。现在 `resolveConfig` 按 `TIMEOUT_RANGE` /
    `MAX_OUTPUT_TOKENS_RANGE` 做区间校验（与设置层同值）。
20. **样式标签没打归属标记** —— 框架在**物化期**把所有未打标的 `<style>`"认领"给当时正在物化的插件
    （`dsh-client-modules` 的 `claimStyles`），而 `apply()` 晚于物化执行。不打标的话，下一个物化的
    插件会把这张表认领成自己的，那个插件 HMR 重载时按 `style[data-plugin]` 逐个删除
    （`dsh-client-hmr` 的 `removeOwnedStyles`），本插件样式被顺手删掉、只有整页刷新才恢复。
    现在注入时就写 `data-plugin` / `data-plugin-css`。
21. **顺手清掉的小问题**：IPv6 字面量的方括号在 Host 头侧被去掉、在 `new URL().origin.hostname`
    侧被保留，导致 `http://[::1]:3080` 被判成异源 403（已归一化）；撤销记录里的 `rev`/`at`
    写了从不读（撤销 CAS 的判据是文本相等，比 revision 更强，直接删字段并把契约写进类型）；
    `undoStacks` 按会话单向增长（会话被删没有任何通知能到达插件）→ 加 20 会话 LRU 上限；
    `flash()` 的旧计时器会提前清掉新提示 → 换提示前先 `clearTimeout`；4 个死词典键
    （`settings.title`/`settings.prompt.effective`/`settings.model.customOption` 删除，
    `settings.prompt.body` 改为提示词 textarea 的关联 `<label>`）；"dock 是唯一拿 owner props 的座位"
    这句注释不准确（plan/model/attachments 也有 owner props，只是都没有 `input` 快照）。
22. **测试替身按真实契约重建** —— 本轮 6 个缺陷里有 4 个是替身"造得太宽松"掩盖掉的：
    假 ctx 凭空提供了 `ctx.get('logger')`、假 `resolveModelInfo` 返回数字型 `context`、
    假 `mutate` 在失败时抛错（真实现是静默返回）。替身对齐后各补了对应用例（含 405 文案、
    未知终态、组合层区间、样式归属、LRU 淘汰、保存未生效）。

### P5.1b（真机事故：设置页恒显示「设置服务不可用」，2026-09-11）

**现象**：重启后设置页始终显示「设置服务不可用：宿主端没有挂载设置提供者（或插件宿主半未加载）」，
配置无法保存；优化按钮照常工作。

**排查依据**（全部取自重启后的真实环境）：

| 证据 | 结论 |
|---|---|
| `GET /api/dsh-input-optimizer/catalog` → 200，带 `namespace` 与真实 provider（`deepseek-official`/`leihuo`） | 宿主半**已加载**、4 条路由已挂载（假 LLM 目录不可能有真实 provider） |
| 同一响应里 `settings.available === false` | 降级发生在**注册**这一步，与客户端无关 |
| `POST /optimize`（合法 body）→ 200，`modelUsed:{leihuo, deepseek-v4.1-flash}` | 优化链路正常；模型来自宿主 `agent-default-model`、提示词来自组合配置（`sources.prompt:'config'`）——"回退到默认"只发生在**设置页那一层** |
| `$DSH_HOME/settings.yaml` 有 `ui-onboarding`/`agent-presets`/`llm-pi-ai`/`agent-default-model`，**没有** `better-input:` | 设置提供者工作正常，本插件命名空间确实从未注册；也排除了"存量非法段让 register 抛错" |
| 客户端 `SettingsScopeController.derive()`：describe 里找不到该命名空间 → `status='unavailable'` | 客户端只是**如实推导**，不是问题源 |

**根因（注册时机竞态）**：

23. **`SettingsProvider`（dsh-settings）用 `super(ctx, 'settings')` 提供 `settings` 服务，
    但服务要等它的 `async *[Service.init]()` 里 `await this.load()`（读 `settings.yaml`）完成后才 ACTIVE。**
    而 `ctx.get(name)` 等价于 `ctx.reflect.get(name, **strict = true**)`，cordis 的 `_getImpl` 对
    "已 provide 但 fiber 未 ACTIVE（`state !== 2`）"的服务**返回 `undefined`**。
    本插件行只 `inject: ['webServer','llm']`，**可能先于设置提供者激活**——`apply()` 里那次一次性
    `ctx.get('settings')` 拿到 `undefined`，代码按"部署没挂设置提供者"处理并**永久**降级。
    这解释了"同一份代码 2026-09-10 还好、之后一直坏"：它是竞态，结果随启动顺序与读盘快慢而变。
24. **修法**：注册挂到「settings 服务就绪」这一刻，而不是激活时读一次——`ctx.inject(['settings'], cb)`
    （等价 `ctx.plugin({ inject, apply })`，cb 是独立子 fiber）：服务就绪即执行、卸载即回收
    （注册本身是 calling context 上的 effect，可安全重注册）。既不会把 settings 变成硬依赖
    （没有提供者的部署照常只降级、路由照常挂），也不会漏掉"后到"的服务。同时把注册失败的原因经
    `/catalog` 的 `settings.reason` 透给客户端——笼统一句"设置服务不可用"没法排查。
25. **回归防线**：新增 `test/settings-activation.mjs`，用**真实 cordis + 真实 `dsh-settings-file`**
    跑三个用例（提供者先到/后到/完全没有），并端到端验证"注册后写得进 `settings.yaml`"。
    必须用真框架的理由：这条缺陷完全来自服务激活时序，假 ctx 的 `get()` 永远即时返回、造不出该时序——
    这正是它能溜过当时 33 例冒烟测试的原因。宿主冒烟测试的假 ctx 同时补上真实的
    `ctx.inject(deps, cb)` 语义（服务未就绪则回调排队），并新增"晚到必须补注册""注册失败要带原因"
    "服务消失回降级"三个单元用例。

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
<包根>                                (工作区根；本机为 F:\dsh\dsh_BetterInput)
├─ package.json                     dsh.client / dsh.bundle.patch 声明
├─ cordis.patch.yml                 把自己 insert 进 profile 插件树
├─ lib\index.js                     宿主半：HTTP 路由 + LLM 调用
├─ lib\client.js                    浏览器半：座位注册 + 按钮组件 + 撤销栈
├─ lib\types\*.d.ts                 对外类型（手写）
├─ scripts\link-dev-deps.mjs        开发/`link:` 安装所需的宿主依赖软链
└─ test\*.smoke.mjs                 两个冒烟套件
```
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

1. **owner props —— 座位而异，且随版本变化**：
   - `conversation.input.dock` 的 owner 是 `InputZone = { session, input }`（点快照）；
   - **`conversation.input.left/right` 在已安装版本（0.1.2-rc.1）里根本没有 owner props**：
     已装 `ui-conversation/lib/client.js:15637/15642` 是 `renderSlot("conversation.input.left", {})`
     与 `renderSlot("conversation.input.right", {})`；只有新版本源码（`ConversationRoot.tsx:152-153`）
     才把 `zone` 传给这两个座位。**所以绝不要读 `props.input`。**
2. **session standard kit**（三处 declaration merge 合并的结果，与 owner props 无关，是可靠来源）：
   - `ui-conversation`：`useInput: SnapshotSelectorHook<InputState>`、`inputActions: InputActions`
   - 已装 `ui-session`：`sessionId`、`useSession`、`useProjection`
   - 已装 `ui-chat`：`useChat`
3. **本插件的 inject 面** + `t()`。

因此**唯一的读取姿势是 `props.useInput((state) => state)`**（渲染路径），异步路径用 ref 存住它。
已装版本不存在 `useConversation`（那是新版本 `ui-conversation` 才合并进 kit 的），所以状态一律走 `useInput`。

`InputState`（`ui-conversation/lib/types/client/contract/input.d.ts:295`）关键字段：

```ts
readonly draft: string            // 剪贴板投影：芯片已展开为剪贴板形态
readonly draftRev: number         // 单调编辑器修订号（span CAS 基准）
readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
readonly occurrences: readonly Occurrence[]   // 编辑器里芯片（引用/命令）的出现位置
readonly imageIds: readonly DraftAttachmentId[]
```

`InputActions` 里的写入口：`setDraft(text)`、`submit()`、`addImages/removeImage/pruneImages`。

于是组件只依赖三样东西：`props.useInput((state) => state)`（渲染期读状态 + 写入 ref）、
`live.current.input`（异步路径读最新值）、`props.inputActions.setDraft()`（写）。实现见
`lib/client.js` 的 `BetterInputButton`，其数据流是：

```
点击 ──► 取快照(before, rev) ──► POST /optimize ──┬─► 失败/取消 ──► 提示（不写草稿）
                                                 └─► 成功 ──► CAS(draft===before && draftRev===rev)
                                                              ├─ 不一致 ──► 丢弃结果 + stale 提示
                                                              └─ 一致 ──► setDraft(text) + 压撤销栈
```

**实现要点（真机上踩过的坑）**：第一版按「left/right 的 owner 是 InputZone」写，直接读
`props.input.phase`，真机点击时抛 `TypeError: Cannot read properties of undefined (reading 'phase')`。
正确姿势有两条，缺一不可：

1. 状态只从 `props.useInput((state) => state)` 读（框架注入的标准道具，与座位 owner 无关）；
2. 每次渲染把读到的状态与 `props.inputActions` 写进一个 `live` ref，异步回调只从 ref 读
   （既避开点快照/闭包过期，又天然兼容「有没有 owner props」两种版本）。

同理 `props.sessionId` 也不能想当然：它来自已装 `ui-session` 的 kit 合并，装不到那个包时为空——
实现里对空值做了回落（`'current'`），不至于崩，但撤销栈会退化成全局共享（有 CAS 兜底）。

**红线**：
- ❌ 不要 `querySelector` 改输入框 DOM。已安装版本的 composer 是 Lexical contenteditable + 芯片节点（`lib/types/client/input/editor/ComposerContentEditable.d.ts`、`chip-node.d.ts`），DOM 改法会被下一次渲染冲掉，还会绕过输入机状态机。（本地源码检出的 `InputBar.tsx` 已改为 `textarea + backdrop` 方案——**两版都靠同一套 `draft`/`setDraft` 契约**，这正是不要碰 DOM 的理由。）
- ❌ 不要用 `ComposerKeyboard.caretSpan()/paste()` 做「只替换选区」：那是 `InputBar` 私有面，
  注释明确「package-internal, never across a plugin boundary」。

### 3.4 撤销设计（R5）

**为什么必须自建**：`setDraft` 的注释是「Replace the whole draft (persisted-draft seed and programmatic writes)」——程序化写入不会进 Lexical 的原生 undo 历史，用户按 Ctrl+Z 不一定能回到原文。

设计（**已实现**）：

```ts
type UndoRecord = { before: string; after: string; rev: number; at: number }
// 每会话一条栈；插件生命周期内有效（放模块级 Map，不放 React state —— 避免座位重挂载/切会话丢栈）
const undoStacks = new Map<SessionId, UndoRecord[]>()
const MAX_UNDO = 10   // 客户端读不到插件配置（R-10），先写死并与宿主默认值保持一致
```

撤销时的三条规则（与实现一致）：

1. **CAS 校验**：仅当当前草稿 `=== record.after` 时才直接回退，避免覆盖用户后续手改的内容。
2. **不匹配时不停摆**：第一次点击只给警告「草稿已被修改；再点一次可强制还原原文」，
   同一条记录**连点两次才强制还原**——既不会误覆盖，也不会让用户卡在无法撤销的死角。
3. **栈式多次撤销**：连按逐层回退（每层 10 条，超出丢最旧）；按会话隔离。

UI：一个 entry 组件渲染两个按钮（`[↶ 撤销]` `[✨ 优化]`），撤销按钮仅在栈非空时渲染，
`data-state` 为 `clean`/`dirty` 反映 CAS 预判，省掉第二次注册座位。

撤销后把焦点交回输入框属于可选增强（`inputActions` 无 focus API，需直接对编辑器宿主元素 `focus()`）。

---

## 4. 提示词自定义（R3）：三层方案，分三期

### L1 · cordis 插件配置（第一期，最快可用）

插件导出 schemastery `Config`，用户在 `~/.dsh/profiles/web/cordis.patch.yml` 的插件行里写 `config:`：

```yaml
- insert:
    - id: better-input
      name: 'dsh-better-input'
      config:
        model: { provider: deepseek-official, model: deepseek-v4-flash }  # 省略则用宿主当前选择
        systemPrompt: |
          你是提示词工程师。把用户草稿改写成更清晰、无歧义、结构化的任务描述。
          保留原有语言；不要回答问题本身；只输出改写后的文本。
        presets:
          - { id: concise,  label: '精简',   prompt: '压缩冗余，保留全部约束。' }
          - { id: spec,     label: '转规格', prompt: '改写成含验收标准的需求条目。' }
        maxInputChars: 8000
        timeoutMs: 30000
        maxOutputTokens: 1024
```

**注意**：`seat`（座位选择）与撤销深度这类**客户端**选项**不在**配置键里——客户端半拿不到插件配置（见 R-10），
写进 `config:` 只会让启动失败（未知键 fail loud）。它们目前是 `lib/client.js` 里的常量（`SEAT`、`MAX_UNDO`）。

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
  "name": "dsh-better-input",
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
      name: 'dsh-better-input'
      config:
        systemPrompt: |
          你是提示词工程师……
```

### 7.3 客户端 bundle 形态（可手写，无需 tsdown）

```js
// lib/client.js
window.__ModuleLoader__.load({
  id: 'dsh-better-input',             // 必须等于包名
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
| **P1** 宿主路由 | `/api/dsh-input-optimizer/optimize` + 固定 system prompt + `ctx.llm.stream` | ✅ 已实现（宿主半 33 例绿；真实 curl 待确认） |
| **P2** 前后端接线 | 读 `input.draft` → POST → `setDraft` + CAS + 取消 + 失败提示 | ✅ 已实现（含 stale 丢弃、403/404/405/网络/空结果文案） |
| **P3** 撤销 | 撤销栈 + CAS + 撤销按钮 + 文本相等判据 | ✅ 已实现（含二次点击强制还原、10 层深度、按会话隔离 + 20 会话 LRU） |
| **P4** 提示词与模型配置页 | 设置面板分区（`settings.section`）：模型 + 调用参数 + 提示词，持久化 + 即时生效 + 校验 | ✅ 已实现（`applies: 'live'`；落 `settings.yaml`；设置页 12 条用例覆盖校验/持久化回填/不可用态） |
| **P5.0** 可运行性 | dev 依赖软链脚本 + 安装/验收步骤可复现 | ✅ 已实现（2026-09-11；`npm test` 前自动链接宿主依赖） |
| **P5.1** 缺陷修复 | 逐条核对装机版 API：日志、判型、终态语义、405 文案、保存假成功、组合层区间、样式归属 | ✅ 已实现（2026-09-11；共 7 项，见 §0.5 第 14–22 条） |
| **P5.1b** 设置页不可用 | 命名空间注册时机竞态（`ctx.get('settings')` 一次性读 vs 服务 ACTIVE 时机） | ✅ 已修复（2026-09-11；真框架集成测试 3 例，见 §0.5 第 23–25 条） |
| **P5.2–P5.7** 打磨 | 规则单一来源、预设菜单、并发与信任收敛、流式回填、工程化（typecheck/vitest/CI）、芯片保留 | ⬜ 待做（见 README「下一步」） |

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
| R-11 | 本地开发时 `@deepseek-ai/dsh-llm` 在本工作区不可解析 | 宿主半单测跑不起来（且 `link:` 安装时运行时也跑不起来，见 R-19） | `npm run link-deps`（`pretest` 自动跑）在仓库内建链接；`.gitignore` 已忽略 `node_modules/` |
| R-12 | Windows 上 patch 的 `name` 写绝对路径不解析（Loader 对非 `.` specifier 直接 `import(name)`，`D:\` 被当成 URL scheme `d:`）；相对 specifier 又相对 profile 目录（C 盘）解析，跨盘无解 | 无法用「绝对路径直挂」这个便捷开发方式 | 必须先用 `dsh plugin --profile web add link:<本目录>` 装进 profile 的 node_modules，再用包名引用（README 安装章节已写明） |
| R-13 | **真机事故**：已装 0.1.2-rc.1 对 `conversation.input.left/right` 调 `renderSlot(name, {})`，**没有 owner props**；只有新版本源码才传 `InputZone` | 第一版读 `props.input` → 点击即 `TypeError`，功能废掉 | 状态一律走 `props.useInput`；异步路径走渲染期写入的 ref；文档与测试按「两种形状」覆盖（`test/client.smoke.mjs` 的 `inputZone` 开关）。升级 dsh 后需重核 |
| R-14 | `ctx.get('logger')` 恒为 `undefined`（logger 是 root context 的自有属性，不是 reflect 服务） | 宿主日志/告警**全部静默丢弃**，故障无从排查 | 用 `ctx.logger`；消息按 printf 风格传参。测试替身也照抄"`get('logger')` 返回 undefined"，并断言日志确实落库（P5.1 第 14 条） |
| R-15 | `settingsScope.mutate()` 在宿主拒绝时**不 reject**（只 `recover()` 后正常返回；Typert 把载体失败折进 `{ok:false}`） | 保存界面假报"已保存"，实际没写入（revision 冲突、字段超宿主区间时必现） | 写后自查镜像值（`opsApplied()`，判据用值而非 revision）；客户端镜像补齐上界；测试替身改成"拒绝=静默返回"（P5.1 第 18 条） |
| R-16 | web 组合里未匹配路径由 SPA fallback 接管，它对非 GET/HEAD **先**回 405 空体 | 宿主半没挂载时客户端拿到 405 而非 404 → 误导成"宿主返回错误" | 404/405 一并映射到「路由未挂载」文案；插件自己的 405 带 JSON message，优先展示（P5.1 第 17 条） |
| R-17 | 组合层配置的数值不在区间内（如 `timeoutMs = 5e9`）→ `AbortSignal.timeout()` 抛 `ERR_OUT_OF_RANGE`（上限 4294967295） | **每次**请求 502，用户只看到"优化失败" | `resolveConfig` 按 `TIMEOUT_RANGE`/`MAX_OUTPUT_TOKENS_RANGE` 校验，启动期 fail loud（P5.1 第 19 条） |
| R-18 | 框架在**物化期**把未打标的 `<style>` 认领给当时物化的插件；`apply()` 晚于物化 | 样式表被别的插件认领走，其 HMR 重载时按 `style[data-plugin]` 删除 → 本插件丢样式，只有整页刷新才恢复 | 注入时自带 `data-plugin`/`data-plugin-css`（P5.1 第 20 条） |
| R-19 | `link:` 安装是符号链接，Node 按 realpath 解析模块 → 插件自己的 `@deepseek-ai/*` 裸导入从**仓库目录**向上找 `node_modules`，`$DSH_HOME/profiles/node_modules` 镜像不在解析路径上 | 宿主半 `ERR_MODULE_NOT_FOUND`，boot 失败（不是"只有测试受影响"） | `scripts/link-dev-deps.mjs`（`pretest` 自动跑）在仓库内建 `dsh-llm` 与 `schemastery` 两个链接；正式（非 link）安装由 profile 镜像覆盖 |
| R-20 | **激活顺序竞态**：`ctx.get(name)` 是 `strict = true`，对"已 provide 但未 ACTIVE"的服务返回 `undefined`；而 `SettingsProvider` 要 `await load()` 之后才 ACTIVE | 在 `apply()` 里一次性读设置服务 → 竞态落败就**永久**降级，设置页恒显示「设置服务不可用」（重启也一样，除非启动顺序恰好变好） | 一切"可选服务"都用 `ctx.inject([name], cb)` 挂载（服务就绪即执行、卸载即回收），不要用 `ctx.get` 做一次性判定；用真实框架跑集成测试钉住时机（`test/settings-activation.mjs`） |

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


## 11. 附录 B：实现文件索引（不再维护重复骨架）

P0 期曾把「最小可跑骨架」抄在这里，但骨架会与真实代码漂移——现在以文件为唯一事实来源：

| 想读什么 | 看哪里 |
|---|---|
| 座位注册、按钮状态机、CAS、撤销栈、词典、设置页 | [`lib/client.js`](./lib/client.js)（一个文件、六个小节注释分区） |
| 路由挂载、模型路由解析、LLM 一次性调用、错误码 | [`lib/index.js`](./lib/index.js) |
| 配置校验、信任围栏、提示词 JSON 框架、JSON 收发 | [`lib/policy.js`](./lib/policy.js)（零依赖，可 `node` 直接跑） |
| 行为与接口契约（含撤销/取消语义、mutate 的失败语义） | [`lib/types/client/index.d.ts`](./lib/types/client/index.d.ts) |
| 宿主契约与错误码清单 | [`lib/types/index.d.ts`](./lib/types/index.d.ts) |
| 开发/`link:` 安装所需的依赖软链 | [`scripts/link-dev-deps.mjs`](./scripts/link-dev-deps.mjs)、[`scripts/dsh-packages.mjs`](./scripts/dsh-packages.mjs) |
| 可执行的行为说明（36 + 37 + 3 = 76 例） | [`test/smoke.mjs`](./test/smoke.mjs)、[`test/client.smoke.mjs`](./test/client.smoke.mjs)、[`test/settings-activation.mjs`](./test/settings-activation.mjs) |
