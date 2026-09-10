/**
 * 跑 Biome 的 lint（不跑 format：既有代码的排版是刻意的，批量重排会让 diff 失去可读性，
 * 见 README 的「工程化」一节）。
 *
 * 为什么要这层包装：Biome 可能装在三个地方——本仓库的 devDependencies（CI / 新机器）、
 * dsh 安装所在的全局 node_modules（本机现状）、或 PATH 上。写死 `biome lint` 会让其中两种环境跑不起来。
 *
 * 运行：node scripts/lint.mjs [额外参数…]
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 找一个可用的 Biome 入口。
 * @returns {string | undefined} `bin/biome` 的绝对路径。
 */
function findBiome() {
  // Node 的"全局前缀"：`process.execPath` 所在目录（Windows nvm4w 下是 `C:\nvm4w\nodejs`，
  // 它本身是指向当前版本目录的链接，因此全局 `node_modules` 就在它下面）。
  const prefix = dirname(process.execPath)
  const parent = dirname(prefix)
  const candidates = [
    join(repoRoot, 'node_modules', '@biomejs', 'biome', 'bin', 'biome'),
    join(prefix, 'node_modules', '@biomejs', 'biome', 'bin', 'biome'),
    join(prefix, 'lib', 'node_modules', '@biomejs', 'biome', 'bin', 'biome'),
    join(parent, 'node_modules', '@biomejs', 'biome', 'bin', 'biome'),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

const biome = findBiome()
if (biome === undefined) {
  console.error(
    'lint: 找不到 biome。请二选一：\n' +
      '  · 在本仓库装：npm install -D @biomejs/biome\n' +
      '  · 或在全局装：npm install -g @biomejs/biome',
  )
  process.exit(1)
}

const args = ['lint', ...process.argv.slice(2)]
const result = spawnSync(process.execPath, [biome, ...args], { stdio: 'inherit', cwd: repoRoot })
process.exit(result.status ?? 1)
