# dsh-better-input

DSH Web GUI 插件：在**模型选择器左侧**加一个「AI 优化输入」按钮，点击后用可自定义的提示词优化输入框里的内容，并把结果写回输入框（撤销见路线图 P3）。

设计依据、座位/接口证据与分阶段计划见 [`DESIGN.md`](./DESIGN.md)。

## 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 骨架：座位注册 + 按钮出现在模型左侧 | ✅ 已实现，并已在 Web GUI 目视确认（2026-09-10） |
| P1 | 宿主半：`/api/dsh-input-optimizer/optimize` + `ctx.llm.stream()` 一次性调用 | ✅ 已实现（16 个单测绿；curl 待确认） |
| P2 | 前后端接线：读草稿 → POST → `setDraft` + 失败提示 | ⬜ 待做（接线点已在 `lib/client.js` 标注） |
| P3 | 撤销栈 + CAS 校验 + 撤销按钮 | ⬜ 待做 |
| P4 | 预设菜单 UI / settings 命名空间 | ⬜ 待做（宿主侧 `presets` 已可用） |
| P5 | 芯片策略、i18n 打磨、并发/取消 | ⬜ 待做 |

> 本机安装记录（2026-09-10，即下面的方式 A）：`dsh plugin --profile web add link:D:\SSDWP\AI\dsh\BetterInput`，
> 并把 `"dsh-better-input"` 加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`。

## 目录结构

```
package.json          双半声明：main(lib/index.js) + exports["./client"] + dsh.client/bundle
cordis.patch.yml      bundle patch：把自己 insert 进 profile 插件树（唯一配置入口）
lib/index.js          宿主半：路由 + LLM 调用（import @deepseek-ai/dsh-llm）
lib/policy.js         策略层：零依赖，配置校验/信任围栏/提示词拼装（可独立单测）
lib/client.js         浏览器半：座位注册 + 按钮组件（window.__ModuleLoader__ 工厂，手写无需构建）
lib/types/*.d.ts      对外类型
test/smoke.mjs        宿主半冒烟测试（16 例）
test/client.smoke.mjs 浏览器半冒烟测试（8 例）
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
node test\smoke.mjs          # 宿主半：配置、围栏、路由全链路（含超时/截断/错误码）
node test\client.smoke.mjs   # 浏览器半：bundle id、座位注册参数、组件契约
```

> 宿主半测试需要 `@deepseek-ai/dsh-llm` 可见。装进 profile 后天然可见；在本目录直接跑测试时，
> 可建一个开发用软链（**不要提交**）：
> ```powershell
> New-Item -ItemType Directory -Force node_modules\@deepseek-ai | Out-Null
> New-Item -ItemType Junction node_modules\@deepseek-ai\dsh-llm `
>   -Target "$env:LOCALAPPDATA\nvm\v24.18.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-llm"
> ```

## 配置参考（`cordis.patch.yml` 的 `config:`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时不挂路由 |
| `systemPrompt` | 内置（见 `lib/policy.js`） | 优化用的 system prompt |
| `model.provider` / `model.model` | 省略 | 固定模型路由；**必须成对出现**。省略则用宿主当前默认选择（`agentDefaultModel.currentSelection()`） |
| `presets[].{id,label,prompt}` | `[]` | 预设；调用方用 `presetId` 选择，其 `prompt` 追加到 system |
| `maxInputChars` | `8000` | 输入字数上限（超限 400） |
| `maxOutputTokens` | `1024` | 输出 token 上限（截断仍返回文本并标 `truncated: true`） |
| `timeoutMs` | `30000` | 单次调用超时（超时 504） |

未知字段名或类型错误会让**启动失败并报出字段名**（fail loud，避免「拼错字段却以为生效了」）。改完 `cordis.patch.yml` 需要重启 `dsh web`（`patchReload: live` 会重载 patch，但插件自身的 Node 代码不热重载）。

## HTTP 契约

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
```

安全：只服务本机浏览器（socket 属于 `127/8`/`::1`/`::ffff:127/8` **且** Host 头是本机名 **且** 无跨站标记；永不信任 `X-Forwarded-For`）。请求体上限 256 KiB，调用超时与客户端断开都会取消上游。

## 开发循环

- **浏览器半**：`dsh-client-hmr` 每 500ms stat-poll `lib/client.js`（比对 mtime+size），保存即被热替换进运行中的页面（约 0.5s，无需刷新）。所以逻辑尽量放浏览器半。
  - 代价：插件内 React state 会丢（P3 的撤销栈因此放模块级 Map，而非组件 state）。
- **宿主半**：改 `lib/index.js` / `lib/policy.js` 需要重启 `dsh web`。
- 每次改完先跑两个 smoke 测试，再动 GUI。

## 下一步（P2 接线点）

`lib/client.js` 的 `onClick` 里已标注 P2 的代码形状：

```js
const res = await fetch(ROUTE, { method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: draft, sessionId: props.sessionId }) })
const data = await res.json()
if (res.ok) props.inputActions.setDraft(data.text)
```

必须同时做的两件事（见 `DESIGN.md` §3.3/§3.4）：
1. **CAS**：发起前记下 `input.draftRev` 与草稿原文，返回时若草稿已被改动就丢弃结果，不要覆盖用户输入；
2. **撤销**：替换成功才压栈（`{ before, after, rev }`），撤销时同样做 CAS 校验。

另：草稿含芯片（`input.occurrences.length > 0`，即 `@引用`/`/命令`）时默认应拒绝——整体 `setDraft` 会把芯片拉平成纯文本。
