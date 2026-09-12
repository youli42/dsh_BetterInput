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
| P7.0 | **系统提示词可见**：设置页展示默认系统提示词（内置/组合层），可查看、可一键"以默认为基础编辑" | ✅ 已实现（2026-09-11） |
| P7.1 | **追加提示词**：设置页可新增多条命名提示词，输入框旁 ▾ 菜单随时切换，落盘并即时生效 | ✅ 已实现（2026-09-11） |
| P7.2 | **恢复默认配置**：一键还原全部用户设置（含追加提示词与内置覆盖），带确认 | ✅ 已实现（2026-09-11） |
| P8 | **风格并入清单**：精简/转规格成为追加提示词的内置条目（单选切换），不再单独多选；`styleIds` 仅为旧客户端兼容保留 | ✅ 已实现（2026-09-11） |
| P9 | **命名与语义对齐**：设置页改为「系统提示词 / 追加提示词」，追加条目**只追加、不替换**系统提示词 | ✅ 已实现（2026-09-11） |
| P10 | **设置界面重设计**：输入框默认隐藏（点「编辑」才展开）、行距压到最小、四个分组 + 一行摘要同屏可见 | ✅ 已实现（2026-09-11） |
| P11 | **进度与思考过程**：优化中显示「阶段 + 耗时 + 字数」，并把模型的思考增量透传成「思考过程」面板 | ✅ 已实现（2026-09-11） |
| P12 | **控件收敛**：工具行只留 ✦ 与 ▾，撤销与思考回看收进 ▾ 菜单的「本次调用」分区；▾ 常驻并带"可撤销"角标；成功不再弹提示 | ✅ 已实现（2026-09-11） |
| P5.7b / P5.7c / P5.8 | typecheck（缺 tsc）、vitest+jsdom、芯片保留 | ⬜ 待做（见「下一步」与「工程化」） |

检查：lint 零发现 · 约定守卫 23 条 · 测试 70 + 78 + 6 + 6 = 160 例，全绿
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
lib/policy.js         策略层：零依赖，配置校验/信任围栏/生效配置解析/风格提示词分层/追加提示词/显示思考过程（可独立单测）
lib/client.js         浏览器半：输入框按钮 + ▾ 统一菜单（撤销 / 思考回看 / 追加提示词 / 预设）+ 撤销栈 + 进度行与思考面板 + 设置页（手写 __ModuleLoader__ bundle）
lib/types/*.d.ts      对外类型
.perf/                Web 启动耗时基准脚本与测量报告（README.md 有方法与原始数据）
scripts/check-guards.mjs  约定守卫：把踩过的坑变成可自动检查的规则（23 条）
scripts/dsh-packages.mjs  定位 dsh 安装与其中的宿主包（脚本与测试共用）
scripts/link-dev-deps.mjs 把宿主依赖软链进本仓库（`npm test` 前自动跑；CI 里自动跳过）
scripts/lint.mjs      找 Biome 并跑 lint（仓库内 / 全局安装都能用）
test/smoke.mjs        宿主半冒烟测试（70 例）
test/client.smoke.mjs 浏览器半冒烟测试（78 例：接线、控件收敛、流式回填、进度行与思考面板、统一菜单、撤销栈、设置页紧凑布局）
test/client.react.mjs 真 React 渲染测试（6 例：真 react/react-dom SSR，含"不得有 React 警告"）
test/settings-activation.mjs 真框架集成测试（6 例：真实 cordis + 真实 settings 提供者，含追加提示词、思考透传全链路）
.github/workflows/ci.yml  CI：lint + 约定守卫 + 四个套件（Windows）
DESIGN.md             设计依据：座位/接口证据、撤销追加提示词、提示词分层、风险清单
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
4. **P8/P9（风格并入清单 + 系统提示词 / 追加提示词）**：✨ 右侧的 `▾` 菜单最上方是追加提示词区：
   「不追加」+ **精简 / 转规格**（内置条目，● = 当前启用）。点「转规格」→ 选中标记移动、提示"已切换"
   （`activeProfileId` 落盘）；点 ✨ 优化，请求体**不带** `styleIds`，效果 = 系统提示词 +
   `本次额外要求（转规格）：…`（`/catalog` 的 `effective.profileId === 'spec'`）。
   到设置页「追加提示词」给「转规格」填正文并保存，再点 ✨：追加的那段换成你写的文字
   （系统提示词本身不变）；清空再保存则回到内置追加文案。
5. **P6.3（打开配置文件）**：设置页底部点「打开插件配置文件」→ 用编辑器打开
   `F:\dsh\dsh_BetterInput\cordis.patch.yml`（设置页上同时显示这个绝对路径）。
   可用 `node .perf/verify-open-config.mjs` 走同一条链路做命令行验收。
6. **P7（默认系统提示词可见 + 追加提示词切换）**：设置页「系统提示词」区点「查看默认系统提示词」→
   展开宿主下发的默认正文；「追加提示词」区点「新增追加提示词」、填名称与正文、保存；
   到输入框旁 `▾` 菜单点这条（● 移到它上面、提示"已切换"）→ 点 ✨ 优化，DevTools → Network 里
   这次请求虽不带追加提示词信息，但宿主 `settings.yaml` 的 `activeProfileId` 已变、
   模型收到的 system 里多出 `本次额外要求（名称）：…`（`/catalog` 的 `effective.profileId` 同步更新，
   `sources.prompt` 仍如实标注**基底**来自哪一层）。
   「恢复默认配置」点一下会先弹确认，确认后追加提示词、自定义系统提示词、内置条目覆盖全部清空，
   `/catalog` 的 `effective.sources.prompt` 回到 `config`/`default`。
7. **P10（设置界面重设计）**：打开 设置 → 输入优化：
   - 默认视图里**一个输入框都没有**，只有操作条 + 四个分组标题 + 各自一行摘要 + 追加提示词清单；
     同屏应当能看完全部主要设置（不用滚到底部找「保存」——它在最上面）。
   - 点「系统提示词」右侧的「编辑」→ 开关与正文框出现；再点「收起」→ 控件消失。
   - 在收起状态下直接点「保存」（若当前配置不合法）→ 出错的分组会自动展开并显示红字。
   - 「追加提示词」清单常驻：直接点某一行的单选即可切换；点该行「编辑」才出现名称/正文框。
8. **P5.3（预设菜单）**：`cordis.patch.yml` 里配了**非内置 id** 的 `presets` 时，`▾` 菜单下半部分
   列出它们；点某一项 → 请求体里带 `presetId`（可用 DevTools 的 Network 面板确认）。
   一个都没配时只有追加提示词区，界面与从前一致。
8. **P5.4（宿主会话）**：`POST /optimize` 需要浏览器会话（页面 cookie 由 `dsh web` 打印的
   带 token 的 URL 换取）。命令行只做排查时用只读路由：

```powershell
curl.exe -s http://127.0.0.1:3080/api/dsh-input-optimizer/catalog        # 元数据：免会话（仅环回）
curl.exe -s -X POST http://127.0.0.1:3080/api/dsh-input-optimizer/check `
  -H 'content-type: application/json' -d '{"provider":"leihuo","model":"deepseek-v4.1-flash"}'
# POST /optimize 不带 cookie 会得到 401 unauthorized（这是有意的：凭据可能来自环境变量，
# 本机其它进程不该能借这条路由花掉它）。要从命令行调它，就把浏览器 DevTools →
# Application → Cookies 里那条 dsh 会话 cookie 用 `-b "<name>=<value>"` 带上。
```

8. **P11（进度与思考过程）**：在输入框里写一段草稿、点 ✨：
   - 立刻出现「等待模型 0.0s」并**每秒在涨**（这就是原先完全静默的那一段）；
   - 模型开始输出后变成「写入中 n.ns · N 字」，草稿被逐句替换；
   - 用的是推理模型时，中间会经过「思考中 n.ns · N 字」，按钮上方自动展开「思考过程」面板并实时滚动；
   - 到设置页「调用参数」取消勾选「显示思考过程」并保存，再点 ✨：**只有进度行**，不再有面板
     （宿主侧也可用 `curl` 看 `/catalog` 的 `effective.showReasoning === false` 佐证）；
   - DevTools → Network 里那条 SSE 请求应当按序出现 `event: reasoning`（若有思考）与 `event: delta`，
     且**任何思考文本都不会出现在草稿或撤销记录里**。
9. **P12（控件收敛）**：同一次带思考的优化之后，
   - 工具行里**只有 ✦ 与 ▾ 两个按钮**（DevTools 里数一下 `[data-dsh-better-input-wrap]` 的直接子按钮）；
   - 菜单**收起时** ▾ 右上角有一个小圆点（= 有可撤销记录）；成功不再闪「已替换为优化结果」；
   - 点 ▾：「本次调用」分区在最上面，含「↶ 撤销上次优化」与「💭 查看思考过程（n 字）」；
     点撤销 → 草稿回到优化前且菜单收起；点思考 → 菜单收起、面板打开（面板里「收起思考过程」可再收起）；
   - 用手改一下草稿再点撤销：菜单项变成「↶ 强制还原原文」且**菜单不收起**，再点一次才真的还原；
   - 断网（或让宿主半不可用）后刷新，再成功优化一次：▾ 仍然出现，撤销照样可达
     （这条钉的是"菜单不该依赖 /catalog"）。
10. **检查**：

```powershell
npm run verify                    # lint + 约定守卫 + 四个套件（推荐）
npm test                          # 约定守卫 + 宿主半 + 浏览器半 + 真 React + 真框架集成
node test\smoke.mjs               # 宿主半 70 例：生效配置、信任判定、并发闸门、六路由全链路、SSE 分帧、思考透传、追加提示词（含内置种子）、打开配置文件
node test\client.smoke.mjs        # 浏览器半 78 例：座位、控件收敛、流式回填、进度行与思考面板、统一菜单、撤销栈、设置页紧凑布局
node test\client.react.mjs        # 真 React 6 例：真 react/react-dom SSR 渲染（含"不得有 React 警告"）
node test\settings-activation.mjs # 真框架集成 6 例：真实 cordis + 真实 settings 提供者，钉住注册时机、提示词与思考透传链路
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
| 点击 ✨ | `POST /api/dsh-input-optimizer/optimize/stream`（默认；`/optimize` 是回退），body `{ text, sessionId, presetId? }`（`styleIds` 仅为旧客户端兼容保留），成功后 `setDraft` 写回 |
| 工具行里有什么（P12） | **只有两个控件**：✦ 优化（生成中 = 取消）与 ▾ 菜单。撤销、思考回看、追加提示词、预设全在 ▾ 里，见下「控件收敛」一节 |
| ▾ 菜单的「本次调用」分区 | 撤销（有可撤销记录时出现）与「查看思考过程（n 字）」（本次调用收到过思考时出现）。这一区随"上一次调用的产物"出现/消失，**不依赖 `/catalog`** |
| 可撤销角标 | 有可撤销记录时 ▾ 右上角有个 5px 圆点——撤销住进菜单后，菜单收起时这是唯一的提示 |
| ▾ 菜单里的「追加提示词」 | **单选**：「不追加」+ 内置条目（**精简 / 转规格**）+ 设置页里保存的各条追加提示词，选中的那条接在**系统提示词**之后。切换即写进设置（`activeProfileId`）落盘，下一次优化生效；菜单不收起，选中项带 ● 标记 |
| 内置追加提示词（精简 / 转规格） | 追加提示词清单的常驻种子：未被覆盖时，它的正文就是该风格的追加要求原文（与旧"勾选风格"逐字节一致）；在设置页改了它就是改这段追加文案。不可删除 |
| 追加提示词（设置页） | 内置条目与自定义条目在**同一个清单**里：改内容、单选「启用」；可新增多条命名追加提示词。系统提示词永远在场，追加只增不改。见下「追加提示词」一节 |
| 预设菜单（`▾`） | 与内置条目同 id 的预设不列进预设区（它们是内置条目的追加文案来源）；其余预设点一次跑一次，请求带 `presetId`，宿主把该预设的 prompt 追加到 system。菜单向上弹出，点外面或 Esc 收起 |
| 草稿超过宿主上限 | 本地直接提示「草稿过长（n/上限）」，不发请求（上限来自 `/catalog` 的 `limits`） |
| 流式回填 | 默认走 SSE：增量到达即改写草稿（80ms 节流）；失败/中断会还原原文（详见下节） |
| 优化中的进度 | 按钮旁常驻一行「阶段 + 已耗时 + 已收字数」（等待模型 / 思考中 / 写入中），耗时由本地计时器推进；按钮图标带呼吸动效。**不提供百分比**——`maxOutputTokens` 是上限不是目标，任何比例都是编的（详见「进度与思考过程」） |
| 思考过程 | 模型返回思考内容时，按钮上方自动展开「思考过程」面板（实时跟随、可滚动）；收尾自动收起，之后从 ▾ 菜单的「查看思考过程（n 字）」回看。可在设置页「调用参数」里关掉（关掉后宿主根本不发思考内容） |
| 同会话重复请求 | 宿主返回 `409 busy-session`（多标签页同时点同一会话时可见），提示「这个会话已经在优化中了」 |
| 全局并发打满 | 宿主返回 `429 too-many-requests`（默认上限 4，可用 `maxConcurrentCalls` 调），提示带上限值 |
| 生成中再点 | **取消**（abort；宿主侧同时取消上游模型调用，不产生费用累积） |
| 生成中用户继续打字 | 流式下用**"本次调用里我们写过的每一版文本"集合**做 CAS（`draftRev` 每次写入都会推进，不能当基线）：当前草稿落在集合之外即认定用户手改 → 中止本次并提示「草稿已变化」 |
| 成功后 | **不弹提示**（P12）：草稿被替换是肉眼可见的；「还能撤销」由 ▾ 上的圆点表示。只有截断这类"界面上看不出来"的结果才提示 |
| 撤销 | 在 ▾ 菜单的「本次调用」分区里点一次；CAS 通过才回退到优化前草稿（判据是"当前草稿仍等于 `after`"）。草稿被手改过时**第一次点击只武装**（菜单项文案变成「强制还原原文」，菜单保持展开），**再点一次强制还原** |
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

## 进度与思考过程（P11）

点 ✨ 之后，"等模型"那一段原先**完全没有反馈**：按钮只是把 ✨ 换成一个静止的图标，草稿要等到模型
吐出第一个文本 token 才会动。推理模型的前几秒到几十秒就是这样白白静着的——看起来像卡死。
P11 补上两件事：

### 进度行（任何模型都有）

按钮旁常驻一行进度，槽位与结果提示共用（生成中显示进度，结束后按需显示失败/截断提示）：

```
等待模型 4.2s                        ← 已发出请求，还没收到任何事件
思考中 8.7s · 312 字                  ← 已收到思考增量（计数 = 已收思考字数）
写入中 12.1s · 156 字                 ← 已开始回填草稿（计数 = 已写进草稿的字数）
```

- **阶段由客户端推导，宿主不发进度帧**：`waiting`（已发出请求、还没收到任何事件）→ `thinking`
  （首个思考增量）→ `writing`（首个文本增量）。等待期没有任何事件，**本地时钟是唯一的进度来源**，
  所以耗时由客户端自己算——服务端心跳帧解决的是"连接是否活着"，那条 fetch/abort 已经覆盖，
  多一种帧只是多一处会漂移的契约。
- **不给百分比是有意的**：`maxOutputTokens` 是上限而不是目标，任何"进度条"都是编的数字。
  能诚实给的是阶段、耗时与计数。
- **计数用字数而不是 token**：客户端自己就能算准，对用户也更直观。
- 按钮图标在生成中带**透明度呼吸**动效（`@keyframes dsh-bi-pulse`）：静止的图标本身就是"卡死"的观感来源之一。

### 思考过程面板（模型给才有）

模型返回 `reasoning-delta`（例如 DeepSeek 推理模型的 `reasoning_content`）时，按钮上方自动展开面板，
实时跟随最新思考（真实 DOM 上自动滚到底），收尾**自动收起**，之后从 ▾ 菜单的「💭 查看思考过程（n 字）」
回看（P12 之前那是按钮行里的一个独立图标）。

- **开关**：设置页「调用参数」里的「显示思考过程」，**默认开**。关掉时宿主**根本不发** `reasoning`
  事件——而不是"发到浏览器再藏起来"。思考正文（模型的推理内容）因此不出宿主。
- **正文绝不进草稿**：`write()` 只由文本增量与 `done` 帧触发，宿主装配权威文本时也只取 text 块
  （两条都有守卫钉着）。撤销栈同理：只有"优化前 → 优化后"的草稿，没有思考。
- **失败也留着**：草稿照旧还原成原文，但思考内容留着可回看——失败原因常常就写在思考里。
- **上限 20000 字（保留尾部）**：生成中要跟着最新思考走；被截断时正文开头明确写一句，
  面板标题里的累计字数仍如实显示总数（截断了却不说，用户会以为模型就想这么点）。
- **两个 100ms 节流**：思考增量是逐 token 到的，每个都 setState 会让组件每秒重渲染上百次；
  面板最多滞后 100ms，而**阶段切换与收尾一律立即落地**（收尾那次会把节流期间攒下的内容一并落地，不丢字）。
- **思考面板与 ▾ 预设菜单互斥**：两者锚在同一处（按钮上方、右对齐），同时打开会叠在一起。
- **兼容性**：老客户端收到未知的 `reasoning` 事件会直接忽略（只认 `delta`/`done`/`error`）；
  新客户端配老宿主则收不到这个事件，只有进度行——**思考是增强，不是新的失败面**。
  回退用的一次性 JSON 路由（`/optimize`）不带思考内容：那条路本来就没有"流"可言。
- **为什么不做"思考中"的骨架动画**：官方 GUI 的推理行是扫光条，但它背后有完整的推理展示组件；
  本插件是第三方条目，只复用设计令牌与既定座位，所以用"真实进度 + 真实思考文本"代替装饰性动画。

## 控件收敛（P12）

一次带思考的成功优化之后，输入框工具行里同时挂着 **4 个控件**（撤销 / 思考 / ✦ / ▾），
再加上进度或提示行与弹出的面板——在一个还要放附件、模型选择器、上下文计量与发送键的行里，
这就是"拥挤"的来源。P12 把工具行收到 **2 个**：

```
✨   ▾                                    ← 静止态就是这两个
✨   ▾•                                   ← • = 有可撤销记录（5px 圆点）
```

点 ▾ 后（菜单向上弹出、右对齐、超高时内部滚动）：

```
┌ 本次调用 ────────────────────┐
│ ↶ 撤销上次优化                │   ← 有可撤销记录时才出现
│ 💭 查看思考过程（312 字）      │   ← 本次调用收到过思考时才出现
├ 追加提示词 ──────────────────┤
│ ○ 不追加（只用系统提示词）      │
│ ● 精简                       │
│ ○ 转规格                     │
├ 预设 ────────────────────────┤
│ 更短                          │
└──────────────────────────────┘
```

四个功能的新路径：

| 功能 | 路径 | 备注 |
|---|---|---|
| 优化输入 | 点 ✦ | 不变；生成中再点 = 取消 |
| 优化选项（追加提示词 / 预设） | 点 ▾ → 对应区点选 | 两个区的内容与语义一字未改，只是排在「本次调用」之后 |
| 撤销上次优化 | 点 ▾ → 「↶ 撤销上次优化」 | 执行成功随即收起菜单；草稿被手改过时菜单项变成「↶ 强制还原原文」且**菜单保持展开**，再点一次即可 |
| 查看思考过程 | 点 ▾ → 「💭 查看思考过程（n 字）」 | 菜单关、面板开；面板里「收起思考过程」回原状 |

要点：

- **菜单必须常驻**：撤销与思考回看都住在里面，所以它的显示条件**不能**只看 `/catalog` 的
  `profiles`/`presets`——目录读取失败（离线、宿主半缺失）时菜单整个消失的话，一次成功的优化之后就
  再也找不到撤销入口，而主按钮看起来一切正常。现在的条件是
  `hasInvocation || profiles.length > 0 || oneShotPresets.length > 0`，有守卫钉着。
- **撤销的返回值是给菜单用的**：`onUndo()` 返回"是否真的执行了还原"。执行了 → 收起菜单；
  只是武装了强制还原 → 菜单留着。这是"菜单里做两步确认"能成立的前提。
- **顺手修掉的脚枪**：以前撤销是独立按钮且生成中仍可点，点它会 `setDraft` 打断正在跑的那次流式调用
  （CAS 判成"用户手改"，结果被丢弃）。现在撤销在菜单里，而菜单在生成中本来就是禁用的。
- **成功不再弹提示**：草稿被替换是肉眼可见的，再闪一句「已替换为优化结果」纯属噪声；
  "还能撤销"改由 ▾ 上的圆点表达。保留的提示只有**界面上看不出来**的那几类：截断、失败、
  已还原原文、草稿已变化……（都是"你不看提示就无法判断"的结果）
- **菜单项用文字前缀而不是图标**：`↶` / `💭` 直接写在文案里。菜单项本来就以文字为主，
  塞 14px 图标既要对齐、又给每个图标多留一条降级路径，而文字前缀在任何图标集下长得一样。
- **点击钩子**：菜单项的 `data-dsh-better-input-undo` / `data-dsh-better-input-thinking-toggle`
  沿用旧名字（外部排查脚本与测试都按它们定位），只是位置从工具行移到了菜单里。

## 优化风格与追加提示词的合并（P6.1/P6.2 → P8/P9）

P6.1/P6.2 时代的「优化风格」是**可多选**的改写口味：▾ 菜单里勾选「精简 / 转规格」（复选框、可叠加、
不落盘），逐风格提示词走"设置页 ← 组合配置同 id 预设 ← 内置文案"三层覆盖，请求带 `styleIds`。

**P8 起这套东西并入了「追加提示词」**：精简/转规格成为清单里的**内置条目**（见下节），
同一个清单、同一个 ▾ 菜单、同一个设置页区块，单选。变更点：

- **多选叠加取消**：精简+转规格不再同时生效——它们是两条独立追加提示词（选其一）。
  想要"既精简又条目化"，把两段要求写进同一条自定义追加提示词即可。
- **新客户端不再发 `styleIds`**；宿主仍兼容旧版浏览器半（`styles` 清单照发、`styleIds` 照收，
  追加语义与旧版逐字节一致），两个方向的升级/回退都不破坏。
- 逐风格提示词的三层覆盖**原样保留**，只是现在的身份是"内置条目的默认追加文案"：
  `stylePromptConcise`/`stylePromptSpec`（遗留设置字段）← `cordis.patch.yml` 同 id 预设 ← 内置文案。
- `/catalog` 的 `styles` 字段只为旧客户端存在；新客户端读 `profiles`（含内置条目，带 `builtIn` 标记）。

## 追加提示词（P7 / P8 / P9）

**系统提示词是基底，追加提示词是接在基底之后的那一条**：设置里的系统提示词（见下节）永远在场，
▾ 菜单选中的追加提示词以 `\n\n本次额外要求（名称）：正文` 接在它后面。两者在设置页里是两个区块，
关系一目了然——这也是 P9 把旧名「提示词 / 提示词方案」改成「系统提示词 / 追加提示词」的原因：
旧名里两个词都含"提示词"，说不清谁是基底、谁是附加。

- **系统提示词（基底）**：设置页第一个区块。取值链：自定义系统提示词开关 → `cordis.patch.yml` 的
  `systemPrompt` → 内置默认。**追加提示词不会替换它**（P9 之前自定义方案是整体替换，语义与名字不符）。
- **追加提示词清单** = 「不追加」+ **内置条目**（精简 / 转规格）+ 你自建的条目：
  - 内置条目常驻清单、不可删除；未自定义时正文 = 该风格的追加要求原文
    （老三层：遗留设置字段 ← 组合配置同 id 预设 ← 内置文案），所以"选中精简"与旧版"勾选精简"
    拼出的 system prompt **逐字节相同**；
  - 在设置页给内置条目填了正文 = 改用你写的追加文案（依旧只追加）；清空 = 恢复内置文案
    （存进设置段的覆盖条目可以省略 name，显示名由宿主按内置标签补齐）；
  - 自建条目：名称 + 正文，可增删；正文就是会接在系统提示词之后的那段话。
- **设置页（设置 → 输入优化 → 追加提示词）**：
  - 内置行在前（名称固定、可改内容、可启用、不可删除），用户行在后（名称 + 正文 + 启用 + 删除）；
  - 「新增追加提示词」加一行；第一项是「不追加（只用系统提示词）」——选它 = 只发系统提示词；
  - 全空的行保存时自动丢弃；填了一半的行（缺名称或缺正文）会在客户端就拦下；
  - 上限 20 条（正文随设置文档整段读写，不给上限就没有刹车）。
- **使用时切换（输入框旁 `▾` 菜单）**：列出全部条目（● = 当前启用），
  点哪条就把 `activeProfileId` 写进设置**落盘**，下一次优化即生效，重启/刷新后仍保持；
  写入失败（mutate 不 reject）时选中标记回退并给出错误提示——与设置页保存同一条"写后自查"的规矩。
- **拼装顺序**：系统提示词 → 启用中的追加提示词 →（旧客户端的 `styleIds`）→ 预设。
  固定顺序保证"同一组选择无论怎么点出来，system prompt 都逐字节相同"。
- **存储**：整个清单是设置命名空间里的**一个数组字段**（`promptProfiles`，每项 `{id,name?,prompt}`），
  加上 `activeProfileId` 记录启用项。设置通道的 path ops 支持对单字段 set 任意 JSON 值，整表一次 set 天然原子；
  `settings.yaml` 里看到的就是这两个人类可读的字段。
- **正文不出清单**：`/catalog` 的 `profiles` 行只含 id/名称/来源/是否内置（由 `profileRowsOf` 生成，守卫钉住）；
  设置页编辑的正文来自用户自己的设置镜像，与"风格/预设正文不下发"是同一条规矩——
  **唯一的例外**是 `defaults.systemPrompt`（内置/组合层的默认系统提示词）有意下发，见下。

> **想要"整段换成完全不同的系统提示词"**：追加语义下做不到按条目替换，但可以直接改「系统提示词」
> 区块（自定义开关 + 正文，全局生效），或把那段话作为追加条目写进去——追加内容在指令序列里更靠后，
> 对模型的实际影响通常更大。

## 默认系统提示词可见（P7.0）

设置页「系统提示词」区块底部有「查看默认系统提示词」：展开后显示**当前默认**的系统提示词全文
（内置文案，或 `cordis.patch.yml` 里配置的 `systemPrompt`——即你什么都没自定义时会用的那一段）。

- **为什么它能下发**：这是部署默认文案而不是用户私密；「系统提示词在设置里可见可编辑」这条需求
  正需要它——否则没启用自定义的用户在设置页只能看到一只空输入框。
- **可一键编辑**：「以默认为基础编辑」把默认正文填进输入框并启用自定义开关
  （只填不启用会让人以为生效了，所以两步并作一步），之后随意修改保存即可。
- **恢复默认配置**：设置页底部按钮（原「恢复默认」），点击先弹确认框（会清空全部用户设置，不可逆），
  确认后清空**所有**用户字段——包括追加提示词与内置条目的追加文案覆盖——回到内置默认与组合配置的值。
  恢复后系统提示词就是上面看到的那段默认文案，追加提示词回到内置文案。

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

设置面板左侧导航里多一项「输入优化」，用来配置这个按钮**用哪个模型、哪段系统提示词、追加什么**。

### 布局（P10 重设计：默认只看摘要，点「编辑」才出控件）

```
┌ 操作条：保存 · 恢复默认配置 · 打开插件配置文件        提示文本 ┐
├ 系统提示词        自定义 · 42 字                    [编辑] ┤
├ 追加提示词        周报                              [新增] ┤
│   ◉ 不追加（只用系统提示词）                                  │
│   ○ 精简      内置追加文案（设置页）                [编辑]    │
│   ○ 转规格    内置追加文案（内置默认）              [编辑]    │
│   ○ 周报      你是周报写手…                       [编辑][删除]│
├ 模型             acme / m1（设置页）                [编辑] ┤
├ 调用参数         温度 默认 · 上限 1024 · 超时 30000ms [编辑] ┤
└ 配置文件：…\cordis.patch.yml ────────────────────────────────┘
```

- **输入框默认隐藏**：收起的分组里**根本不会创建** input/textarea（不是 CSS 隐藏），点分组右侧的
  「编辑」才展开控件；再点一次（此时按钮变成「收起」）即回收。追加提示词清单是**选择**而不是输入，
  所以清单行常驻（单选 + 名称 + 正文摘要），只有某一行的名称/正文输入框需要展开那行。
- **行距压到最小**：正文 12px / 行高 1.45，分组间距 8px，组头 24px，清单行 22px——
  四个分组 + 清单 + 操作条在一屏内同时可见，不必滚动。
- **一屏看全**：每个分组标题右侧是一行**只读摘要**（当前生效值，如「自定义 · 42 字」「acme / m1（设置页）」
  「温度 默认 · 上限 1024 · 超时 30000ms」「周报」），收起状态也能看清现在用的是什么。
- **操作条常驻顶部**：保存 / 恢复默认配置 / 打开插件配置文件不用滚到底部去找。
- **校验失败自动展开**：出错的分组（含追加提示词的某一行）会自动展开并显示错误——折叠状态下的
  "错误提示被藏起来"是这套布局最容易出的事故，有专门用例钉住（`groupsWithErrors`）。
- 只读/不可用两态照旧：不可用时只给提示；只读时仍可展开查看（控件 disabled，不是藏起来）。

### 各区域

| 区域 | 能配什么 | 说明 |
|---|---|---|
| 系统提示词 | 「使用自定义系统提示词」开关 + 正文 + 「查看默认系统提示词」 | 开关关闭时用插件配置的 `systemPrompt`，再往下才是内置文案；这一段是**基底**，永远会发给模型。默认正文可展开查看，并能「以默认为基础编辑」一键填入 |
| 追加提示词 | 内置条目（**精简 / 转规格**，名称固定、可改内容、不可删）+ 多条自定义条目（名称 + 正文，可增删），单选「启用」 | 选中的那条接在系统提示词之后（`本次额外要求（名称）：正文`）；输入框旁 `▾` 菜单里随时切换。内置条目留空 = 用内置追加文案，填写 = 用你写的追加文案。见「追加提示词」一节 |
| 模型 | Provider + 模型名称 + 「测试」 | 输入框带候选（datalist）：目录来自宿主已注册的适配器；目录为空或想用未列出的模型时**直接手填**。「测试」走宿主 `resolveModelInfo` 只做解析校验，不发真实请求、不产生费用 |
| 调用参数 | Temperature、输出 token 上限、超时（毫秒）、**显示思考过程**（P11） | 前三个留空 = 用适配器/组合配置/内置默认；「显示思考过程」默认勾选，取消后宿主不再把模型的思考内容发给浏览器（见「进度与思考过程」） |
| 操作 | 保存 / 恢复默认配置 / 打开插件配置文件 | 「恢复默认配置」先确认，再清空本页**所有**用户设置（含追加提示词与内置覆盖）；「打开插件配置文件」见上节 |

**两层的取值**：**系统提示词**（基底）= 自定义开关 → `cordis.patch.yml` 的 `config.systemPrompt` → 内置默认；
**追加提示词**（附加）= 启用中的那一条，接在基底之后。两者互不覆盖。
设置页保存或菜单切换后**下一次优化即生效**（宿主每次请求现读解析后的配置），不需要重启或刷新。

**持久化**：走 dsh 标准设置通道——宿主 `ctx.settings.register('better-input', schema)`，文档由
`dsh-settings-file` 落在 `$DSH_HOME/settings.yaml`。所以「重启应用 / 刷新页面后配置仍在」是框架保证的：
本插件不自造存储，也不自己拼配置文件。

**校验**：客户端先行预校验（逐字段给中文提示，不合法就连写入都不会发出），宿主再用 schemastery schema
+ 跨字段 `validate` 复核。典型规则：

- 启用了自定义提示词但内容为空 → 拒绝；
- Provider 与模型名称只填了一个 → 拒绝（要么都填，要么都留空用默认）；
- Temperature 不在 0–2、输出上限不在 1–200000、超时不在 1000–600000 ms、非整数 → 拒绝；
- 追加提示词：超过 20 套、某项缺名称/缺正文、id 重复、`activeProfileId` 指向不存在的追加提示词 → 拒绝
  （全空的行不算——那是"刚点新增还没填"，保存时自动丢弃）。

> **宿主拒绝时不会抛错**：`settingsScope.mutate()` 内部在 `!response.ok` 时只 `recover()` 然后正常返回
> （只有装配错误才 reject），所以"保存成功"必须由调用方自己核对镜像里的值是否真的变了。
> 设置页用 `opsApplied()` 做这件事：没生效就报「宿主没有接受这次写入…」并保留用户的编辑，
> 绝不假报"已保存"。两侧的区间常量也保持同值，避免"客户端放行 → 宿主拒绝 → 静默失败"。

**未配置时**：全部字段留空即可——宿主回落到默认模型（`agentDefaultModel.currentSelection()`）与
默认系统提示词，不报错。若部署确实没挂设置提供者，设置页会显示「设置服务不可用」（并附上宿主返回的原因，
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
| `systemPrompt` | 内置（见 `lib/policy.js`） | **默认系统提示词**（基底）；被设置页的自定义系统提示词覆盖。追加提示词不替换它，只接在它之后 |
| `model.provider` / `model.model` | 省略 | 固定模型路由；**必须成对出现**。被设置页覆盖；都没配时用宿主当前默认选择 |
| `presets[].{id,label,prompt}` | `[]` | 预设；请求带 `presetId` 时其 `prompt` 追加到 system。`id`/`label` 会经 `/catalog` 下发到输入框旁的 `▾` 菜单（`prompt` 不下发）。**id 命中内置条目**（`concise`/`spec`）时语义不同：它是那条内置条目的**追加文案的组合层默认值**（被遗留设置字段与设置页覆盖），且不再列进预设区。见「追加提示词」一节 |
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
      // styleIds：**旧客户端兼容**字段（P8 前的多选优化风格），去重后按风格清单顺序拼 system；
      // 新客户端不发它——用哪套系统提示词由设置里的 activeProfileId 决定。

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
  event: delta  data: { text }            // 文本增量（只发 text-delta）
  event: reasoning  data: { text }        // 思考增量（P11；只在生效设置 showReasoning ≠ false 时发）
                                          // 与 delta 同构、1:1 转发；**绝不进 done 的 text 或草稿**
  event: done   data: { text, modelUsed, presetId?, styleIds?, truncated? }
                                          // text 是装配后的权威文本（只由 text 块装配），客户端以它为准
  event: error  data: { error, message }  // 'model-failed' | 'timeout' | 其它请求级错误码

GET  /api/dsh-input-optimizer/catalog
200 { namespace,
      settings: { available, reason?, section },
      providers: [{id,name}],
      limits: { maxInputChars, temperature:{min,max}, maxOutputTokens:{min,max}, timeoutMs:{min,max} },
      presets: [{id,label}],                  // prompt 不下发；客户端不再自己维护规则镜像
      styles: [{id,label,source}],            // 仅为旧客户端保留的兼容面；prompt 同样不下发
      profiles: [{id,name,source,builtIn}],   // 追加提示词清单行（内置条目在前）；正文不下发（profileRowsOf 保证）
      defaults: { systemPrompt },             // 内置/组合层默认系统提示词：有意下发，设置页要"可见"
      configPath,                             // 插件配置文件绝对路径（给「打开配置文件」用）
      effective: { provider, model, temperature, maxOutputTokens, timeoutMs,
                   showReasoning,            // P11：是否透传思考过程（默认 true，只有设置页关掉才 false）
                   profileId,                 // 启用中的追加提示词 id；null = 未启用（不追加）
                   sources: { prompt, model, temperature, limits } } }
                                              // sources.prompt 说的是**基底系统提示词**来自哪一层
                                              // （settings/config/default）；追加条目不改它

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
| **约定守卫**（`scripts/check-guards.mjs`） | 19 条规则，逐条对应真实事故：`ctx.get('logger')`、设置注册一次性读、样式未打 `data-plugin`、保存未自查、并发闸门占位/释放、**闸门占位必须排在会抛的校验之后**、客户端自带宿主区间常量、SSE 分帧与流式回退、风格 id 校验、风格提示词不得下发、**清单行必须由 profileRowsOf 生成**、打开配置文件的路径与准入、新套件没接进 `npm test` | 只认字面写法，不理解语义（所以规则要写"为什么"） |
| **宿主半冒烟**（67 例） | 配置校验、信任判定三分支、六路由全链路、SSE 分帧与断流、注册时机、并发闸门（含**失败后名额必须归还**的回归）、追加提示词（内置种子合成/分层/校验/catalog 行）、旧客户端 styleIds 兼容路径、catalog 不下发提示词正文、打开配置文件的候选链 | 不碰真实 LLM（`ctx.llm.stream` 是替身）；不起真实进程 |
| **浏览器半冒烟**（69 例） | 座位注册、组件契约、接线与 CAS、流式回填（节流/中止/还原/回退）、追加提示词切换菜单（内置条目单选 + 落盘）、菜单关闭手势（点内部不收起）、**设置页紧凑布局**（默认无输入框 / 展开后可用 / 行距与一屏项数 / 旧版式不残留 / 校验失败自动展开）、内置清单行编辑与覆盖、默认系统提示词查看与填入、打开配置文件按钮、撤销栈 | 用**手写 React 替身**：hook 语义是简化的（但 `document` 监听器是真的登记表，否则"点内部不收起"这条测不出来） |
| **真 React 渲染**（6 例） | 用真 `react`/`react-dom` 走 SSR 真渲染路径，并把渲染期 `console.error`（React 的警告通道）当失败 | SSR 不跑 effect、也没有 DOM：拉目录/订阅/点击/菜单开合不在范围 |
| **真框架集成**（5 例） | 真 cordis + 真 `dsh-settings-file`：提供者先到/后到/缺失三种时序、"注册后写得进 `settings.yaml`"，以及**逐风格提示词与追加提示词的全链路**（写入 → 落盘 → 生效来源变 `settings`/`profile` → 下一次请求的 system 真的用它） | 不启真实 webserver、不调真实 LLM（两者都用替身捕获） |
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
