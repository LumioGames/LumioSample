#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test as nodeTest } from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'integration', 'fixtures', 'oracle-min')
const LOG_EXTENSIONS = new Set(['.ndjson', '.jsonl', '.log'])
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

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
          if (typeof item !== 'string' || item.length === 0) {
            failures.push({
              check: 'record:eventOrder-contract',
              message: `${label}/${name}:${record.line} eventOrder[${idx}] must be a non-empty string, got ${display(item)}`,
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
  const uniqueHashes = [...new Set(baseMapHashes.map(entry => String(entry.value)))]
  if (uniqueHashes.length !== 1 || !/^[0-9a-f]{64}$/.test(uniqueHashes[0] ?? '')) {
    failures.push({ check: 'base-map-hash', message: `${label} must contain one lowercase 64-character baseMapSha256` })
  }

  return {
    ok: failures.length === 0,
    failures,
    eventOrder,
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

  const maxOrder = Math.max(round1?.eventOrder?.length ?? 0, round2?.eventOrder?.length ?? 0)
  for (let index = 0; index < maxOrder; index += 1) {
    const left = round1?.eventOrder?.[index]
    const right = round2?.eventOrder?.[index]
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      failures.push({ check: 'event-order-compare', message: `eventOrder[${index}] differs: round-1=${display(left)}, round-2=${display(right)}` })
      break
    }
  }

  const maxTicks = Math.max(round1?.appliedTicks?.length ?? 0, round2?.appliedTicks?.length ?? 0)
  for (let index = 0; index < maxTicks; index += 1) {
    const left = round1?.appliedTicks?.[index]
    const right = round2?.appliedTicks?.[index]
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      failures.push({ check: 'applied-tick-compare', message: `appliedTicks[${index}] differs: round-1=${display(left)}, round-2=${display(right)}` })
      break
    }
  }
  return { ok: failures.length === 0, failures, round1, round2 }
}

export function verifyEvidenceDir(dir) {
  const root = resolve(String(dir ?? ''))
  if (!root || !existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: false, failures: [{ check: 'logs:missing', message: `log directory does not exist: ${dir}` }] }
  }
  const round1Dir = join(root, 'round-1')
  const round2Dir = join(root, 'round-2')
  if (!existsSync(round1Dir) || !existsSync(round2Dir)) {
    return { ok: false, failures: [{ check: 'logs:rounds', message: 'both round-1 and round-2 directories are required' }] }
  }
  return compareRuns(verifyRound(round1Dir, 'round-1'), verifyRound(round2Dir, 'round-2'))
}

export function verifyTourLinks(root = ROOT) {
  const tourPath = join(root, 'docs', 'tour.md')
  const failures = []
  if (!existsSync(tourPath)) return [{ check: 'tour:path', message: 'docs/tour.md is missing' }]
  const markdown = readFileSync(tourPath, 'utf8')
  for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#', 1)[0]
    if (!target || /^[a-z]+:/i.test(target)) continue
    const path = resolve(dirname(tourPath), target)
    if (!existsSync(path)) failures.push({ check: 'tour:path', message: `docs/tour.md points to missing path: ${target}` })
  }
  return failures
}

function tempFixture(label) {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), `.tmp-${label}-`))
  cpSync(FIXTURE, dir, { recursive: true })
  return dir
}

const test = process.env.NODE_TEST_CONTEXT ? nodeTest : () => {}

test('sha256 normalizes CRLF to LF', () => {
  assert.equal(sha256Text('a\nb\n'), sha256Text('a\r\nb\r\n'))
})

test('oracle-min fixture passes with two identical rounds', () => {
  const report = verifyEvidenceDir(FIXTURE)
  assert.equal(report.ok, true, JSON.stringify(report.failures))
})

test('a changed tick fails and identifies its appliedTicks position', () => {
  const dir = tempFixture('tick-drift')
  try {
    const path = join(dir, 'round-2', 'events.ndjson')
    const changed = readFileSync(path, 'utf8').replace('"appliedTicks":[1,2,3]', '"appliedTicks":[1,2,99]')
    writeFileSync(path, changed)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(failure => failure.check === 'applied-tick-compare' && failure.message.includes('appliedTicks[2]')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reordered event fails and identifies its eventOrder position', () => {
  const dir = tempFixture('event-order-drift')
  try {
    const path = join(dir, 'round-2', 'events.ndjson')
    const changed = readFileSync(path, 'utf8').replace('"event-2","event-3"', '"event-3","event-2"')
    writeFileSync(path, changed)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(failure => failure.check === 'event-order-compare' && failure.message.includes('eventOrder[1]')))
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

test('an empty log directory fails closed', () => {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-empty-'))
  try {
    mkdirRoundDirs(dir)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(failure => failure.check === 'round-1' || failure.check === 'logs:empty'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tour markdown links resolve to files in this repository', () => {
  assert.deepEqual(verifyTourLinks(), [])
})

test('fields are read from logs and are never synthesized', () => {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-fields-'))
  try {
    mkdirRoundDirs(dir)
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
    const path = join(dir, 'round-1', 'events.ndjson')
    const changed = readFileSync(path, 'utf8').replace('"appliedTicks":[1,2,3]', '"appliedTicks":[1,null,3]')
    writeFileSync(path, changed)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(f => f.details?.some(d => d.check === 'record:appliedTicks-contract' && d.message.includes('appliedTicks[1]'))))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appliedTicks with negative integer fails and identifies position', () => {
  const dir = tempFixture('tick-negative')
  try {
    const path = join(dir, 'round-1', 'events.ndjson')
    const changed = readFileSync(path, 'utf8').replace('"appliedTicks":[1,2,3]', '"appliedTicks":[1,-2,3]')
    writeFileSync(path, changed)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(f => f.details?.some(d => d.check === 'record:appliedTicks-contract' && d.message.includes('appliedTicks[1]'))))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appliedTicks with non-integer fails and identifies position', () => {
  const dir = tempFixture('tick-non-integer')
  try {
    const path = join(dir, 'round-1', 'events.ndjson')
    const changed = readFileSync(path, 'utf8').replace('"appliedTicks":[1,2,3]', '"appliedTicks":[1,2.5,3]')
    writeFileSync(path, changed)
    const report = verifyEvidenceDir(dir)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(f => f.details?.some(d => d.check === 'record:appliedTicks-contract' && d.message.includes('appliedTicks[1]'))))
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
