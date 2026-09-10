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
| P5 | 流式回填、芯片保留、预设菜单、vitest 化 | ⬜ 待做 |

单测：宿主半 29 例 + 浏览器半 32 例，全绿。

> 本机安装记录（2026-09-10，即下面的方式 A）：`dsh plugin --profile web add link:D:\SSDWP\AI\dsh\BetterInput`，
> 并把 `"dsh-better-input"` 加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`。

## 目录结构

```
package.json          双半声明：main(lib/index.js) + exports["./client"] + dsh.client/bundle
cordis.patch.yml      bundle patch + 组合层配置（设置页的用户值优先于它）
lib/index.js          宿主半：4 条路由 + LLM 一次性调用
lib/settings.js       宿主半：设置命名空间 schema 与跨字段校验
lib/policy.js         策略层：零依赖，配置校验/信任围栏/生效配置解析（可独立单测）
lib/client.js         浏览器半：输入框按钮 + 撤销栈 + 设置页（手写 __ModuleLoader__ bundle，无需构建）
lib/types/*.d.ts      对外类型
test/smoke.mjs        宿主半冒烟测试（29 例）
test/client.smoke.mjs 浏览器半冒烟测试（32 例：含 P2 接线、P3 撤销栈、P4 设置页）
DESIGN.md             设计依据：座位/接口证据、撤销方案、提示词分层、风险清单
LICENSE               MIT
```

## 安装

前置：`dsh` 0.1.2-rc.1+，profile 为 `web`（即 `~/.dsh/profiles/web`）。

**第 1 步（两种方式都要做）**：把本包装进 profile，让包名能被解析到：

```powershell
dsh plugin --profile web add link:D:\SSDWP\AI\dsh\BetterInput
```

> ⚠️ Windows 上**不要**在 patch 里写绝对路径当插件名：Loader 对非 `.`/非 `cordis:` 的
> specifier 直接交给 `import(name)`，`D:\...` 会被当成 URL scheme `d:` 解析而失败；
> 以 `.` 开头的相对 specifier 又是相对 **profile 目录**（在 C: 盘）解析的，跨盘也无解。
> 所以唯一可靠的方式是「装进 profile 的 node_modules，再用包名引用」。

### 方式 A：bundle（与已上架的第三方插件一致）

在第 1 步之后，于 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里追加一行：

```json
"dsh-better-input"
```

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

1. **P0**：刷新 `http://127.0.0.1:3080`，输入框工具行右侧、模型选择器紧左边出现 ✨ 按钮（`data-dsh-better-input="better-input"`，可用 DevTools 搜到）。空输入时按钮为禁用态。
2. **P1**：路由挂上后宿主日志会打印 `better-input: mounted /api/dsh-input-optimizer/optimize`。直接打路由：

```powershell
curl.exe -s -X POST http://127.0.0.1:3080/api/dsh-input-optimizer/optimize `
  -H 'content-type: application/json' `
  -d '{"text":"帮我把那个脚本弄一下，快点"}'
# → {"text":"...优化后的提示词...","modelUsed":{"provider":"...","model":"..."}}
```

  非本机来源（远程 IP / 异源 Host / `Sec-Fetch-Site: cross-site`）一律 `403`。
3. **单测**：

```powershell
node test\smoke.mjs          # 宿主半 29 例：生效配置、围栏、四路由全链路（含超时/截断/错误码/目录/试调）
node test\client.smoke.mjs   # 浏览器半 32 例：座位注册、组件契约、P2 接线、P3 撤销栈、P4 设置页
```

> 宿主半测试需要 `@deepseek-ai/dsh-llm` 可见。装进 profile 后天然可见；在本目录直接跑测试时，
> 可建一个开发用软链（**不要提交**）：
> ```powershell
> New-Item -ItemType Directory -Force node_modules\@deepseek-ai | Out-Null
> New-Item -ItemType Junction node_modules\@deepseek-ai\dsh-llm `
>   -Target "$env:LOCALAPPDATA\nvm\v24.18.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-llm"
> ```

## 行为说明（已实现）

| 场景 | 行为 |
|---|---|
| 点击 ✨ | `POST /api/dsh-input-optimizer/optimize`（body `{ text, sessionId }`），成功后 `setDraft` 写回 |
| 生成中再点 | **取消**（abort；宿主侧同时取消上游模型调用，不产生费用累积） |
| 生成中用户继续打字 | 返回时 CAS（`draftRev` + 文本双比对）失败 → **丢弃结果**，提示「草稿已变化」 |
| 成功后 | 出现 ↶ 撤销按钮；提示 3 秒后自动消失 |
| 撤销 | CAS 通过才回退到优化前草稿；草稿被手改过时第一次点击只警告，**再点一次强制还原** |
| 撤销深度 | 每会话 10 层，可连按逐层回退；按会话隔离 |
| 草稿含 `@引用`/`/命令` 芯片 | 拒绝发起（整体 `setDraft` 会把芯片拉平成纯文本），提示先删掉芯片 |
| 输入机非空闲（提交/裁决中） | 按钮禁用 |
| 宿主报错 | 直接展示宿主返回的 `message`（如「草稿 9001 字，超过上限 8000 字」）；403/404 有专门文案 |

> **版本适配（真机踩坑记录）**：已安装的 dsh 0.1.2-rc.1 对 `conversation.input.left/right` 调的是
> `renderSlot(name, {})`，**没有 owner props**——所以本插件一律通过框架注入的 `useInput` 读输入状态，
> 不读 `props.input`（新版本源码才把 `InputZone` 传给这两个座位）。`sessionId` 来自 `ui-session` 的
> kit 合并，缺包时回落到全局单栈（有 CAS 兜底）。详见 `DESIGN.md` 的 R-3 / R-13。

提示文本用 GUI 的设计令牌上色（`--dsw-alias-state-{success,warn,error}-primary`），令牌缺失时回落 `currentColor`。

## 设置页（设置 → 输入优化）

设置面板左侧导航里多一项「输入优化」，用来配置这个按钮**用哪个模型、哪段提示词**。

| 区域 | 能配什么 | 说明 |
|---|---|---|
| 提示词 | 「使用自定义提示词」开关 + 提示词正文 | 开关关闭时用插件配置的 `systemPrompt`，再往下才是内置文案 |
| 模型 | Provider + 模型名称 | 两个输入框都带候选（datalist）：目录来自宿主已注册的适配器；目录为空或想用未列出的模型时**直接手填**。旁边有「测试」按钮，走宿主 `resolveModelInfo` 只做解析校验，不发真实请求、不产生费用 |
| 调用参数 | Temperature、输出 token 上限、超时（毫秒） | 留空 = 用适配器/组合配置/内置默认 |
| 操作 | 保存 / 测试 / 恢复默认 | 「恢复默认」清空本页所有用户设置，回到内置默认与组合配置 |

**生效优先级**：内置默认 ← `cordis.patch.yml` 的 `config`（组合层）← 设置页（用户层）。
设置页保存后**下一次优化即生效**（宿主每次请求现读解析后的配置），不需要重启或刷新。

**持久化**：走 dsh 标准设置通道——宿主 `ctx.settings.register('better-input', schema)`，文档由
`dsh-settings-file` 落在 `$DSH_HOME/settings.yaml`。所以「重启应用 / 刷新页面后配置仍在」是框架保证的：
本插件不自造存储，也不自己拼配置文件。

**校验**：客户端先行预校验（逐字段给中文提示，不合法就连写入都不会发出），宿主再用 schemastery schema
+ 跨字段 `validate` 复核；宿主的拒绝消息会原样展示在保存按钮旁。典型规则：

- 启用了自定义提示词但内容为空 → 拒绝；
- Provider 与模型名称只填了一个 → 拒绝（要么都填，要么都留空用默认）；
- Temperature 不在 0–2、输出上限 < 1、超时 < 1000 ms、非整数 → 拒绝。

**未配置时**：全部字段留空即可——宿主回落到默认模型（`agentDefaultModel.currentSelection()`）与
默认提示词，不报错。若部署没挂设置提供者，设置页会显示「设置服务不可用」，而优化按钮照常工作。

## 配置参考（`cordis.patch.yml` 的 `config:`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时不挂路由 |
| `systemPrompt` | 内置（见 `lib/policy.js`） | **默认**提示词；设置页启用自定义提示词时被覆盖 |
| `model.provider` / `model.model` | 省略 | 固定模型路由；**必须成对出现**。被设置页覆盖；都没配时用宿主当前默认选择 |
| `presets[].{id,label,prompt}` | `[]` | 预设；请求带 `presetId` 时其 `prompt` 追加到 system |
| `maxInputChars` | `8000` | 输入字数上限（超限 400） |
| `maxOutputTokens` | `1024` | 输出 token 上限（截断仍返回文本并标 `truncated: true`） |
| `timeoutMs` | `30000` | 单次调用超时（超时 504） |
| `temperature` | 不传 | 采样温度（缺省交给适配器决定） |

未知字段名或类型错误会让**启动失败并报出字段名**（fail loud，避免「拼错字段却以为生效了」）。
这项配置是**组合层**：设置页里的用户值优先于它，改它需要重启 `dsh web`（`patchReload: live` 会重载 patch，但插件自身的 Node 代码不热重载）。

## HTTP 契约

配置的**读写不走这些路由**（走标准设置通道），这里是能力路由与设置页的只读支撑路由：

```
POST /api/dsh-input-optimizer/optimize
body: { text: string, sessionId?: string, presetId?: string }

200 { text, modelUsed: { provider, model }, presetId?, truncated? }
400 { error: 'bad-request' | 'empty-text' | 'text-too-long' | 'unknown-preset', message }
403 { error: 'forbidden' }
405 { error: 'method-not-allowed' }
413 { error: 'body-too-large' }
502 { error: 'no-model-route' | 'model-failed', message }
504 { error: 'timeout' }

GET  /api/dsh-input-optimizer/catalog
200 { namespace, settings: { available, section }, providers: [{id,name}],
      effective: { provider, model, temperature, maxOutputTokens, timeoutMs,
                   sources: { prompt, model, temperature, limits } } }

GET  /api/dsh-input-optimizer/catalog/models?provider=<id>
200 { provider, models: [{id,name}] }        // 适配器没有目录时 models 为空数组，不是错误
400 { error: 'missing-provider', message }

POST /api/dsh-input-optimizer/check
body: { provider: string, model: string }
200 { ok: true, provider, model, name, context?, defaultMaxTokens? }
200 { ok: false, provider, model, message }  // 解析不了的原因（不发真实请求、不计费）
400 { error: 'missing-model', message }
```

安全：三条路由与能力路由共用同一套信任围栏——只服务本机浏览器（socket 属于 `127/8`/`::1`/`::ffff:127/8`
**且** Host 头是本机名 **且** 无跨站标记；永不信任 `X-Forwarded-For`）。请求体上限 256 KiB，
调用超时与客户端断开都会取消上游。

## 开发循环

- **浏览器半**：`dsh-client-hmr` 每 500ms stat-poll `lib/client.js`（比对 mtime+size），保存即被热替换进运行中的页面（约 0.5s，无需刷新）。所以逻辑尽量放浏览器半。
  - 代价：插件内 React state 会丢（P3 的撤销栈因此放模块级 Map，而非组件 state）。
- **宿主半**：改 `lib/index.js` / `lib/policy.js` 需要重启 `dsh web`。
- 每次改完先跑两个 smoke 测试，再动 GUI。

## 下一步（P5）

- **预设菜单**：宿主侧 `presets` 已生效（请求带 `presetId` 即在 system 后追加该预设的 prompt），缺的是把预设列表下发到设置页/输入框旁的菜单（客户端读不到插件配置，见 `DESIGN.md` R-10，所以要么走 `catalog` 路由带出来，要么把预设也纳入设置命名空间）。
- **流式回填**：把 `POST /optimize` 改成分块/SSE，边生成边显示。
- **芯片保留**：草稿含 `@引用`/`/命令` 时目前直接拒绝（整体 `setDraft` 会拉平芯片），后续可研究用 `insertReference` 重建。
- **测试迁移**：两个 smoke 套件迁到 vitest（参照 `packages/client/*/tests/*.client.spec.tsx` 的写法）。
