/**
 * 交替 A/B 基准：在同一次运行里交替启动「插件启用」与「插件禁用（--patch 覆盖层）」两种配置，
 * 以消掉系统抖动/缓存漂移带来的偏差。每一轮都重新冷启动 `dsh web`，测量
 * 「进程起到打印监听地址」的墙钟时间。
 *
 * 用法：node .perf/ab-startup.mjs [每侧轮数] [禁用用的 patch 文件]
 */

import { spawn } from 'node:child_process'
import { mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const DSH_BIN = 'C:\\Users\\wangyilin20\\AppData\\Local\\nvm\\v24.16.0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'

const argv = process.argv.slice(2)
const perSide = Number(argv[0] ?? '5')
const patchPath = argv[1] ?? join(here, 'disable-better-input.yml')

const logDir = join(here, 'logs')
mkdirSync(logDir, { recursive: true })

/**
 * 冷启动一次 `dsh web`，等到它打印监听地址。
 * @param {string} tag - 日志文件名前缀。
 * @param {boolean} withPatch - 是否带上禁用用的覆盖层。
 * @returns {Promise<{ ms: number, failed: boolean }>} 本次耗时。
 */
function bootOnce(tag, withPatch) {
  const logPath = join(logDir, `${tag}.log`)
  writeFileSync(logPath, '')
  const fd = openSync(logPath, 'w')
  const args = [DSH_BIN, '--profile', 'web']
  if (withPatch) args.push('--patch', patchPath)
  args.push('--port', '0', '--no-open')
  const started = Date.now()
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', fd, fd],
    env: { ...process.env, DSH_SESSION_ID: '', DSH_SESSION_JSONL: '', DSH_SHELL: '', DSH_WEB_URL: '' },
    cwd: repoRoot,
  })
  return new Promise((resolvePromise) => {
    /**
     * 轮询日志找监听地址（或提前退出）。
     * @returns {void}
     */
    const poll = () => {
      let text = ''
      try {
        text = readFileSync(logPath, 'utf8')
      } catch {
        text = ''
      }
      if (/http:\/\/127\.0\.0\.1:\d+/.test(text)) {
        const ms = Date.now() - started
        child.kill('SIGKILL')
        closeSync(fd)
        resolvePromise({ ms, failed: false })
        return
      }
      if (child.exitCode !== null) {
        closeSync(fd)
        resolvePromise({ ms: Date.now() - started, failed: true })
        return
      }
      setTimeout(poll, 20)
    }
    poll()
  })
}

/** 中位数（偶数个取偏下的那个，与 measure-startup 保持一致）。 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const on = []
const off = []
for (let i = 1; i <= perSide; i += 1) {
  const a = await bootOnce(`ab-on-${String(i)}`, false)
  const b = await bootOnce(`ab-off-${String(i)}`, true)
  on.push(a.ms)
  off.push(b.ms)
  console.log(
    `round ${String(i)}: enabled=${String(a.ms)}ms  disabled=${String(b.ms)}ms  delta=${String(a.ms - b.ms)}ms`
    + `${a.failed || b.failed ? '  (有失败轮次)' : ''}`,
  )
  await new Promise(resolveTimer => setTimeout(resolveTimer, 1200))
}

console.log('\n=== 汇总 ===')
console.log(`enabled : min=${String(Math.min(...on))} median=${String(median(on))} max=${String(Math.max(...on))}`)
console.log(`disabled: min=${String(Math.min(...off))} median=${String(median(off))} max=${String(Math.max(...off))}`)
console.log(`插件边际启动成本（median 差）: ${String(median(on) - median(off))} ms`)

for (let i = 1; i <= perSide; i += 1) {
  rmSync(join(logDir, `ab-on-${String(i)}.log`), { force: true })
  rmSync(join(logDir, `ab-off-${String(i)}.log`), { force: true })
}
