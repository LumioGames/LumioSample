#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test as nodeTest } from 'node:test'
import { assertWorld } from './world-assert.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'Tools', 'fixtures', 'oracle-min')
const DET_VERIFY = join(ROOT, 'integration', 'determinism', 'det-verify')
const LOG_EXTENSIONS = new Set(['.ndjson', '.jsonl', '.log'])
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * ADR-125 决策 3:eventOrder 的收录/排除类别在这里具名列出。收录类别参与两轮逐位比较;
 * 排除类别(RPC 消息投递,不改世界状态)具名跳过比较;两边都不在的新类别判 FAIL,
 * 逼人决定收还是不收,不靠「没匹配上就算了」。
 */
export const INCLUDED_EVENT_CATEGORIES = Object.freeze(['entity-create', 'entity-field', 'entity-destroy', 'voxel-write'])
export const EXCLUDED_EVENT_CATEGORIES = Object.freeze(['rpc-delivery'])
const KNOWN_EVENT_CATEGORIES = new Set([...INCLUDED_EVENT_CATEGORIES, ...EXCLUDED_EVENT_CATEGORIES])
const isWorldEvent = entry => isObject(entry) && INCLUDED_EVENT_CATEGORIES.includes(entry.category)

export function normalizeLf(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function sha256Text(text) {
  return createHash('sha256').update(normalizeLf(text), 'utf8').digest('hex')
}

export function sha256File(path) {
  return sha256Text(readFileSync(path, 'utf8'))
}

export function parseNdjson(text, source = 'log') {
  const records = []
  const failures = []
  const lines = normalizeLf(text).split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i].trim()
    if (!lineText) continue
    const line = i + 1
    try {
      const value = JSON.parse(lineText)
      if (!isObject(value)) {
        failures.push({ check: 'logs:record', message: `${source}:${line} must be a JSON object` })
      } else {
        records.push({ line, source, value })
      }
    } catch (error) {
      failures.push({ check: 'logs:json', message: `${source}:${line} invalid JSON: ${error.message}` })
    }
  }
  return { records, failures }
}

function logFiles(root, result = []) {
  if (!existsSync(root)) return result
  const info = statSync(root)
  if (info.isFile()) {
    if (LOG_EXTENSIONS.has(extname(root).toLowerCase())) result.push(root)
    return result
  }
  for (const name of readdirSync(root).sort()) {
    logFiles(join(root, name), result)
  }
  return result
}

function valuesOf(value) {
  return Array.isArray(value) ? value : [value]
}

function display(value) {
  if (value === undefined) return '<missing>'
  return JSON.stringify(value)
}

function verifyRound(roundDir, label) {
  const failures = []
  const files = logFiles(roundDir)
  const eventOrder = []
  const appliedTicks = []
  const baseMapHashes = []
  const fileHashes = {}

  if (files.length === 0) {
    failures.push({ check: 'logs:empty', message: `${label} has no NDJSON/JSONL/log files` })
  }

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const name = relative(roundDir, file).replaceAll('\\', '/')
    fileHashes[name] = sha256Text(text)
    if (normalizeLf(text).trim() === '') {
      failures.push({ check: 'logs:empty', message: `${label}/${name} is empty` })
      continue
    }
    const parsed = parseNdjson(text, `${label}/${name}`)
    failures.push(...parsed.failures)
    for (const record of parsed.records) {
      const value = record.value
      if (Object.hasOwn(value, 'baseMapSha256')) baseMapHashes.push({ value: value.baseMapSha256, line: record.line, source: name })
      const hasOrder = Object.hasOwn(value, 'eventOrder')
      const hasTicks = Object.hasOwn(value, 'appliedTicks')
      if (hasOrder !== hasTicks) {
        failures.push({
          check: 'record:paired-fields',
          message: `${label}/${name}:${record.line} must provide eventOrder and appliedTicks together`,
        })
        continue
      }
      if (hasOrder) {
        const orders = valuesOf(value.eventOrder)
        const ticks = valuesOf(value.appliedTicks)
        for (let idx = 0; idx < orders.length; idx += 1) {
          const item = orders[idx]
          if (!isObject(item) || typeof item.category !== 'string' || item.category.length === 0 || typeof item.key !== 'string' || item.key.length === 0) {
            failures.push({
              check: 'record:eventOrder-contract',
              message: `${label}/${name}:${record.line} eventOrder[${idx}] must be { category, key } with non-empty strings, got ${display(item)}`,
            })
          } else if (!KNOWN_EVENT_CATEGORIES.has(item.category)) {
            failures.push({
              check: 'record:eventOrder-category',
              message: `${label}/${name}:${record.line} eventOrder[${idx}] category "${item.category}" is in neither list (included: ${INCLUDED_EVENT_CATEGORIES.join('/')}; excluded: ${EXCLUDED_EVENT_CATEGORIES.join('/')})`,
            })
          }
        }
        for (let idx = 0; idx < ticks.length; idx += 1) {
          const tick = ticks[idx]
          if (tick === null || tick === undefined || typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0) {
            failures.push({
              check: 'record:appliedTicks-contract',
              message: `${label}/${name}:${record.line} appliedTicks[${idx}] must be a non-negative integer, got ${display(tick)}`,
            })
          } else if (appliedTicks.length > 0) {
            const prev = appliedTicks[appliedTicks.length - 1]
            if (typeof prev === 'number' && Number.isInteger(prev) && tick < prev) {
              failures.push({
                check: 'record:appliedTicks-monotonic',
                message: `${label}/${name}:${record.line} appliedTicks[${idx}] must be monotonic: got ${tick}, previous was ${prev}`,
              })
            }
          }
          appliedTicks.push(tick)
        }
        eventOrder.push(...orders)
      }
    }
  }

  if (eventOrder.length === 0 || appliedTicks.length === 0) {
    failures.push({ check: 'logs:fields', message: `${label} contains no eventOrder/appliedTicks evidence` })
  }
  if (eventOrder.length !== appliedTicks.length) {
    failures.push({ check: 'logs:fields', message: `${label} eventOrder/appliedTicks records are not paired` })
  }
  const worldEventOrder = eventOrder.filter(isWorldEvent)
  if (eventOrder.length > 0 && worldEventOrder.length === 0) {
    // ADR-125 决策 4:只有排除类别的证据对判据 7 等于没有世界状态证据,按空证据 FAIL。
    failures.push({ check: 'logs:world-events', message: `${label} contains no world-state events (included categories: ${INCLUDED_EVENT_CATEGORIES.join('/')})` })
  }
  const uniqueHashes = [...new Set(baseMapHashes.map(entry => String(entry.value)))]
  if (uniqueHashes.length !== 1 || !/^[0-9a-f]{64}$/.test(uniqueHashes[0] ?? '')) {
    failures.push({ check: 'base-map-hash', message: `${label} must contain one lowercase 64-character baseMapSha256` })
  }

  return {
    ok: failures.length === 0,
    failures,
    eventOrder,
    worldEventOrder,
    appliedTicks,
    baseMapSha256: uniqueHashes[0] ?? null,
    fileHashes,
  }
}

export function compareRuns(round1, round2) {
  const failures = []
  if (!round1?.ok) failures.push({ check: 'round-1', message: 'round-1 log verification failed', details: round1?.failures ?? [] })
  if (!round2?.ok) failures.push({ check: 'round-2', message: 'round-2 log verification failed', details: round2?.failures ?? [] })
  if (round1?.baseMapSha256 !== round2?.baseMapSha256) {
    failures.push({
      check: 'base-map-hash-compare',
      message: `baseMapSha256 differs: round-1=${round1?.baseMapSha256 ?? '<missing>'}, round-2=${round2?.baseMapSha256 ?? '<missing>'}`,
    })
  }

  // ADR-125 决策 1/3:两轮只比收录类别的 eventOrder(逐位相等 + 条数相同);排除类别
  // (rpc-delivery)不进比较,其条数随连接时机抖动是已知非确定性,不是分歧。
  const left = round1?.worldEventOrder ?? []
  const right = round2?.worldEventOrder ?? []
  if (left.length !== right.length) {
    failures.push({
      check: 'event-order-count',
      message: `eventOrder counts differ: round-1=${left.length}, round-2=${right.length} (excluded categories ${EXCLUDED_EVENT_CATEGORIES.join('/')} are not counted)`,
    })
  }
  const maxOrder = Math.max(left.length, right.length)
  for (let index = 0; index < maxOrder; index += 1) {
    const a = left[index]
    const b = right[index]
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      failures.push({ check: 'event-order-compare', message: `eventOrder[${index}] differs: round-1=${display(a)}, round-2=${display(b)}` })
      break
    }
  }
  // ADR-125 决策 2:appliedTicks 不再做两轮逐位相等比较,只保留每轮的格式检查
  // (非负整数、单调不减、与 eventOrder 等长),见 verifyRound。
  return { ok: failures.length === 0, failures, round1, round2 }
}

function loadJsonObject(path, check) {
  if (!existsSync(path)) {
    return { ok: false, failures: [{ check, message: `missing ${path}` }] }
  }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!isObject(value)) {
      return { ok: false, failures: [{ check, message: `${path} must be a JSON object` }] }
    }
    return { ok: true, value, failures: [] }
  } catch (error) {
    return { ok: false, failures: [{ check, message: `${path} invalid JSON: ${error.message}` }] }
  }
}

function prefixWorldFailures(label, failures) {
  return failures.map((failure) => ({
    ...failure,
    message: `${label}: ${failure.message}`,
  }))
}

export function verifyWorldRounds(root, round1Dir, round2Dir) {
  const failures = []
  const expectedPath = join(root, 'expected.json')
  const expected = loadJsonObject(expectedPath, 'world:expected')
  if (!expected.ok) return { ok: false, failures: expected.failures }

  for (const [label, dir] of [['round-1', round1Dir], ['round-2', round2Dir]]) {
    const loaded = loadJsonObject(join(dir, 'world.json'), 'world:missing')
    if (!loaded.ok) {
      failures.push(...prefixWorldFailures(label, loaded.failures))
      continue
    }
    failures.push(...prefixWorldFailures(label, assertWorld(loaded.value, expected.value)))
  }
  return { ok: failures.length === 0, failures }
}

export function verifyIndependentRoundLayout(round1Dir, round2Dir) {
  const left = resolve(round1Dir)
  const right = resolve(round2Dir)
  if (left === right) {
    return { ok: false, failures: [{ check: 'rounds:independent', message: 'round-1 and round-2 must be distinct directories' }] }
  }
  return { ok: true, failures: [] }
}

export function verifyEvidenceDir(dir) {
  const root = resolve(String(dir ?? ''))
  if (!root || !existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: false, failures: [{ check: 'logs:missing', message: `log directory does not exist: ${dir}` }] }
  }
  const round1Dir = join(root, 'round-1')
  const round2Dir = join(root, 'round-2')
  const failures = []
  // ADR-125 失败语义:读不到某一轮的证据就 FAIL,并写明缺的是哪个目录,不当成「没有差异」。
  const missingRounds = ['round-1', 'round-2'].filter((name) => !existsSync(join(root, name)))
  if (missingRounds.length > 0) {
    failures.push({ check: 'logs:rounds', message: `missing evidence directories: ${missingRounds.map((name) => join(root, name)).join(', ')}` })
  }
  const layout = verifyIndependentRoundLayout(round1Dir, round2Dir)
  const logs = compareRuns(verifyRound(round1Dir, 'round-1'), verifyRound(round2Dir, 'round-2'))
  const worlds = verifyWorldRounds(root, round1Dir, round2Dir)
  failures.push(...layout.failures, ...logs.failures, ...worlds.failures)
  return { ok: failures.length === 0, failures, round1: logs.round1, round2: logs.round2 }
}

/** ADR-123 决策 11: the game workspace has no docs/; the tour is a knowledge document. */
export const TOUR_RELATIVE = '.spec/knowledge/features/sample-tour.md'

export function verifyTourLinks(root = ROOT) {
  const tourPath = join(root, TOUR_RELATIVE)
  const failures = []
  if (!existsSync(tourPath)) return [{ check: 'tour:path', message: `${TOUR_RELATIVE} is missing` }]
  const markdown = readFileSync(tourPath, 'utf8')
  for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#', 1)[0]
    if (!target || /^[a-z]+:/i.test(target)) continue
    const path = resolve(dirname(tourPath), target)
    if (!existsSync(path)) failures.push({ check: 'tour:path', message: `${TOUR_RELATIVE} points to missing path: ${target}` })
  }
  return failures
}

function tempFixture(label) {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), `.tmp-${label}-`))
  cpSync(FIXTURE, dir, { recursive: true })
  return dir
}

function readFixtureLines(dir, round = 'round-2') {
  return readFileSync(join(dir, round, 'events.ndjson'), 'utf8').trimEnd().split('\n')
}

/** 改第 lineIndex 行的记录再整体写回;直接字符串 replace 会绑死在具体 JSON 序列化上。 */
function editFixtureRecord(dir, round, lineIndex, edit) {
  const lines = readFixtureLines(dir, round)
  const record = JSON.parse(lines[lineIndex])
  edit(record)
  lines[lineIndex] = JSON.stringify(record)
  writeFileSync(join(dir, round, 'events.ndjson'), `${lines.join('\n')}\n`)
}

const test = process.env.NODE_TEST_CONTEXT ? nodeTest : () => {}

test('sha256 normalizes CRLF to LF', () => {
  assert.equal(sha256Text('a\nb\n'), sha256Text('a\r\nb\r\n'))
})

test('oracle-min fixture passes with two identical rounds', () => {
  const report = verifyEvidenceDir(FIXTURE)
  assert.equal(report.ok, true, JSON.stringify(report.failures))
})

test('ADR-125 fixture (a): the committed two-round evidence passes', () => {
  const report = verifyEvidenceDir(DET_VERIFY)
  assert.equal(report.ok, true, JSON.stringify(report.failures))
  assert.ok(report.round1.worldEventOrder.length > 0, 'round-1 must carry world-state events')
})

test('ADR-125 fixture (b): swapping two round-2 eventOrder entries fails', () => {
  const dir = tempFixture('order-swap')
  try {
    const lines = readFixtureLines(dir)
    const swapped = [lines[0], lines[2], lines[1], ...lines.slice(3)]
    writeFileSync(join(dir, 'round-2', 'events.ndjson'), `${swapped.join('\n')}\n`)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(failure => failure.check === 'event-order-compare' && failure.message.includes('eventOrder[0]')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ADR-125 fixture (c): deleting one round-2 world event fails on count', () => {
  const dir = tempFixture('event-deleted')
  try {
    const lines = readFixtureLines(dir)
    writeFileSync(join(dir, 'round-2', 'events.ndjson'), `${[lines[0], ...lines.slice(2)].join('\n')}\n`)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(failure => failure.check === 'event-order-count' && failure.message.includes('round-1=3, round-2=2')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ADR-125 fixture (d): one changed round-2 terminal cell fails', () => {
  const dir = tempFixture('world-cell')
  try {
    const world = JSON.parse(readFileSync(join(dir, 'round-2', 'world.json'), 'utf8'))
    world.cells[1].block = 'stone'
    writeFileSync(join(dir, 'round-2', 'world.json'), `${JSON.stringify(world, null, 2)}\n`)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(failure => failure.check === 'world:cell' && failure.message.startsWith('round-2')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ADR-125 fixture (d): round-2 ore count +1 fails', () => {
  const dir = tempFixture('world-ore')
  try {
    const world = JSON.parse(readFileSync(join(dir, 'round-2', 'world.json'), 'utf8'))
    world.oreCount += 1
    writeFileSync(join(dir, 'round-2', 'world.json'), `${JSON.stringify(world, null, 2)}\n`)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(failure => failure.check === 'world:ore' && failure.message.startsWith('round-2')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ADR-125 fixture (e): an event category outside both lists fails', () => {
  const dir = tempFixture('unknown-category')
  try {
    const line = JSON.stringify({ eventOrder: [{ category: 'physics-collision', key: 'entity:1' }], appliedTicks: [9] })
    writeFileSync(join(dir, 'round-2', 'events.ndjson'), `${readFixtureLines(dir).join('\n')}\n${line}\n`)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(failure => failure.check === 'round-2'
      && failure.details?.some(detail => detail.check === 'record:eventOrder-category' && detail.message.includes('physics-collision'))))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ADR-125 fixture (f): both rounds with empty evidence fail closed', () => {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-empty-'))
  try {
    mkdirRoundDirs(dir)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    for (const round of ['round-1', 'round-2']) {
      assert.ok(report.failures.some(failure => failure.check === round || failure.check === 'logs:empty'), `${round} must fail`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ADR-125 fixture (g): round-2 appliedTicks shifted by +5 still passes', () => {
  const dir = tempFixture('tick-shift')
  try {
    for (let index = 1; index <= 3; index += 1) {
      editFixtureRecord(dir, 'round-2', index, record => { record.appliedTicks = record.appliedTicks.map(tick => tick + 5) })
    }
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, true, JSON.stringify(report.failures))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ADR-125 fixture (g): a round-2 tick below its predecessor fails the monotonic check', () => {
  const dir = tempFixture('tick-regress')
  try {
    editFixtureRecord(dir, 'round-2', 3, record => { record.appliedTicks = [1] })
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(failure => failure.check === 'round-2'
      && failure.details?.some(detail => detail.check === 'record:appliedTicks-monotonic')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a different base map hash fails across rounds', () => {
  const dir = tempFixture('base-map-drift')
  try {
    const path = join(dir, 'round-2', 'events.ndjson')
    const changed = readFileSync(path, 'utf8').replace('69e4920ba15487af6e5c7cada510a61751517f5b95ee9f1e571303564c179bbd', 'a'.repeat(64))
    writeFileSync(path, changed)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(failure => failure.check === 'base-map-hash-compare'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tour markdown links resolve to files in this repository', () => {
  assert.deepEqual(verifyTourLinks(), [])
})

test('tour can be walked: fourteen steps, no stale ABI-does-not-exist copy', () => {
  const markdown = readFileSync(join(ROOT, TOUR_RELATIVE), 'utf8')
  assert.match(markdown, /第 1 步/)
  assert.match(markdown, /第 4 步/)
  assert.match(markdown, /第 8 步/)
  assert.match(markdown, /第 9–14 步/)
  for (const step of [9, 10, 11, 12, 13, 14]) {
    assert.match(markdown, new RegExp(`\\| ${step} \\|`))
  }
  assert.doesNotMatch(markdown, /上游 write ABI 不存在|ABI does not exist/)
  assert.match(markdown, /world-assert/)
  assert.match(markdown, /established/)
  assert.match(markdown, /typed Reader/)
})

test('both rounds wrong one cell fail even when logs match', () => {
  const dir = tempFixture('wrong-cell')
  try {
    const expected = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8'))
    const wrong = {
      ...expected,
      cells: expected.cells.map((cell, index) => (index === 1 ? { ...cell, block: 'stone' } : cell)),
    }
    writeFileSync(join(dir, 'round-1', 'world.json'), `${JSON.stringify(wrong)}\n`)
    writeFileSync(join(dir, 'round-2', 'world.json'), `${JSON.stringify(wrong)}\n`)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 'world:cell'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wrong ore count fails independently of matching logs', () => {
  const dir = tempFixture('wrong-ore')
  try {
    const expected = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8'))
    const wrong = { ...expected, oreCount: 99 }
    writeFileSync(join(dir, 'round-1', 'world.json'), `${JSON.stringify(wrong)}\n`)
    writeFileSync(join(dir, 'round-2', 'world.json'), `${JSON.stringify(wrong)}\n`)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some((failure) => failure.check === 'world:ore'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI swapped eventOrder in one round exits 1', () => {
  const dir = tempFixture('cli-event-order')
  try {
    const lines = readFixtureLines(dir, 'round-1')
    const swapped = [lines[0], lines[2], lines[1], ...lines.slice(3)]
    writeFileSync(join(dir, 'round-1', 'events.ndjson'), `${swapped.join('\n')}\n`)
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--dir', dir], { env, encoding: 'utf8' })
    assert.equal(res.status, 1)
    assert.match(res.stdout, /event-order-compare/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI empty logs exit 1', () => {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-cli-empty-'))
  try {
    mkdirRoundDirs(dir)
    writeFileSync(join(dir, 'expected.json'), readFileSync(join(FIXTURE, 'expected.json')))
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--dir', dir], { env, encoding: 'utf8' })
    assert.equal(res.status, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fields are read from logs and are never synthesized', () => {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-fields-'))
  try {
    mkdirRoundDirs(dir)
    writeFileSync(join(dir, 'expected.json'), readFileSync(join(FIXTURE, 'expected.json')))
    const world = readFileSync(join(FIXTURE, 'round-1', 'world.json'))
    writeFileSync(join(dir, 'round-1', 'world.json'), world)
    writeFileSync(join(dir, 'round-2', 'world.json'), world)
    const content = '{"baseMapSha256":"' + 'a'.repeat(64) + '","kind":"tick","appliedTick":1}\n'
    writeFileSync(join(dir, 'round-1', 'events.ndjson'), content)
    writeFileSync(join(dir, 'round-2', 'events.ndjson'), content)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(failure => failure.check === 'round-1' && failure.details?.some(detail => detail.check === 'logs:fields')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appliedTicks with null fails and identifies position', () => {
  const dir = tempFixture('tick-null')
  try {
    editFixtureRecord(dir, 'round-1', 1, record => { record.appliedTicks = [null] })
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(f => f.check === 'round-1'
      && f.details?.some(d => d.check === 'record:appliedTicks-contract' && d.message.includes('appliedTicks[0]'))))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appliedTicks with negative integer fails and identifies position', () => {
  const dir = tempFixture('tick-negative')
  try {
    editFixtureRecord(dir, 'round-1', 1, record => { record.appliedTicks = [-2] })
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(f => f.check === 'round-1'
      && f.details?.some(d => d.check === 'record:appliedTicks-contract' && d.message.includes('appliedTicks[0]'))))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appliedTicks with non-integer fails and identifies position', () => {
  const dir = tempFixture('tick-non-integer')
  try {
    editFixtureRecord(dir, 'round-1', 1, record => { record.appliedTicks = [2.5] })
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(f => f.check === 'round-1'
      && f.details?.some(d => d.check === 'record:appliedTicks-contract' && d.message.includes('appliedTicks[0]'))))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI without --dir exits with code 2 and usage message', () => {
  const scriptPath = fileURLToPath(import.meta.url)
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const res = spawnSync(process.execPath, [scriptPath], { env, encoding: 'utf8' })
  assert.equal(res.status, 2)
  assert.match(res.stderr, /usage: node verify-evidence\.mjs --dir <logs>/)
})

function mkdirRoundDirs(root) {
  for (const round of ['round-1', 'round-2']) {
    mkdirSync(join(root, round), { recursive: true })
  }
}

function isCliMain() {
  return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
}

if (isCliMain() && !process.env.NODE_TEST_CONTEXT) {
  const index = process.argv.indexOf('--dir')
  const dir = index >= 0 ? process.argv[index + 1] : undefined
  if (!dir) {
    process.stderr.write('usage: node verify-evidence.mjs --dir <logs>\n')
    process.exitCode = 2
  } else {
    const report = verifyEvidenceDir(dir)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = report.ok ? 0 : 1
  }
}
