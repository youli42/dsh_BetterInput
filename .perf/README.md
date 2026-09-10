# Web 启动耗时排查（P6.4）

结论先说：**本插件不是 Web 启动变慢的原因，也没有引入阻塞。**
`dsh web` 的冷启动耗时由宿主的插件树主导（约 1.8 s），本插件的边际成本是 **~5 ms**，
落在同一台机器重复测量的噪声范围内（实测单轮极差就有 ±100 ms）。

下面是可复现的方法与原始数据。

## 测量方法

测的是「进程起到打印监听地址」的**墙钟时间**，即

```powershell
node <dsh>/lib/bin.js --profile web --port 0 --no-open
```

`--port 0` 让 OS 挑一个空闲端口（**不会顶掉正在跑的 3080**），`--no-open` 不弹浏览器。
子进程用 `stdio: ['ignore', fd, fd]` 重定向到文件后再轮询——受限沙箱下 Node 不能用默认的
`stdio: 'pipe'` 抓子进程输出（EPERM），而且轮询文件能精确判定"第一次出现 URL"这一刻。

> 注意启动参数顺序：**launcher 自己的 flag 必须排在前面**。`dsh web --port 0 --patch x.yml`
> 会把 `--patch` 透传给内层 app 并报 `unknown option`；要写
> `--profile web --patch x.yml --port 0 --no-open`。

```powershell
node .perf/measure-startup.mjs 12                              # 基线：插件启用
node .perf/measure-startup.mjs 12 --patch .perf/disable-better-input.yml   # 对照：插件禁用
node .perf/ab-startup.mjs 5                                    # 交替 A/B（消系统抖动）
node .perf/verify-open-config.mjs                              # 「打开配置文件」真机验收（会真的打开文件）
```

## 测量结果（2026-09-10，Windows / Node 24.16.0）

### 1. 基线：插件启用，12 轮冷启动

| | 值 |
|---|---|
| min | 1730 ms |
| **median** | **1886 ms** |
| max | 1947 ms |

### 2. 交替 A/B：插件启用 vs 插件禁用（各 5 轮，同一次运行里交替）

| 轮次 | 启用 | 禁用 | 差 |
|---|---|---|---|
| 1 | 1910 | 1857 | +53 |
| 2 | 1765 | 1783 | −18 |
| 3 | 1793 | 1788 | +5 |
| 4 | 1824 | 1786 | +38 |
| 5 | 1777 | 1790 | −13 |
| **median** | **1793** | **1788** | **+5** |

差值在 −18 ~ +53 ms 之间来回变号，**说明它测的是抖动而不是插件的成本**。
按中位数算，插件的边际启动成本 ≈ **5 ms**，占 ~1.8 s 的 0.3%。

### 3. 阶段归因

| 阶段 | 耗时 | 说明 |
|---|---|---|
| 进程启动 + profile 组合（读各 bundle 的 patch、解析包、重写 `cordis.yml`） | **~85 ms** | `dsh --profile web --dump-config`，4.6% |
| 其余（所有插件模块导入 + cordis 树挂载 + 监听） | **~1700 ms** | 95%，宿主插件树本身的开销（profile 里挂着 `dsh-base` + `dsh-web-app` + 两个第三方 bundle） |

### 4. 阻塞排查（代码级）

沿着"插件在启动期会执行什么"逐项核对，结论是**没有阻塞**：

- `apply()` 完全同步，且只做：`resolveConfig` → `bindSettings` → `createGate` → 5+1 条路由注册。
  没有同步 I/O、没有 `await` 网络、没有循环等待。
- 唯一的 `await`（`readJsonObject` / `ctx.llm.stream` / `llm.listModels` / `resolveModelInfo`）
  全都在**请求处理器内部**，启动期不会走到。
- `lib/settings.js` 的命名空间注册走 `ctx.inject(['settings'], cb)`——服务就绪才执行，
  **不阻塞** `apply()` 返回（这正是 P5.1b 事故的修法，见 DESIGN R-20）。
- `lib/**` 里没有任何 `readFileSync`/`execSync`/`spawnSync`/`Atomics.wait`/忙等
  （`grep` 验证，守卫也在盯）。

### 5. 一次未复现的异常观测（如实记录）

12 轮序列之前的另一批测量里出现过**一次 29.7 s** 的启动。随后 12 轮 + 10 轮 A/B
共 22 次冷启动**都没有复现**（全部落在 1730–1947 ms）。

那一轮的前后正是"新建 `.perf` 文件 + 连续起停 node"的时刻，最像是环境侧的一次性停顿
（杀进程后的句柄回收 / 实时防护扫描新文件）。**无法归因于本插件**，但也**没有证据说它
一定与插件无关**——要坐实它，需要在慢启动现场抓 `--cpu-prof` 或 ETW，本轮没做到。
如果这个现象在真实使用中再次出现，按下面的顺序抓证据：

1. 用 `.perf/measure-startup.mjs` 连续跑 12 轮，`>= 3000 ms` 的那几轮日志会保留在 `.perf/logs/`；
2. 同时用「任务管理器 → 性能 → 资源监视器」看那一刻是磁盘还是网络在等；
3. 若怀疑某个 bundle，用 `--patch` 逐层关掉对照（`.perf/disable-better-input.yml` 是模板）。

## 复现须知

- `--port 0` 才是安全的：**不要**用 3080 去测，那会和正在使用的 GUI 抢端口。
- 测完的实例由脚本 `SIGKILL` 掉；脚本不会碰 profile 目录以外的任何东西
  （`cordis.yml` 会被正常启动流程重写成固定的空内容，这是每次启动本来就会做的）。
- 慢过 `SLOW_MS`（默认 3 s）的轮次会保留日志到 `.perf/logs/`，其余轮次自动删除。
