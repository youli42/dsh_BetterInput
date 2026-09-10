/**
 * 本地开发用：把宿主提供的 `@deepseek-ai/*` 包软链进本仓库的 `node_modules`。
 *
 * 为什么需要它（第二个理由常被忽略）：
 *
 *   1. **测试**：`test/smoke.mjs` 会 `import '../lib/index.js'`，而宿主半
 *      `import '@deepseek-ai/dsh-llm'`、设置半 `import '@deepseek-ai/schemastery'`；
 *      `test/settings-activation.mjs` 还要真实加载 cordis 与 settings 提供者。
 *      没有本仓库内的 `node_modules`，Node 直接 `ERR_MODULE_NOT_FOUND`。
 *   2. **运行时**：用 `dsh plugin --profile web add link:<本目录>` 安装时，profile 里
 *      放的是**符号链接**，Node 按 realpath 解析模块，于是插件自己的裸导入是从
 *      **本目录**向上找 `node_modules` 的——`$DSH_HOME/profiles/node_modules` 那个
 *      镜像根本不在解析路径上。所以这些链接在 `link:` 安装方式下**运行时也必须存在**，
 *      并不是"只为跑测试"。
 *
 * 只用 junction/symlink，不复制、不联网、不改 profile。
 *
 * 用法：node scripts/link-dev-deps.mjs   （`npm test` 前会自动跑一遍）
 */

import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveDshAnchor, resolvePackageDir } from './dsh-packages.mjs'

/**
 * 需要在仓库内可见的宿主包：
 *   前两个是插件自身的运行时导入，后三个给集成测试加载真实框架用。
 */
const REQUIRED = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-settings-file',
]

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeModules = join(repoRoot, 'node_modules')

/**
 * 取一个链接当前指向的 realpath（条目不存在或不是链接时返回 undefined）。
 * @param {string} linkPath - 链接路径。
 * @returns {string | undefined} realpath。
 */
function currentTarget(linkPath) {
  const entry = lstatSync(linkPath, { throwIfNoEntry: false })
  if (entry === undefined || !entry.isSymbolicLink()) return undefined
  try {
    return realpathSync(linkPath)
  } catch {
    return undefined
  }
}

/**
 * 建/重建一个 junction，指向 target。
 * @param {string} linkPath - 链接路径。
 * @param {string} target - 目标目录。
 * @returns {'created' | 'current' | 'replaced'} 动作。
 */
function link(linkPath, target) {
  if (currentTarget(linkPath) === target) return 'current'
  const entry = lstatSync(linkPath, { throwIfNoEntry: false })
  if (entry !== undefined && !entry.isSymbolicLink()) {
    throw new Error(`link-dev-deps: ${linkPath} 是真实目录而不是链接；脚本不会动它，请自行确认`)
  }
  if (entry !== undefined) rmSync(linkPath, { force: true })
  mkdirSync(dirname(linkPath), { recursive: true })
  // Windows 上用 junction：无需管理员权限，且目标必须是绝对路径。
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  return entry === undefined ? 'created' : 'replaced'
}

const anchor = resolveDshAnchor()
if (anchor === undefined) {
  console.error(
    'link-dev-deps: 找不到 dsh 安装（无法解析 @deepseek-ai/dsh-llm）。\n' +
      '  · 已安装 dsh 时，请确认 dsh 的安装目录在 nvm 或 ~/.dsh 下；\n' +
      '  · 也可显式指定：$env:DSH_INSTALL_ANCHOR = "<含 node_modules 的目录>"。',
  )
  process.exit(1)
}
if (!existsSync(nodeModules)) mkdirSync(nodeModules, { recursive: true })

console.log(`link-dev-deps: anchor = ${anchor}`)
let failures = 0
for (const spec of REQUIRED) {
  try {
    const target = resolvePackageDir(anchor, spec)
    const linkPath = join(nodeModules, ...spec.split('/'))
    const action = link(linkPath, target)
    console.log(`  ${action.padEnd(8)} ${spec} -> ${target}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL     ${spec}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (failures > 0) process.exit(1)
