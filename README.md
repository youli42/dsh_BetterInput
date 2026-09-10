# dsh-better-input

DSH Web GUI 插件：在**模型选择器左侧**加一个「AI 优化输入」按钮，点击后用可自定义的提示词优化输入框里的内容，并把结果写回输入框（撤销见路线图 P3）。

设计依据、座位/接口证据与分阶段计划见 [`DESIGN.md`](./DESIGN.md)。

## 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 骨架：座位注册 + 按钮出现在模型左侧 | ✅ 已在 Web GUI 目视确认（2026-09-10） |
| P1 | 宿主半：`/api/dsh-input-optimizer/optimize` + `ctx.llm.stream()` 一次性调用 | ✅ 已实现 |
| P2 | 前后端接线：读草稿 → POST → `setDraft` + CAS + 取消 + 失败提示 | ✅ 已实现 |
| P3 | 撤销栈 + CAS 校验 + 撤销按钮（含强制还原、10 层深度） | ✅ 已实现 |
| P4 | 设置页：配置模型（名称 + 调用参数）与提示词，持久化并即时生效 | ✅ 已实现 |
| P5.0 | 可运行性：dev 依赖软链脚本 + 真机安装验收 | ✅ 已实现（2026-09-11） |
| P5.1 | 缺陷修复：日志全丢、`/check` 契约判型、未知终态误判失败、405 误报、保存假成功、组合层区间、样式归属 | ✅ 已实现（2026-09-11） |
| P5.1b | **真机事故**：设置页恒显示「设置服务不可用」——命名空间注册是激活时读一次，输给了 settings 服务就绪的竞态 | ✅ 已修复（2026-09-11，含真框架集成测试） |
| P5.2 | 规则单一来源：区间/上限/预设由 `/catalog` 下发，客户端不再维护会漂移的镜像 | ✅ 已实现（2026-09-11） |
| P5.3 | 预设菜单：输入框旁 ▾ 菜单，选中后请求带 `presetId` | ✅ 已实现（2026-09-11） |
| P5.4 | 信任判定改走框架 `ctx.connection.requestRejection()`（能力路由要浏览器会话） | ✅ 已实现（2026-09-11） |
| P5.5 | 并发闸门：同会话单航班（409）+ 全局并发上限（429） | ✅ 已实现（2026-09-11） |
| P5.7 | 工程化：Biome lint、约定守卫、真 React 渲染测试、CI | ✅ 已实现（2026-09-11） |
| P5.6 | 流式回填：/optimize/stream（SSE）边生成边替换草稿，失败还原原文 | ✅ 已实现（2026-09-11） |
| P6.1 | **多选优化风格**：▾ 下拉框里勾选「精简 / 转规格」，可叠加，请求带 `styleIds` | ✅ 已实现（2026-09-11） |
| P6.2 | **逐风格提示词**：设置页为每个风格单独配提示词（内置 ← 组合配置 ← 设置页） | ✅ 已实现（2026-09-11） |
| P6.3 | **打开插件配置文件**：设置页一键用编辑器打开 `cordis.patch.yml`，失败有明确提示 | ✅ 已实现（2026-09-11） |
| P6.4 | **Web 启动耗时排查**：基线 1886ms/12 轮，插件边际成本 ~5ms，无阻塞（见 `.perf/README.md`） | ✅ 已完成（2026-09-11） |
| P5.7b / P5.7c / P5.8 | typecheck（缺 tsc）、vitest+jsdom、芯片保留 | ⬜ 待做（见「下一步」与「工程化」） |

检查：lint 零发现 · 约定守卫 18 条 · 测试 59 + 60 + 6 + 4 = 129 例，全绿
（`npm run verify` = lint + 全部检查；`npm test` 会先自动补齐 dev 依赖链接）。

> **运行前提**：仓库里没有 `node_modules` 时，`npm test` 与 `link:` 方式安装后的运行时都跑不起来
> （原因与自动修法见「开发循环」）。

## 目录结构

```
package.json          双半声明：main(lib/index.js) + exports["./client"] + dsh.client/bundle
biome.json            lint 配置（只 lint 不 format，见「工程化」）
cordis.patch.yml      bundle patch + 组合层配置（设置页的用户值优先于它）
lib/index.js          宿主半：6 条路由（一次性 JSON + 流式 SSE + 目录/试调 + 打开配置文件）+ LLM 调用 + 并发闸门
lib/settings.js       宿主半：设置命名空间 schema 与跨字段校验（注册挂在 settings 就绪时）
lib/policy.js         策略层：零依赖，配置校验/信任围栏/生效配置解析/风格提示词分层（可独立单测）
lib/client.js         浏览器半：输入框按钮 + 多选风格菜单 + 撤销栈 + 设置页（手写 __ModuleLoader__ bundle）
lib/types/*.d.ts      对外类型
.perf/                Web 启动耗时基准脚本与测量报告（README.md 有方法与原始数据）
scripts/check-guards.mjs  约定守卫：把踩过的坑变成可自动检查的规则（18 条）
scripts/dsh-packages.mjs  定位 dsh 安装与其中的宿主包（脚本与测试共用）
scripts/link-dev-deps.mjs 把宿主依赖软链进本仓库（`npm test` 前自动跑；CI 里自动跳过）
scripts/lint.mjs      找 Biome 并跑 lint（仓库内 / 全局安装都能用）
test/smoke.mjs        宿主半冒烟测试（59 例）
test/client.smoke.mjs 浏览器半冒烟测试（60 例：接线、流式回填、多选风格、预设菜单、撤销栈、设置页）
test/client.react.mjs 真 React 渲染测试（6 例：真 react/react-dom SSR，含"不得有 React 警告"）
test/settings-activation.mjs 真框架集成测试（4 例：真实 cordis + 真实 settings 提供者，含逐风格提示词全链路）
.github/workflows/ci.yml  CI：lint + 约定守卫 + 四个套件（Windows）
DESIGN.md             设计依据：座位/接口证据、撤销方案、提示词分层、风险清单
LICENSE               MIT
```

## 安装

前置：`dsh` 0.1.2-rc.1+，profile 为 `web`（即 `~/.dsh/profiles/web`）。

**第 1 步（两种方式都要做）**：把本包装进 profile，让包名能被解析到：

```powershell
dsh plugin --profile web add link:F:\dsh\dsh_BetterInput
```

**第 1.5 步（`link:` 专用，容易漏）**：在**本仓库**建好宿主依赖的软链：

```powershell
npm run link-deps        # = node scripts/link-dev-deps.mjs，自动定位 dsh 安装目录
```

> 为什么运行时也需要它：`link:` 在 profile 里放的是**符号链接**，Node 按 realpath 解析模块，
> 于是 `lib/index.js` 的 `import '@deepseek-ai/dsh-llm'` 是从**本目录**往上找 `node_modules` 的——
> `$DSH_HOME/profiles/node_modules` 那个镜像根本不在解析路径上。缺了它宿主半会
> `ERR_MODULE_NOT_FOUND`（boot 直接失败），**不是**"只有测试受影响"。
> 从 npm 正式安装（非 `link:`）时包会被拷进 profile 的 `node_modules`，镜像在解析路径上，无需这一步。

> ⚠️ Windows 上**不要**在 patch 里写绝对路径当插件名：Loader 对非 `.`/非 `cordis:` 的
> specifier 直接交给 `import(name)`，`D:\...` 会被当成 URL scheme `d:`. 解析而失败；
> 以 `.` 开头的相对 specifier 又是相对 **profile 目录**（在 C: 盘）解析的，跨盘也无解。
> 所以唯一可靠的方式是「装进 profile 的 node_modules，再用包名引用」。

### 方式 A：bundle（与已上架的第三方插件一致）

**`dsh plugin --profile web add` 已经自动把包名追加进 `dsh.profile.bundles`**（实测 0.1.2-rc.1，
无需手改 JSON）。只有在手工拷贝/手改依赖的场景才需要自己往 `dsh.profile.bundles` 里加一行
`"dsh-better-input"`——而且**绝不要重复添加**：同一个 bundle 会被组合两次，插件的
`(kind: 'exact', path)` 路由重复注册会直接抛错（`webserver: duplicate exact route ...`），表现为起不来。

然后重启 `dsh web`。本包的 `cordis.patch.yml` 会作为 bundle 层被自动应用（`dsh.bundle.patch`）。

### 方式 B：直接 patch insert（不想动 bundles 时）

在第 1 步之后，把下面这段拷进 `~/.dsh/profiles/web/cordis.patch.yml`（该文件里已有一个 `mcp-everything` 的同构例子），再重启：

```yaml
- insert:
    - id: better-input
      name: 'dsh-better-input'
      config:
        systemPrompt: |
          你是提示词工程师……
```

这段内容与本包自带的 `cordis.patch.yml` 等价；用方式 A 时改的是包里那份，用方式 B 时改的是 profile 那份。

## 验证

> 改动宿主半（`lib/index.js`/`lib/policy.js`/`lib/settings.js`）或改安装方式后**必须重启 `dsh web`**；
> 只改 `lib/client.js` 时靠 HMR，刷新即可。

1. **P0**：刷新 `http://127.0.0.1:3080`，输入框工具行右侧、模型选择器紧左边出现 ✨ 按钮（`data-dsh-better-input="better-input"`，可用 DevTools 搜到）。空输入时按钮为禁用态。
2. **P1**：路由挂上后宿主日志会打印 `better-input: mounted /api/dsh-input-optimizer/optimize`
   （`ctx.get('logger')` 恒为 `undefined`，所以这一行只有在用 `ctx.logger` 时才真的会出现）。直接打路由：

```powershell
curl.exe -s -X POST http://127.0.0.1:3080/api/dsh-input-optimizer/optimize `
  -H 'content-type: application/json' `
  -d '{"text":"帮我把那个脚本弄一下，快点"}'
# → {"text":"...优化后的提示词...","modelUsed":{"provider":"...","model":"..."}}
```

  非本机来源（远程 IP / 异源 Host / `Sec-Fetch-Site: cross-site`）一律 `403`。
3. **P4（设置页真的可用）**：重启后

```powershell
curl.exe -s http://127.0.0.1:3080/api/dsh-input-optimizer/catalog
# 必须看到 "settings":{"available":true,...}
# 若为 false，会同时带出宿主侧原因："reason":"..."
```

   宿主日志里应同时出现两行：`better-input: mounted /api/dsh-input-optimizer/optimize (+stream/catalog/check/open-config)`
   与 `better-input: settings namespace "better-input" registered`。
   设置页保存后 `$DSH_HOME/settings.yaml` 里应出现 `better-input:` 段，`catalog` 的
   `sources.*` 也从 `config`/`default` 变为 `settings`。
4. **P6.1/P6.2（多选风格 + 逐风格提示词）**：✨ 右侧的 `▾` 里出现「精简 / 转规格」两个**勾选框**
   （按钮上带已选数量，如 `▾2`）；勾选不收起菜单。勾上「转规格」后点 ✨，DevTools → Network 里
   请求体应带 `"styleIds":["spec"]`。到设置页「输入优化 → 优化风格提示词」给「转规格」填一段自己的
   文案并保存，再优化一次：请求里的 `styleIds` 不变，但宿主日志/效果应体现新提示词
   （`/catalog` 的 `styles[].source` 会从 `config`/`default` 变成 `settings`）。
5. **P6.3（打开配置文件）**：设置页底部点「打开插件配置文件」→ 用编辑器打开
   `F:\dsh\dsh_BetterInput\cordis.patch.yml`（设置页上同时显示这个绝对路径）。
   可用 `node .perf/verify-open-config.mjs` 走同一条链路做命令行验收。
6. **P5.3（预设菜单）**：`cordis.patch.yml` 里配了**非风格 id** 的 `presets` 时，`▾` 菜单下半部分
   列出它们；点某一项 → 请求体里带 `presetId`（可用 DevTools 的 Network 面板确认）。
   一个都没配时只有风格区，界面与从前一致。
7. **P5.4（宿主会话）**：`POST /optimize` 需要浏览器会话（页面 cookie 由 `dsh web` 打印的
   带 token 的 URL 换取）。命令行只做排查时用只读路由：

```powershell
curl.exe -s http://127.0.0.1:3080/api/dsh-input-optimizer/catalog        # 元数据：免会话（仅环回）
curl.exe -s -X POST http://127.0.0.1:3080/api/dsh-input-optimizer/check `
  -H 'content-type: application/json' -d '{"provider":"leihuo","model":"deepseek-v4.1-flash"}'
# POST /optimize 不带 cookie 会得到 401 unauthorized（这是有意的：凭据可能来自环境变量，
# 本机其它进程不该能借这条路由花掉它）。要从命令行调它，就把浏览器 DevTools →
# Application → Cookies 里那条 dsh 会话 cookie 用 `-b "<name>=<value>"` 带上。
```

8. **检查**：

```powershell
npm run verify                    # lint + 约定守卫 + 四个套件（推荐）
npm test                          # 约定守卫 + 宿主半 + 浏览器半 + 真 React + 真框架集成
node test\smoke.mjs               # 宿主半 59 例：生效配置、信任判定、并发闸门、六路由全链路、SSE 分帧、多选风格、打开配置文件
node test\client.smoke.mjs        # 浏览器半 60 例：座位、流式回填、多选风格、预设菜单、逐风格提示词、撤销栈、设置页
node test\client.react.mjs        # 真 React 6 例：真 react/react-dom SSR 渲染（含"不得有 React 警告"）
node test\settings-activation.mjs # 真框架集成 4 例：真实 cordis + 真实 settings 提供者，钉住注册时机与逐风格提示词生效链路
node .perf\measure-startup.mjs 12 # Web 启动耗时基准（12 轮冷启动；详见 .perf/README.md）
```

> 各项检查覆盖什么/不覆盖什么、以及 typecheck 为何还没上，见「工程化」一节。
> 宿主半测试与运行时都需要 `@deepseek-ai/dsh-llm`（设置半还需要 `@deepseek-ai/schemastery`）可见；
> 集成测试还需要 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-settings-file`；真 React 套件需要配对好的
> `react`/`react-dom`。`npm test` 的 `pretest` 会自动建这些软链（`npm run link-deps`）；
> 脚本会在 `$DSH_HOME/profiles`、`~/.dsh/profiles`、nvm 安装目录里找 dsh，找不到才报错
> （也可用 `$env:DSH_INSTALL_ANCHOR` 显式指定含 `node_modules` 的目录）。

## 行为说明（已实现）

| 场景 | 行为 |
|---|---|
| 点击 ✨ | `POST /api/dsh-input-optimizer/optimize/stream`（默认；`/optimize` 是回退），body `{ text, sessionId, styleIds?, presetId? }`，成功后 `setDraft` 写回 |
| 风格下拉框（`▾`） | 内置风格「精简 / 转规格」以**多选勾选**呈现，按钮上带已选数量（`▾2`）；勾选**不收起菜单**，可以连着勾；勾了就随主按钮/预设一起生效，一个都不勾则完全不发 `styleIds`（行为与从前一致） |
| 优化风格提示词 | 每个风格在设置页有独立提示词；生效顺序：内置默认 ← `cordis.patch.yml` 里**同 id** 的预设 ← 设置页。见下「优化风格」一节 |
| 预设菜单（`▾`） | 与风格同 id 的预设不再列进预设区（避免同一个风格出现两次）；其余预设点一次跑一次，请求带 `presetId`，宿主把该预设的 prompt 追加到 system。菜单向上弹出，点外面或 Esc 收起 |
| 草稿超过宿主上限 | 本地直接提示「草稿过长（n/上限）」，不发请求（上限来自 `/catalog` 的 `limits`） |
| 流式回填 | 默认走 SSE：增量到达即改写草稿（80ms 节流）；失败/中断会还原原文（详见下节） |
| 同会话重复请求 | 宿主返回 `409 busy-session`（多标签页同时点同一会话时可见），提示「这个会话已经在优化中了」 |
| 全局并发打满 | 宿主返回 `429 too-many-requests`（默认上限 4，可用 `maxConcurrentCalls` 调），提示带上限值 |
| 生成中再点 | **取消**（abort；宿主侧同时取消上游模型调用，不产生费用累积） |
| 生成中用户继续打字 | 流式下用**"本次调用里我们写过的每一版文本"集合**做 CAS（`draftRev` 每次写入都会推进，不能当基线）：当前草稿落在集合之外即认定用户手改 → 中止本次并提示「草稿已变化」 |
| 成功后 | 出现 ↶ 撤销按钮；提示 3 秒后自动消失 |
| 撤销 | CAS 通过才回退到优化前草稿（判据是"当前草稿仍等于 `after`"）；草稿被手改过时第一次点击只警告，**再点一次强制还原** |
| 撤销深度 | 每会话 10 层，可连按逐层回退；按会话隔离，最多保留 20 个会话（LRU） |
| 草稿含 `@引用` 芯片 | 拒绝发起（整体 `setDraft` 会把芯片拉平成纯文本），提示先删掉芯片。注意 `occurrences` 只覆盖引用芯片，`/命令` 是纯文本、不在其中 |
| 输入机非空闲（提交/裁决中） | 按钮禁用 |
| 宿主报错 | 直接展示宿主返回的 `message`（如「草稿 9001 字，超过上限 8000 字」）；403 有专门文案；404/405 按「宿主路由未挂载」提示 |
| 宿主半没挂载 | 客户端提示「宿主路由未挂载（插件宿主半未启用？）」——实测这种情况下 `POST` 拿到的是 **405 空体**（SPA fallback 先拦非 GET/HEAD），不是 404 |

> **版本适配（真机踩坑记录）**：已安装的 dsh 0.1.2-rc.1 对 `conversation.input.left/right` 调的是
> `renderSlot(name, {})`，**没有 owner props**——所以本插件一律通过框架注入的 `useInput` 读输入状态，
> 不读 `props.input`（新版本源码才把 `InputZone` 传给这两个座位）。`sessionId` 来自 `ui-session` 的
> kit 合并，缺包时回落到全局单栈（有 CAS 兜底）。详见 `DESIGN.md` 的 R-3 / R-13。

提示文本用 GUI 的设计令牌上色（`--dsw-alias-state-{success,warn,error}-primary`），令牌缺失时回落 `currentColor`。

## 流式回填（P5.6）

点击 ✨ 后不再"转圈等一整段"：宿主走 **SSE** 把文本增量推过来，客户端**边收边写回草稿**，
所以你能看着草稿被逐句替换。要点：

- **两条路由并存**：`POST /optimize/stream`（SSE，默认走它）与 `POST /optimize`（一次性 JSON，回退）。
  两者**准入条件完全一致**（共用同一段校验：信任判定、字数上限、并发闸门、生效配置），
  否则"流式那条更松"就会变成绕过口子。
- **自动回退**：旧宿主没有这条路由（404/405）、浏览器拿不到 `response.body`、或网络层失败时，
  客户端自动改用一次性 JSON——流式是**增强**，不该在任何环境里变成新的失败面。
- **写入节流 80ms**：不按 token 写，避免每个增量都触发一次编辑器整体重写（节流期间先攒着，
  收尾时一定写最终文本）。
- **失败不留半截草稿**：流中途 error 帧 / 连接被掐断时，把已经写进去的增量**还原成原文**，
  再提示失败原因（提示里带「已还原原文」）。
- **CAS 换了判据**：流式下每次写入都会推进 `draftRev`，所以不能再拿它当基线（那会把自己写的东西
  判成"用户改过"）。改为记住"本次调用里我们写过的每一版文本"：当前草稿落在集合之外才算用户手改，
  此时立刻中止（宿主侧随之取消上游）并提示「草稿已变化」。
- **取消/超时**：生成中再点 = 取消（照旧）；超时会给客户端一个 `error: timeout` 事件，
  而客户端自己断了就不再往那条 socket 写。

## 优化风格（P6.1 / P6.2）

「优化风格」是**可多选**的改写口味：勾上「精简」就压篇幅，勾上「转规格」就条目化，两个都勾就叠加。

- **清单是内置的**（`lib/policy.js` 的 `STYLE_DEFINITIONS`：`concise`=精简、`spec`=转规格）。
  为什么不做成"从 `cordis.patch.yml` 的 presets 读清单"：设置命名空间的字段必须**可枚举**
  （path ops 按字段寻址、schema 是静态的），而 `presets` 的 id 是部署方随便起的——
  没有静态字段名就没法"每个风格单独配提示词"。
- **提示词三层覆盖**，也是唯一的事实来源顺序：

  | 层 | 在哪配 | 说明 |
  |---|---|---|
  | 设置页 | 设置 → 输入优化 → 优化风格提示词 | 优先级最高；**留空**就往下落 |
  | 组合层 | `cordis.patch.yml` 的 `presets` 里**同 id** 的那一项 | 老部署原来就写在这里，升级后行为一字不差 |
  | 内置默认 | `lib/policy.js` | 兜底，永远可用 |

- **拼装顺序固定**：基础提示词 → 选中的风格（按**清单顺序**，不是点击顺序）→ 预设（收尾）。
  固定顺序是为了"同一组选择无论怎么点出来，system prompt 都逐字节相同"。

  ```
  BASE
  本次额外要求（精简）：在保留全部约束的前提下压缩篇幅，去掉客套与重复表述。
  本次额外要求（转规格）：改写为条目式需求，包含背景、目标、约束与验收标准。
  ```

- **勾选不落盘**：勾选是"这一次想怎么改写"的即时选择；需要持久化的是"每个风格的提示词是什么"。
- **提示词正文不下发**：`/catalog` 只给风格的 `id`/`label`/**生效来源**，
  正文留在宿主（与 `presets` 同一条规矩）。设置页里那几栏显示的是**用户自己填的值**，
  空着时按来源标签告诉你当前用的是哪一层。
- **未知风格 400**（`unknown-style`）：静默忽略会让用户以为风格生效了。
- **兼容**：一个都不勾时请求体里**没有** `styleIds` 字段，响应体里也没有——
  老客户端 + 新宿主、新客户端 + 老宿主两个方向都照常工作。

## 打开插件配置文件（P6.3）

设置页底部有「打开插件配置文件」，一键用编辑器打开本插件的组合层配置 `cordis.patch.yml`
（就是 `package.json` 里 `dsh.bundle.patch` 声明的那个文件）。

- **路径由宿主解析**，不是前端拼的：`lib/index.js` 用自己的模块位置推出包根
  （`link:` 安装指向仓库、正式安装指向 profile 的 `node_modules`）。设置页同时把绝对路径
  显示出来，方便手动打开或复制。
- **为什么不是简单的"交给系统默认关联"**：`.yml` 在不少 Windows 机器上**根本没有关联**
  （本机实测 `assoc .yml` → `File association not found`），此时 `explorer.exe <file>`
  只会弹一个「你要如何打开这个文件？」——按钮就变成"点了没反应"。所以给了一条**必然可用**的候选链：

  | 平台 | 候选（按顺序试，起不来就落到下一个） |
  |---|---|
  | Windows | `Code.exe`（VS Code 的常见安装位置）→ `notepad.exe`（系统自带，保证可用） |
  | macOS | `open -t`（`-t` = 强制用默认**文本**编辑器） |
  | Linux | `xdg-open` |

  Windows 上刻意不用 PATH 上的 `code`：那是 `code.cmd`，Node 从 18.20/20.12 起禁止在不开
  shell 的情况下 spawn `.cmd`（EINVAL），而开 shell 又要把路径交给 cmd 解析（引号/`&` 都是坑）。
- **这是一条能力路由**（会在宿主上起进程），准入条件与 `/optimize` 同级：**必须有浏览器会话**，
  不能靠本机任意进程触发。
- **失败都有明确提示**，且都带上可直接照做的绝对路径：文件不在（404 `config-missing`）、
  平台不支持（501 `open-unsupported`）、全都起不来（500 `open-failed`，附每个候选的错误）。
  前端只负责显示提示，不做任何静默失败。
- 真机验收（会真的打开文件）：

  ```powershell
  node .perf/verify-open-config.mjs
  # status=200 body={"ok":true,"path":"...\\cordis.patch.yml","openedWith":"...\\Code.exe"}
  ```

## 设置页（设置 → 输入优化）

设置面板左侧导航里多一项「输入优化」，用来配置这个按钮**用哪个模型、哪段提示词**。

| 区域 | 能配什么 | 说明 |
|---|---|---|
| 提示词 | 「使用自定义提示词」开关 + 提示词正文 | 开关关闭时用插件配置的 `systemPrompt`，再往下才是内置文案 |
| 优化风格提示词 | 「精简」「转规格」各一个输入框 | **每个风格单独配**；留空则回落到 `cordis.patch.yml` 里同 id 的预设、再往下是内置默认。旁边标出当前生效来源。勾哪些风格是每次优化时在输入框下拉框里选的，不在这里保存 |
| 模型 | Provider + 模型名称 | 两个输入框都带候选（datalist）：目录来自宿主已注册的适配器；目录为空或想用未列出的模型时**直接手填**。旁边有「测试」按钮，走宿主 `resolveModelInfo` 只做解析校验，不发真实请求、不产生费用 |
| 调用参数 | Temperature、输出 token 上限、超时（毫秒） | 留空 = 用适配器/组合配置/内置默认 |
| 操作 | 保存 / 测试 / 恢复默认 / 打开插件配置文件 | 「恢复默认」清空本页所有用户设置（含逐风格提示词）；「打开插件配置文件」见上节 |

**生效优先级**：内置默认 ← `cordis.patch.yml` 的 `config`（组合层）← 设置页（用户层）。
设置页保存后**下一次优化即生效**（宿主每次请求现读解析后的配置），不需要重启或刷新。

**持久化**：走 dsh 标准设置通道——宿主 `ctx.settings.register('better-input', schema)`，文档由
`dsh-settings-file` 落在 `$DSH_HOME/settings.yaml`。所以「重启应用 / 刷新页面后配置仍在」是框架保证的：
本插件不自造存储，也不自己拼配置文件。

**校验**：客户端先行预校验（逐字段给中文提示，不合法就连写入都不会发出），宿主再用 schemastery schema
+ 跨字段 `validate` 复核。典型规则：

- 启用了自定义提示词但内容为空 → 拒绝；
- Provider 与模型名称只填了一个 → 拒绝（要么都填，要么都留空用默认）；
- Temperature 不在 0–2、输出上限不在 1–200000、超时不在 1000–600000 ms、非整数 → 拒绝。

> **宿主拒绝时不会抛错**：`settingsScope.mutate()` 内部在 `!response.ok` 时只 `recover()` 然后正常返回
> （只有装配错误才 reject），所以"保存成功"必须由调用方自己核对镜像里的值是否真的变了。
> 设置页用 `opsApplied()` 做这件事：没生效就报「宿主没有接受这次写入…」并保留用户的编辑，
> 绝不假报"已保存"。两侧的区间常量也保持同值，避免"客户端放行 → 宿主拒绝 → 静默失败"。

**未配置时**：全部字段留空即可——宿主回落到默认模型（`agentDefaultModel.currentSelection()`）与
默认提示词，不报错。若部署确实没挂设置提供者，设置页会显示「设置服务不可用」（并附上宿主返回的原因，
如果有），而优化按钮照常工作。

> **注册时机（真机事故修复，2026-09-11）**：命名空间注册**不能**在 `apply()` 里一次性
> `ctx.get('settings')`——`SettingsProvider` 的 `async *[Service.init]()` 要 `await load()`
> （读 `settings.yaml`）之后服务才 ACTIVE，而 `ctx.get(name)` 等价于
> `ctx.reflect.get(name, strict = true)`，对"已提供但未 ACTIVE"的服务返回 `undefined`。
> 本插件只 inject `webServer`/`llm`，**可能先于设置提供者激活**：一次读输掉竞态就永久降级，
> 表现正是"设置服务不可用，重启也照样"。现在改为 `ctx.inject(['settings'], …)`：服务就绪才注册、
> 服务卸载即回收（`lib/settings.js` 的 `bindSettings`）。

## 配置参考（`cordis.patch.yml` 的 `config:`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时不挂路由 |
| `systemPrompt` | 内置（见 `lib/policy.js`） | **默认**提示词；设置页启用自定义提示词时被覆盖 |
| `model.provider` / `model.model` | 省略 | 固定模型路由；**必须成对出现**。被设置页覆盖；都没配时用宿主当前默认选择 |
| `presets[].{id,label,prompt}` | `[]` | 预设；请求带 `presetId` 时其 `prompt` 追加到 system。`id`/`label` 会经 `/catalog` 下发到输入框旁的 `▾` 菜单（`prompt` 不下发）。**id 命中内置优化风格**（`concise`/`spec`）时语义不同：它是那个风格的**组合层提示词**、被设置页覆盖，且会以多选勾选项出现（不再列进预设区）。见「优化风格」一节 |
| `stylePromptConcise` / `stylePromptSpec`（**用户设置**，非本文件） | 空 | 逐风格提示词，写在设置页里；这里列出来只是说明它压过 `presets` 里同 id 的那一项 |
| `maxInputChars` | `8000` | 输入字数上限（超限 400） |
| `maxOutputTokens` | `1024` | 输出 token 上限，**取值域 1–200000**（截断仍返回文本并标 `truncated: true`） |
| `timeoutMs` | `30000` | 单次调用超时，**取值域 1000–600000 ms**（超时 504） |
| `temperature` | 不传 | 采样温度，取值域 0–2（缺省交给适配器决定） |
| `maxConcurrentCalls` | `4` | 全局并发调用上限，取值域 1–64。**同会话单航班**始终生效（第二条得 409），超上限得 429 |

未知字段名、类型错误或**超出取值域**都会让**启动失败并报出字段名**（fail loud，避免「拼错字段却以为生效了」，
也避免 `AbortSignal.timeout` 超范围时每次请求都 502）。
这项配置是**组合层**：设置页里的用户值优先于它，改它需要重启 `dsh web`（`patchReload: live` 会重载 patch，但插件自身的 Node 代码不热重载）。

## HTTP 契约

配置的**读写不走这些路由**（走标准设置通道），这里是能力路由与设置页的只读支撑路由：

```
POST /api/dsh-input-optimizer/optimize
body: { text: string, sessionId?: string, presetId?: string, styleIds?: string[] }
      // styleIds：多选优化风格（concise / spec），去重后按**风格清单顺序**拼 system；
      // 省略或空数组 = 不发这个字段（老客户端的行为完全不变）

200 { text, modelUsed: { provider, model }, presetId?, styleIds?, truncated? }
400 { error: 'bad-request' | 'empty-text' | 'text-too-long' | 'unknown-preset' | 'unknown-style', message }
401 { error: 'unauthorized', message }        // 缺浏览器会话（见下「安全」）
403 { error: 'forbidden' }
405 { error: 'method-not-allowed' }
409 { error: 'busy-session', message }        // 同一会话已有优化在跑（单航班）
413 { error: 'body-too-large' }
429 { error: 'too-many-requests', message }   // 全局并发达上限（maxConcurrentCalls）
499 { error: 'client-gone', message }        // 客户端已断开（非标准码，nginx 习惯用法）
502 { error: 'no-model-route' | 'model-failed', message }
504 { error: 'timeout' }

POST /api/dsh-input-optimizer/optimize/stream        // SSE，客户端默认走这条
body: 与 /optimize 完全相同
状态码：准入阶段（校验/闸门/信任判定）失败时与 /optimize 完全一致；**一旦开流就只走事件**：
  : ok                                    // 注释帧：流已开（立即 flush）
  event: delta  data: { text }            // 文本增量（只发 text-delta，不发 reasoning）
  event: done   data: { text, modelUsed, presetId?, styleIds?, truncated? }
                                          // text 是装配后的权威文本，客户端以它为准
  event: error  data: { error, message }  // 'model-failed' | 'timeout' | 其它请求级错误码

GET  /api/dsh-input-optimizer/catalog
200 { namespace,
      settings: { available, reason?, section },
      providers: [{id,name}],
      limits: { maxInputChars, temperature:{min,max}, maxOutputTokens:{min,max}, timeoutMs:{min,max} },
      presets: [{id,label}],                  // prompt 不下发；客户端不再自己维护规则镜像
      styles: [{id,label,source}],            // 内置优化风格；prompt 同样不下发
      configPath,                             // 插件配置文件绝对路径（给「打开配置文件」用）
      effective: { provider, model, temperature, maxOutputTokens, timeoutMs,
                   sources: { prompt, model, temperature, limits } } }

GET  /api/dsh-input-optimizer/catalog/models?provider=<id>
200 { provider, models: [{id,name}] }        // 适配器没有目录时 models 为空数组，不是错误
400 { error: 'missing-provider', message }
502 { error: 'catalog-failed', message }     // provider 未注册（listModels 抛 NO_ADAPTER）

POST /api/dsh-input-optimizer/check
body: { provider: string, model: string }
200 { ok: true, provider, model, name, context?, defaultMaxTokens? }
    // context 取自 LlmResolvedModelInfo.context.contextWindow（该字段是对象，不是数字）
200 { ok: false, provider, model, message }  // 解析不了的原因（不发真实请求、不计费）
400 { error: 'missing-model', message }

POST /api/dsh-input-optimizer/open-config     // 用编辑器打开插件配置文件（会在宿主上起进程）
body: 无
200 { ok: true, path, openedWith }           // path 是绝对路径，openedWith 是实际用的编辑器
401 { error: 'unauthorized', message }       // 能力路由：必须有浏览器会话
403 { error: 'forbidden' }
404 { error: 'config-missing', message }     // 配置文件不在（附绝对路径）
405 { error: 'method-not-allowed' }
500 { error: 'open-failed', message }        // 候选编辑器全都起不来（附各候选的错误与路径）
501 { error: 'open-unsupported', message }   // 未知平台（附绝对路径，让用户手动打开）
```

安全（P5.4 起）：信任判定**优先交给框架**——`ctx.connection.requestRejection(request)` 给出
`403`（Host/Origin 围栏不过：DNS rebinding、异源 Host）、`401`（围栏过了但缺浏览器会话）或放行；
`connection` 不可用或抛错时回落到本插件原有的环回围栏（socket ∈ `127/8`/`::1`/`::ffff:127/8`
**且** Host 是本机名 **且** 无跨站标记；永不信任 `X-Forwarded-For`）。

401 的处置按**路由是否会花掉凭据**分级：

| 路由 | 是否要求浏览器会话 | 原因 |
|---|---|---|
| `POST /optimize`、`POST /optimize/stream` | **是** | 会消耗模型凭据；而凭据可能来自**环境变量**（`apiKeyEnv`），本机其它进程读不到它，却能借这条路由花掉它 |
| `POST /open-config` | **是** | 会在宿主上起进程（编辑器）；本机任意进程都不该能触发 |
| `GET /catalog`、`GET /catalog/models`、`POST /check` | 否（仅环回） | 只暴露 provider/模型名与本插件配置，不花凭据；保留"命令行就能排查"的能力 |

浏览器侧无需做任何事：会话 cookie 由 `dsh web` 打印的带 token 的 URL 换取，页面内同源 `fetch`
会自动带上。顺带一提，因为整体走框架围栏，**LAN/`trustedHosts` 部署现在也能用**（带会话的浏览器即可）。

请求体上限 256 KiB；调用超时与客户端断开都会取消上游。

## 开发循环

- **浏览器半**：`dsh-client-hmr` 每 500ms stat-poll `lib/client.js`（比对 mtime+size），保存即被热替换进运行中的页面（约 0.5s，无需刷新）。所以逻辑尽量放浏览器半。
  - 代价：插件内 React state 会丢（P3 的撤销栈因此放模块级 Map，而非组件 state）。
  - 样式表**必须**自带 `data-plugin`/`data-plugin-css`：框架在物化期把所有未打标的 `<style>` 认领给当时正在物化的插件，不打标就会被别的插件抢走，那个插件 HMR 重载时顺手删掉它。
- **宿主半**：改 `lib/index.js` / `lib/policy.js` 需要重启 `dsh web`。
- 每次改完先 `npm test`，再动 GUI。
- 宿主半要打印日志必须用 `ctx.logger`（**不是** `ctx.get('logger')`：logger 不是 reflect 注册的服务，后者恒为 `undefined`，会让所有日志静默丢失）；参数按 printf 风格传。

## 工程化

```powershell
npm run verify     # 一条命令跑完全部检查：lint → 约定守卫 → 四个套件
npm run lint       # Biome lint（只 lint，不 format，理由见下）
npm run guards     # 约定守卫：把踩过的坑变成可自动检查的规则
npm test           # 约定守卫 + 宿主半 + 浏览器半 + 真 React + 真框架集成
npm run link-deps  # 手动补 dev 依赖链接（pretest 会自动跑）
```

| 检查 | 覆盖什么 | 覆盖不到什么 |
|---|---|---|
| **Biome lint** | 未使用变量/导入、可选链、赋值混进表达式、等宽比较等 | 不做类型检查（Biome 不是类型检查器） |
| **约定守卫**（`scripts/check-guards.mjs`） | 18 条规则，逐条对应真实事故：`ctx.get('logger')`、设置注册一次性读、样式未打 `data-plugin`、保存未自查、并发闸门占位/释放、**闸门占位必须排在会抛的校验之后**、客户端自带宿主区间常量、SSE 分帧与流式回退、风格 id 校验、风格提示词不得下发、打开配置文件的路径与准入、新套件没接进 `npm test` | 只认字面写法，不理解语义（所以规则要写"为什么"） |
| **宿主半冒烟**（59 例） | 配置校验、信任判定三分支、六路由全链路、SSE 分帧与断流、注册时机、并发闸门（含**失败后名额必须归还**的回归）、多选风格与提示词分层、catalog 不下发提示词正文、打开配置文件的候选链 | 不碰真实 LLM（`ctx.llm.stream` 是替身）；不起真实进程 |
| **浏览器半冒烟**（60 例） | 座位注册、组件契约、接线与 CAS、流式回填（节流/中止/还原/回退）、多选风格勾选与请求体、菜单关闭手势（点内部不收起）、逐风格提示词表单与保存、打开配置文件按钮、撤销栈、设置页 | 用**手写 React 替身**：hook 语义是简化的（但 `document` 监听器是真的登记表，否则"点内部不收起"这条测不出来） |
| **真 React 渲染**（6 例） | 用真 `react`/`react-dom` 走 SSR 真渲染路径，并把渲染期 `console.error`（React 的警告通道）当失败 | SSR 不跑 effect、也没有 DOM：拉目录/订阅/点击/菜单开合不在范围 |
| **真框架集成**（4 例） | 真 cordis + 真 `dsh-settings-file`：提供者先到/后到/缺失三种时序、"注册后写得进 `settings.yaml`"，以及**逐风格提示词的全链路**（写入 → 落盘 → 生效来源变 `settings` → 下一次请求的 system 真的用它） | 不启真实 webserver、不调真实 LLM（两者都用替身捕获） |
| **启动耗时基准**（`.perf/`） | `dsh web` 冷启动墙钟时间、插件边际成本、阶段归因；交替 A/B 消抖动 | 不起真实 GUI（`--port 0 --no-open`，不影响正在跑的实例） |

**为什么只 lint 不 format**：既有代码的排版是刻意的（CSS 片段逐条成行、测试里成组的紧凑断言、JSDoc 分组），
批量重排会产生上千行纯格式 diff，让 review 失去信号。需要时可对单个文件跑 `npm run format`。

**CI**（`.github/workflows/ci.yml`）：Windows 上跑 lint + 约定守卫 + 四个套件，宿主依赖从 registry 装
（CI 里没有 dsh 安装，`link-dev-deps` 会检测到"依赖已可从仓库解析"而安静跳过）。
装完还会 `npm ls --depth=0` 再校验一次：npm 11 在某些 flag 下会**静默跳过**已在 `package.json` 里
声明为 peer 的那几个包（退出码仍是 0），这道校验专门把这种"假绿"变成红灯——2026-09-10 CI 首跑
exit 1 就是这么被放过去的（根因写在 workflow 的注释里）。
CI 里的 react/react-dom 是 18.3.1，而本机那对是 19.2.8——真 React 套件因此**同时覆盖两个大版本**。

**typecheck 为何还没上（P5.7b）**：`tsconfig.json` + `checkJs` 是对症的（最近两轮多个缺陷是"类型判错/契约判错"），
但本机**既没有 tsc 也没有网络**可以安装（TypeScript 不在 dsh 安装里，registry 不可达），
所以这一轮**不提交未校准的配置**——那只会让 CI 首跑即红。补法（需要有网的环境，约半天）：
1. `npm i -D typescript`，加 `tsconfig.json`（`allowJs`+`checkJs`+`noEmit`，`strict: false` 起步）；
2. 给宿主 ctx 写一份最小 typedef（`webServer`/`llm`/`settings`/`logger`/`connection` 的用法面），
   再把 `@param {object} ctx` 换成它——`ctx.llm.resolveModelInfo().context` 这类误判就会被静态抓住；
3. 首次运行会暴露一批 JSDoc 类型需要校准（预期是"手写 bundle + 无类型依赖"的必然代价），
   校准完再把 `npm run typecheck` 接进 CI。

## 下一步

按 ROI 排序：

1. **P5.7b typecheck**：见上（需要有网环境先装 tsc）。
2. **P5.7c vitest + jsdom**：把浏览器半那套手写 React 替身换成真 React + DOM 环境（现在只覆盖了渲染契约，
   effect/点击/菜单开合仍由替身语义兜着）。不是必须——真 React SSR 套件已经补住了"组件是否合法"这一层。
3. **P5.8 芯片保留**：草稿含 `@引用` 时目前直接拒绝（整体 `setDraft` 会拉平芯片），后续可研究用 `insertReference` 重建。
4. **启动耗时**：`.perf/` 那套基准可以随时复跑；目前只有一次 29.7 s 的启动**未能复现**（见 `.perf/README.md` 第 5 节），若要坐实需要在慢启动现场抓 profile。
5. **可选**：把 `presets` 的**增删**也搬进设置页（现在只能在 `cordis.patch.yml` 里加/删预设，改完要重启；
   逐风格提示词已经可以在设置页改并即时生效）；给宿主日志加文件落盘（`dsh web` 只写 stdout，事故复盘只能用 API 反推）。
