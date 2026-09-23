/**
 * LumioSample extensions for Workflow spec-lint, API 1 (Engine ADR-089).
 * Generic frontmatter, navigation, ADR indexing, links, imports, skills and
 * fingerprints belong to the plugin. This repo additionally requires CLAUDE.md
 * and both host discovery paths whenever project skills exist. The ADR-115
 * directory contract check is imported from a LumioGameEngine checkout (see below).
 * Run: node .spec/tools/lint-extensions.mjs [root] [--strict] [--json]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const api = 1
export const config = {
  frontmatterDirs: ['knowledge/features', 'knowledge/standards'],
  statusEnum: ['设计中', '实施中', '已交付', '历史归档'],
}

const normalize = path => process.platform === 'win32' ? path.toLowerCase() : path
export const checks = [{
  id: 'lumio-host-entrypoints',
  run({ root, spec, report }) {
    const claude = join(root, 'CLAUDE.md')
    if (!existsSync(claude)) report(claude, '缺核心文件:CLAUDE.md(强制载入入口)')
    if (!existsSync(join(spec, 'skills'))) return
    for (const rel of ['.claude/skills', '.agents/skills']) {
      const path = join(root, rel)
      try {
        // The plugin checks symlinks; ordinary paths need the same containment rule.
        if (lstatSync(path).isSymbolicLink()) continue
        const target = normalize(realpathSync(path))
        const base = normalize(realpathSync(spec))
        if (target !== base && !target.startsWith(base + sep)) {
          report(path, `发现路径未解析进 .spec/:${target}`)
        }
      } catch { report(path, '软链接缺失(宿主自动发现依赖它)') }
    }
  },
}]

/**
 * ADR-115 directory contract. This repository keeps **no implementation** of it: the only JS
 * implementation is `repoLayoutCheck`, exported by the architecture repository's
 * `.spec/tools/lint-extensions.mjs` (repository-layout.md §6, R-00700). It is imported from the
 * `LumioGameEngine` checkout that also holds `repo-layout.json`, looked up in the same order the
 * check itself uses for the JSON: LUMIO_ENGINE_ROOT → same-suffix worktree (`LumioX-y` →
 * `LumioGameEngine-y`) → sibling main checkout. An explicit LUMIO_ENGINE_ROOT is the only
 * candidate when set: if it holds no `repo-layout.json` that is BLOCKED_ENV, not a quiet fall-back
 * to a sibling checkout on whatever branch it happens to be. A missing or pre-R-00700 checkout is
 * BLOCKED_ENV too, never silently passed. Every run names the JSON it used and that checkout's HEAD
 * on stderr, so a pass says what it passed against.
 * This locator cannot itself be imported from the architecture repository — it is what finds that
 * checkout — so LumioServer, LumioGameRuntime, LumioClient and LumioSample each carry this block
 * with identical code; change all four together (R-00719).
 */
const ENGINE_REPO = 'LumioGameEngine'
const LAYOUT_JSON = join('.spec', 'tools', 'repo-layout.json')
const ENGINE_EXTENSION = join('.spec', 'tools', 'lint-extensions.mjs')

function engineCheckout(root) {
  const env = process.env.LUMIO_ENGINE_ROOT
  if (env) {
    const base = resolve(env)
    return existsSync(join(base, LAYOUT_JSON))
      ? { base }
      : { invalid: `BLOCKED_ENV:LUMIO_ENGINE_ROOT=${env} 下没有 ${LAYOUT_JSON}——显式指定的检出无效,不回落到同级检出;修正或清空该变量` }
  }
  const parent = dirname(root)
  const name = basename(root)
  const dash = name.indexOf('-')
  const base = [
    ...(dash > 0 ? [join(parent, ENGINE_REPO + name.slice(dash))] : []),
    join(parent, ENGINE_REPO),
  ].find(candidate => existsSync(join(candidate, LAYOUT_JSON)))
  return base ? { base } : {}
}

function checkoutHead(base) {
  const result = spawnSync('git', ['-C', base, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : 'unknown (not a git checkout)'
}

checks.push({
  id: 'lumio-repo-layout',
  async run(ctx) {
    // Only decides "skip vs BLOCKED_ENV" when no checkout is found; with one, the imported
    // check does the real identification (checkout name → repos / appliesTo / outOfScope key).
    if (!basename(ctx.root).startsWith('Lumio')) return { skipped: `${basename(ctx.root)} 不是 Lumio 仓检出,ADR-115 目录契约不适用` }
    const { base, invalid } = engineCheckout(ctx.root)
    if (invalid) {
      ctx.report(join(ctx.root, LAYOUT_JSON), invalid)
      return undefined
    }
    if (!base) {
      ctx.report(join(ctx.root, LAYOUT_JSON), `BLOCKED_ENV:同级 ${ENGINE_REPO} checkout 缺失,读不到 ${LAYOUT_JSON} 与目录契约检查——放一个同级检出或设 LUMIO_ENGINE_ROOT;不静默通过`)
      return undefined
    }
    // stderr, not stdout: `--json` owns stdout.
    process.stderr.write(`lumio-repo-layout: ${join(base, LAYOUT_JSON)} @ ${ENGINE_REPO} HEAD ${checkoutHead(base)}\n`)
    const { repoLayoutCheck } = await import(pathToFileURL(join(base, ENGINE_EXTENSION)).href)
    if (typeof repoLayoutCheck?.run !== 'function') {
      ctx.report(join(base, ENGINE_EXTENSION), `BLOCKED_ENV:${base} 早于 R-00700,没有导出 repoLayoutCheck——把该检出更新到 origin/main;本仓不留回落实现`)
      return undefined
    }
    return repoLayoutCheck.run(ctx)
  },
})

// Preserve the former CLI without executing it when the plugin imports us.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { runLintCli } = await import('../../eng/spec-lint.mjs')
  runLintCli(process.argv.slice(2))
}
