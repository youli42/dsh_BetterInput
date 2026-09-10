/**
 * Web 启动耗时基准：在同一个进程里反复冷启动 `dsh web`，测「进程起到开始监听」的墙钟时间。
 *
 * 为什么用文件重定向而不是管道：受限沙箱下 Node 无法用默认的 `stdio:'pipe'` 抓子进程输出
 * （会 EPERM），而打开文件 fd 不受影响。
 *
 * 用法：
 *   node .perf/measure-startup.mjs [轮数] [--patch <yml>]
 */

import { spawn } from 'node:child_process'
import { openSync, closeSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const DSH_BIN = 'C:\\Users\\wangyilin20\\AppData\\Local\\nvm\\v24.16.0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'

const argv = process.argv.slice(2)
const rounds = Number(argv[0] ?? '3')
const patchIndex = argv.indexOf('--patch')
const patch = patchIndex >= 0 ? argv[patchIndex + 1] : undefined

const logDir = join(here, 'logs')
mkdirSync(logDir, { recursive: true })

/** 超过这个耗时就认为是"慢启动"，保留日志便于归因。 */
const SLOW_MS = 3000

/**
 * 起一次 web 并等到它打印监听地址。
 * @param {number} index - 轮次序号（用于日志文件名）。
 * @returns {Promise<{ ms: number, url: string | null, failed: boolean }>} 本次耗时。
 */
function measureOnce(index) {
  const logPath = join(logDir, `boot-${String(index)}.log`)
  const fd = openSync(logPath, 'w')
  const args = [DSH_BIN, '--profile', 'web']
  if (patch !== undefined) args.push('--patch', patch)
  args.push('--port', '0', '--no-open')
  const started = Date.now()
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', fd, fd],
    // 清掉会话相关变量：避免子进程挂到当前会话上。
    env: { ...process.env, DSH_SESSION_ID: '', DSH_SESSION_JSONL: '', DSH_SHELL: '', DSH_WEB_URL: '' },
    cwd: repoRoot,
  })
  return new Promise((resolvePromise) => {
    /**
     * 轮询日志文件找监听地址；同时也盯进程提前退出（启动失败）。
     * @returns {void}
     */
    const poll = () => {
      let text = ''
      try {
        text = readFileSync(logPath, 'utf8')
      } catch {
        text = ''
      }
      const match = /http:\/\/127\.0\.0\.1:\d+\/\S*/.exec(text)
      if (match !== null) {
        const ms = Date.now() - started
        child.kill('SIGKILL')
        closeSync(fd)
        resolvePromise({ ms, url: match[0], failed: false })
        return
      }
      if (child.exitCode !== null) {
        const ms = Date.now() - started
        closeSync(fd)
        let tail = ''
        try {
          tail = readFileSync(logPath, 'utf8').slice(0, 1200)
        } catch {
          tail = '(no log)'
        }
        console.log(`--- boot-${String(index)}.log ---\n${tail}\n---`)
        resolvePromise({ ms, url: null, failed: true })
        return
      }
      setTimeout(poll, 25)
    }
    poll()
  })
}

const results = []
for (let i = 1; i <= rounds; i += 1) {
  const result = await measureOnce(i)
  results.push(result)
  console.log(
    `run ${String(i)}: ${result.ms} ms${result.failed ? '  (FAILED — 见 logs)' : ''}`,
  )
  await new Promise(resolveTimer => setTimeout(resolveTimer, 1500))
}
const ok = results.filter(result => !result.failed).map(result => result.ms).sort((a, b) => a - b)
if (ok.length > 0) {
  const median = ok[Math.floor(ok.length / 2)]
  console.log(`\nlabel=${patch === undefined ? 'plugin-enabled' : `patch:${patch}`}`)
  console.log(`runs=${ok.join(', ')}`)
  console.log(`min=${String(ok[0])}ms median=${String(median)}ms max=${String(ok[ok.length - 1])}ms`)
} else {
  console.log('\n所有轮次都启动失败')
}

// 慢启动的那几轮留下日志（诊断"启动变长"的证据），其余删掉。
for (const [index, result] of results.entries()) {
  const logPath = join(logDir, `boot-${String(index + 1)}.log`)
  if (result.ms >= SLOW_MS) {
    console.log(`\n=== 慢启动 ${String(result.ms)}ms，日志保留在 ${logPath} ===`)
    continue
  }
  rmSync(logPath, { force: true })
}
