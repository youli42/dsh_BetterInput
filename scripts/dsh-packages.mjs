/**
 * 定位 dsh 安装位置与其中的宿主包。
 *
 * 供两处共用：
 *   · `scripts/link-dev-deps.mjs` —— 在仓库内建软链，让 `link:` 安装与本地测试都能解析 `@deepseek-ai/*`；
 *   · `test/settings-activation.mjs` —— 集成测试要加载**真实**的 cordis 与 settings 提供者。
 *
 * 判据是「从这个目录能解析出 `@deepseek-ai/dsh-llm`」，因为宿主包只随 dsh 安装分发。
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 解析时使用的探测包：它一定随 dsh 安装存在。 */
const PROBE = '@deepseek-ai/dsh-llm'

/**
 * 从一个目录解析探测包，成功时返回 true。
 * @param {string} anchor - 目录。
 * @returns {boolean} 能否解析。
 */
function canResolve(anchor) {
  try {
    createRequire(join(anchor, '__probe__.cjs')).resolve(PROBE)
    return true
  } catch {
    return false
  }
}

/**
 * nvm-for-windows 的安装目录候选（`%LOCALAPPDATA%\nvm\<version>\node_modules`）。
 * @returns {string[]} 候选目录。
 */
function nvmRoots() {
  const base = process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'nvm')
  if (base === undefined || !existsSync(base)) return []
  const found = []
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    found.push(join(base, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
    found.push(join(base, entry.name, 'node_modules'))
  }
  return found
}

/**
 * 找可用于解析宿主包的目录。
 *
 * 依次尝试：显式环境变量 → `$DSH_HOME` 下的 profiles → 默认 `~/.dsh/profiles`
 * → 本仓库 → nvm 安装目录。
 * @returns {string | undefined} 锚点目录（解析不到时 undefined）。
 */
export function resolveDshAnchor() {
  const home = homedir()
  const candidates = [
    process.env.DSH_INSTALL_ANCHOR,
    process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, 'profiles', 'web'),
    process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, 'profiles'),
    join(home, '.dsh', 'profiles', 'web'),
    join(home, '.dsh', 'profiles'),
    ...nvmRoots(),
  ]
  for (const candidate of candidates) {
    if (candidate === undefined || !existsSync(candidate)) continue
    if (canResolve(candidate)) return candidate
  }
  return undefined
}

/**
 * 解析某个宿主包的入口文件（结果已 realpath）。
 * @param {string} anchor - 解析锚点（来自 {@link resolveDshAnchor}）。
 * @param {string} spec - 包名。
 * @returns {string} 入口文件绝对路径。
 * @throws {Error} 解析不到时抛错（fail loud，不静默跳过）。
 */
export function resolvePackageEntry(anchor, spec) {
  const require = createRequire(join(anchor, '__resolve__.cjs'))
  try {
    return realpathSync(require.resolve(spec))
  } catch (error) {
    // 纯类型包（`@types/*`）没有 main 入口，`resolve(spec)` 必然失败——改用 package.json 定位。
    try {
      return realpathSync(require.resolve(`${spec}/package.json`))
    } catch {
      throw error
    }
  }
}

/**
 * 解析某个宿主包的目录（结果已 realpath）。
 * @param {string} anchor - 解析锚点。
 * @param {string} spec - 包名。
 * @returns {string} 包目录绝对路径。
 * @throws {Error} 找不到 package.json 时抛错。
 */
export function resolvePackageDir(anchor, spec) {
  let dir = dirname(resolvePackageEntry(anchor, spec))
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(`cannot locate package root of ${spec}`)
    }
    dir = parent
  }
  return realpathSync(dir)
}
