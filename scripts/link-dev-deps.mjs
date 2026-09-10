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

import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveDshAnchor, resolvePackageDir } from './dsh-packages.mjs'

/**
 * 需要在仓库内可见的宿主包：
 *   · dsh-llm / schemastery —— 插件自身的运行时导入；
 *   · cordis / dsh-settings / dsh-settings-file —— 真框架集成测试；
 *   · @types/node —— `npm run typecheck` 需要 node 全局类型（tsc 本身不在 dsh 里，见 README）。
 * react / react-dom 单独处理（必须版本配对，见文件末尾）。
 */
const REQUIRED = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-settings-file',
  '@types/node',
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

/**
 * 仓库内是否已经能解析全部所需包（CI 用 `npm install` 装了真依赖时就是这种情况）。
 * @param {string[]} specs - 包名列表。
 * @returns {string[]} 仍解析不到的包名。
 */
function unresolvedFromRepo(specs) {
  const require = createRequire(join(repoRoot, '__probe__.cjs'))
  return specs.filter((spec) => {
    try {
      require.resolve(spec)
      return false
    } catch {
      try {
        require.resolve(`${spec}/package.json`)
        return false
      } catch {
        return true
      }
    }
  })
}

const PAIRED = ['react', 'react-dom']

// CI（以及"已手装 devDependencies"的机器）没有 dsh 安装：依赖直接从 registry 装进本仓库，
// 此时解析已经没问题，链接这一步就该安静跳过，而不是报"找不到 dsh 安装"。
if (unresolvedFromRepo([...REQUIRED, ...PAIRED]).length === 0) {
  console.log('link-dev-deps: 所有依赖都能从仓库解析（CI / 已装 devDependencies），跳过链接')
  process.exit(0)
}

const anchor = resolveDshAnchor()
if (anchor === undefined) {
  console.error(
    'link-dev-deps: 找不到 dsh 安装（无法解析 @deepseek-ai/dsh-llm）。\n' +
      '  · 已安装 dsh 时，请确认 dsh 的安装目录在 nvm 或 ~/.dsh 下；\n' +
      '  · 在 CI 里请先 `npm install` 需要的宿主包；\n' +
      '  · 也可显式指定：$env:DSH_INSTALL_ANCHOR = "<含 node_modules 的目录>"。',
  )
  process.exit(1)
}
if (!existsSync(nodeModules)) mkdirSync(nodeModules, { recursive: true })

console.log(`link-dev-deps: anchor = ${anchor}`)
let failures = 0

/**
 * 建一个链接（spec → 某个包目录），失败只计数不中断其余包。
 * @param {string} spec - 包名（决定链接路径）。
 * @param {string} target - 目标包目录。
 * @returns {void}
 */
function linkSpec(spec, target) {
  try {
    const action = link(join(nodeModules, ...spec.split('/')), target)
    console.log(`  ${action.padEnd(8)} ${spec} -> ${target}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL     ${spec}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

for (const spec of REQUIRED) {
  try {
    linkSpec(spec, resolvePackageDir(anchor, spec))
  } catch (error) {
    failures += 1
    console.error(`  FAIL     ${spec}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// react 与 react-dom **必须版本配对**，否则 React 19 的 DOM 包会直接抛
// "Incompatible React versions"。dsh 安装里 hoisted react 是 18.x，而 react-dom 只存在于
// 某个包自己的嵌套目录（同级带一份同版本 react），所以按"react-dom 的同级 react"成对链接，
// 而不是各自独立解析（那样会链成 18 + 19 的错配）。
try {
  const reactDomDir = resolvePackageDir(anchor, 'react-dom')
  const reactDir = join(dirname(reactDomDir), 'react')
  if (!existsSync(join(reactDir, 'package.json'))) {
    throw new Error('react-dom 同级的 react 不存在，无法组成版本一致的渲染对')
  }
  const version = JSON.parse(readFileSync(join(reactDomDir, 'package.json'), 'utf8')).version
  linkSpec('react', reactDir)
  linkSpec('react-dom', reactDomDir)
  console.log(`  （react/react-dom 配对为 ${String(version)}）`)
} catch (error) {
  failures += 1
  console.error(`  FAIL     react/react-dom 配对: ${error instanceof Error ? error.message : String(error)}`)
}

if (failures > 0) process.exit(1)
