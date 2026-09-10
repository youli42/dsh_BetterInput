/**
 * 约定守卫：把"已经踩过的坑"变成可自动检查的规则。
 *
 * 为什么需要它（而不是只靠类型/单测）：最近两轮的缺陷大多不是逻辑写错，而是**契约误判**——
 * 用错服务、把框架的静默行为当成成功、两端各写一份会漂移的常量。这类问题单测很难覆盖
 * （替身太宽松就会漏），而它们又都能用"源码里不许出现某个写法"精确表达。
 *
 * 每条规则都写明了它防的是哪一次事故。新增规则时请照这个格式补一行"为什么"。
 *
 * 运行：node scripts/check-guards.mjs （`npm test` 会先跑它）
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 读一个仓库内文件。
 * @param {string} relative - 相对仓库根的路径。
 * @returns {string} 文件内容。
 */
function read(relative) {
  return readFileSync(join(repoRoot, relative), 'utf8')
}

/**
 * 去掉注释与字符串字面量，避免"注释里提到过"造成误报。
 * @param {string} source - 源码。
 * @returns {string} 只剩代码骨架的文本。
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/** 检查项：每条都是"某个文件里不许/必须出现某个写法"（可选 `after` 约束先后顺序）。 */
const checks = [
  {
    why: 'ctx.get("logger") 恒为 undefined（logger 是 root context 的自有属性，不是 reflect 服务），'
      + '用错会让所有宿主日志静默丢失——2026-09-11 事故',
    file: 'lib/index.js',
    forbid: /ctx\.get\??\.\(\s*'logger'\s*\)/,
    must: /ctx\.logger/,
  },
  {
    why: '设置命名空间注册必须是 ctx.inject(["settings"], …)：ctx.get 是 strict，对"已 provide '
      + '但未 ACTIVE"的服务返回 undefined，一次性读输掉竞态就永久降级（设置页恒显示不可用）',
    file: 'lib/settings.js',
    forbid: /ctx\.get\??\.\(\s*'settings'\s*\)/,
    must: /ctx\.inject\(\s*\[\s*'settings'\s*\]/,
  },
  {
    why: '样式表必须自带 data-plugin/data-plugin-css：框架在物化期认领未打标的 <style>，'
      + '不打标会被别的插件抢走、随其 HMR 重载一起删除',
    file: 'lib/client.js',
    must: /dataset\.plugin\s*=/,
  },
  {
    why: '设置页保存必须写后自查（mutate 在宿主拒绝时不 reject）：否则会假报"已保存"',
    file: 'lib/client.js',
    must: /opsApplied\(/,
  },
  {
    why: '并发闸门必须占位并释放：被拒的请求不能触达模型，成功/失败/超时/取消都要归还名额',
    file: 'lib/index.js',
    must: /gate\.acquire\(/,
  },
  {
    why: '并发闸门的释放写在 finally 里（漏了会让插件在几次取消之后"锁死"）',
    file: 'lib/index.js',
    must: /slot\?\.release\?\.\(\)/,
  },
  {
    why: '流式路由必须按 SSE 协议分帧并挂上（客户端默认走它；少了 openEventStream 就不是流式，'
      + '少了 ROUTE_STREAM 客户端会一直回退——功能悄悄降级没人发现）',
    file: 'lib/index.js',
    must: /openEventStream\(/,
  },
  {
    why: '流式路由必须注册进路由表',
    file: 'lib/index.js',
    must: /ROUTE_STREAM/,
  },
  {
    why: '流式不可用时客户端必须能回退到一次性 JSON：流式是增强，不能变成新的失败面',
    file: 'lib/client.js',
    must: /unavailable: true/,
  },
  {
    why: '闸门的占位必须排在"会抛的校验"之后：占位后抛错（未知预设 400 / 没有模型路由 502）'
      + '会让名额随调用栈丢失，该会话之后恒 409、累计满额后全局恒 429，只能重启宿主——'
      + 'f4b190e 把 acquire 移进 prepareCall 时引入过这个回归',
    file: 'lib/index.js',
    must: /const slot = gate\.acquire\(sessionId\)/,
    after: [/const system = systemPromptFor\(/, /const route = resolveRoute\(/],
  },
  {
    why: '多选风格的 id 校验必须在宿主侧做（未知 id 静默忽略会让用户以为风格生效了）',
    file: 'lib/index.js',
    must: /parseStyleIds\(/,
  },
  {
    why: '风格提示词正文绝不能下发到浏览器：`/catalog` 只能给 id/label/source（与 presets 同规矩）',
    file: 'lib/index.js',
    forbid: /styles:\s*effective\.styles\s*[,}]/,
    must: /styles: effective\.styles\.map\(/,
  },
  {
    why: '「打开配置文件」的路径必须由宿主按自己的模块位置解析，且文件名取自与 dsh.bundle.patch '
      + '同源的常量（profile 布局随 link:/正式安装而变，前端拼不出来）',
    file: 'lib/index.js',
    must: /PLUGIN_CONFIG_FILENAME/,
  },
  {
    why: '打开配置文件是能力路由（会在宿主上起进程）：必须要求浏览器会话，不能靠本机任意进程触发',
    file: 'lib/index.js',
    must: /openConfigPayload\(\)[\s\S]{0,200}?session: true/,
  },
  {
    why: '打开配置文件必须真的挂进路由表（写了实现却没注册 = 按钮永远 404）',
    file: 'lib/index.js',
    must: /path: ROUTE_OPEN_CONFIG/,
  },
  {
    why: '客户端必须把勾选的风格发出去（勾了却只发默认提示词 = 功能静默失效）',
    file: 'lib/client.js',
    must: /styleIds,/,
  },
]

/** 客户端不许出现"与宿主同值"的区间字面量（只允许兜底常量里出现）。 */
const mirroredLimits = (() => {
  const source = read('lib/client.js')
  // 兜底块本身是允许的（宿主不可达时的最后手段）——先把它整段挖掉再查。
  const withoutFallback = source.replace(/const LIMITS_FALLBACK = Object\.freeze\(\{[\s\S]*?\}\)/, ' ')
  const code = codeOnly(withoutFallback)
  const hits = [...code.matchAll(/(?<![\w.])(200000|600000)(?![\w])/g)].map(match => match[0])
  return { hits, why: '客户端不得自带与宿主同值的区间上界（漂移会导致"客户端放行 → 宿主拒绝 → 静默失败"）' }
})()

/** 每个 test/*.mjs 都必须被 npm test 串起来（避免新增套件忘了接进去）。 */
const wiredSuites = (() => {
  const pkg = JSON.parse(read('package.json'))
  const script = pkg.scripts?.test ?? ''
  const suites = readdirSync(join(repoRoot, 'test')).filter(name => name.endsWith('.mjs'))
  return { missing: suites.filter(name => !script.includes(name)), suites }
})()

const failures = []

for (const check of checks) {
  const source = read(check.file)
  if (check.forbid?.test(source) === true) {
    failures.push(`${check.file} 出现了被禁止的写法（${String(check.forbid)}）：${check.why}`)
  }
  if (check.must !== undefined && !check.must.test(source)) {
    failures.push(`${check.file} 缺少必需的写法（${String(check.must)}）：${check.why}`)
  }
  // 顺序断言：`after` 里的每个写法都必须出现在 `must` **之前**。
  // 只查"存在"是不够的——闸门泄漏那次的写法每一句都还在，错的只是先后。
  if (check.must !== undefined && check.after !== undefined) {
    const at = source.search(check.must)
    if (at >= 0) {
      for (const earlier of check.after) {
        const before = source.search(earlier)
        if (before < 0 || before > at) {
          failures.push(
            `${check.file} 里 ${String(earlier)} 必须排在 ${String(check.must)} 之前`
              + `（现在 ${before < 0 ? '根本没出现' : '排在后面'}）：${check.why}`,
          )
        }
      }
    }
  }
}

if (mirroredLimits.hits.length > 0) {
  failures.push(`lib/client.js 里出现了宿主区间字面量 ${mirroredLimits.hits.join(', ')}：${mirroredLimits.why}`)
}

if (wiredSuites.missing.length > 0) {
  failures.push(`这些测试套件没有被 npm test 串起来：${wiredSuites.missing.join(', ')}`)
}

if (failures.length > 0) {
  console.error(`约定守卫：${String(failures.length)} 条不通过`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`约定守卫：${String(checks.length + 2)} 条规则全部通过`)
