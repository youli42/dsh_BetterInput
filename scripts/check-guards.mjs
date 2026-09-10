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

/** 检查项：每条都是"某个文件里不许/必须出现某个写法"。 */
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
