#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILES, parseCsv } from './weak-network-analysis.mjs';

const number = (n) => Number.isFinite(n) ? n.toFixed(2) : '未观测';
const quartet = (distribution) => ['p50', 'p95', 'p99', 'max'].map((p) => number(distribution[p])).join(' / ');

export function renderReport(root, comparisonRoot = null) {
  const profiles = Object.keys(PROFILES).map((profile) => {
    const summary = JSON.parse(readFileSync(join(root, profile, 'summary.json'), 'utf8'));
    const run = JSON.parse(readFileSync(join(root, profile, 'run.json'), 'utf8'));
    if (summary.status !== 'MEASURED' || run.status !== 'MEASURED') throw new Error(`${profile} is incomplete; no final transport conclusion can be generated.`);
    return { summary, run };
  });
  const failed = profiles.slice(0, 4).filter(({ summary: s }) => s.adjusted.p99 > 150 || s.perBot.some((b) => b.stalls_per_minute > 1));
  const cut = profiles.at(-1).summary;
  const comparisonNeeded = profiles.some(({ summary: s }) => s.nagle.server.tcpNoDelayFalse || s.nagle.bot.tcpNoDelayFalse);
  const comparisons = comparisonNeeded ? ['A', 'C'].map((p) => {
    if (!comparisonRoot || !existsSync(join(comparisonRoot, p, 'summary.json'))) throw new Error(`TCP_NODELAY=false observed: comparison ${p} is required from the unmerged control branch.`);
    const result = JSON.parse(readFileSync(join(comparisonRoot, p, 'summary.json'), 'utf8'));
    const run = JSON.parse(readFileSync(join(comparisonRoot, p, 'run.json'), 'utf8'));
    if (result.status !== 'MEASURED' || run.status !== 'MEASURED' || result.nagle.server.tcpNoDelayFalse || result.nagle.bot.tcpNoDelayFalse) throw new Error(`Comparison ${p} did not prove TCP_NODELAY=true at both ends.`);
    return result;
  }) : [];
  const lines = [
    '# WebSocket 弱网实测', '',
    failed.length ? `按本轮参考判据，最早超标的是 ${failed[0].summary.profile} 档；详细差值如下，传输层保持 WebSocket。`
      : 'A–D 四档均未超过本轮输入确认与卡顿参考值；切网恢复结果单列如下，传输层保持 WebSocket。', '',
    '## 四档结果', '',
    '| 档 | 单向附加延迟 / 丢包 | 输入确认 p50 / p95 / p99 / 最大 ms | 减去名义 RTT 后 p50 / p95 / p99 / 最大 ms | 未确认 / 已发送 | 最差 Bot 卡顿次/分钟 | 总卡顿 ms | 断线 | tick p99 ms |',
    '|---|---|---|---|---|---:|---:|---:|---:|',
  ];
  for (const { summary: s } of profiles.slice(0, 4)) {
    const p = PROFILES[s.profile];
    lines.push(`| ${s.profile} | ${p.delay}±${p.jitter} ms / ${p.loss}% | ${quartet(s.input)} | ${quartet(s.adjusted)} | ${s.unconfirmed} / ${s.sent} | ${number(Math.max(...s.perBot.map((b) => b.stalls_per_minute)))} | ${number(s.perBot.reduce((sum, b) => sum + b.stalled_ms, 0))} | ${s.disconnects} | ${number(s.server.tickP99Ms)} |`);
  }
  lines.push('', '输入从原连接接受编码后的 InputCommand 起计，到 Bot owner 取到服务器 WorldChange 中的 AppliedInputSequence 止；包含发送队列与 owner 取件等待。累计确认逐条对应 account/generation/sequence；停止输入后保留 10 秒确认尾窗，未确认输入始终保留分母。扣除的是名义 RTT，不是逐包实测注入值，负数保留。', '',
    '卡顿是更新间隔超过 250 ms 的一次连续区间，表中总时长只计超过 250 ms 的部分；原始 stalls.csv 同时保留完整 gap 和结束时尚未恢复的区间。每个 Bot 的次数、持续时长与确认分布见 per-bot.csv。', '');
  for (const { summary: s } of failed) lines.push(`- ${s.profile}：扣除延迟后 p99 相对 150 ms 的差值 ${number(s.adjusted.p99 - 150)} ms；最差 Bot 相对每分钟 1 次的差值 ${number(Math.max(...s.perBot.map((b) => b.stalls_per_minute)) - 1)} 次/分钟。`);
  const reconnect = cut.recovery.filter((r) => !r.remained_active);
  lines.push('', '## 切网', '', `10 条已建立 TCP 连接双向丢包约 5 秒。未离开 Active：${cut.recovery.filter((r) => r.remained_active).length}/10；恢复后 10 秒内收到更新：${cut.recovery.filter((r) => r.update_within_10s).length}/10。真正离开 Active 的连接中，重连回 Active ${reconnect.filter((r) => r.active_ms !== null).length}/${reconnect.length}，其中恢复后 10 秒内 ${reconnect.filter((r) => r.reconnected_within_10s).length}/${reconnect.length}。保持 Active 不计作重连成功；恢复前以新 tuple 重连 ${cut.recovery.filter((r) => r.recovered_before_restore).length} 条。`, '',
    '| Bot | 始终 Active | 恢复至 Active ms | 恢复至首个更新 ms |', '|---|---|---:|---:|');
  for (const r of cut.recovery) lines.push(`| ${r.account} | ${r.remained_active} | ${number(r.active_ms)} | ${number(r.first_update_ms)} |`);
  lines.push('', '## Nagle', '', 'LD_PRELOAD 审计库只读取真实 connect/accept/setsockopt 后的 TCP_NODELAY，不读写报文。端口过滤后的逐 socket 值在 nagle.csv。');
  for (const { summary: s } of profiles.slice(0, 4)) lines.push(`- ${s.profile}：DS true/false=${s.nagle.server.tcpNoDelayTrue}/${s.nagle.server.tcpNoDelayFalse}，Bot true/false=${s.nagle.bot.tcpNoDelayTrue}/${s.nagle.bot.tcpNoDelayFalse}。`);
  for (const s of comparisons) lines.push(`- ${s.profile} 对照（仅未合入对照分支）：输入 p99=${number(s.input.p99)} ms，扣除 RTT p99=${number(s.adjusted.p99)} ms。`);
  if (!comparisonNeeded) lines.push('- 两端观察值均为 true，按计划无需 Nagle 对照。');
  lines.push('', '## 服务器与原始证据', '', 'tick p99 来自 DS 的 LUMIO_TICK_SAMPLE_DIR 原始相位 CSV：每 tick 完整 13 相求 elapsed_nanos 之和再取 p99，时钟是 NativeCore clock_now。只选择本测量窗收到的 WorldChange 覆盖的 tick 区间。100 个独立 Bot 进程的发送跨度和每 10 秒发送/拒绝/确认/更新数量见 per-bot.csv、activity.csv；真实非 Active 的静默单列。DS RSS、TCP Send-Q、宿主可用内存与 load1 每秒从 Linux /proc 与 ss 读取。', '');
  for (const { summary: s, run } of profiles) {
    const memory = parseCsv(readFileSync(join(root, s.profile, 'raw/memory.csv'), 'utf8')).map((r) => +r.rss_bytes);
    lines.push(`- [${s.profile} 原始数据](${s.profile}/raw/)：100 Bot × ${s.durationSeconds} 秒，RSS 起/峰/末=${memory[0]}/${Math.max(...memory)}/${memory.at(-1)} bytes，Actions run ${run.githubRun} attempt ${run.githubAttempt}。引擎身份与全部源码提交在 engine-manifest.json/run.json；TCP 注入配置及计数在 netem-start/end.txt。`);
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2]);
  writeFileSync(join(root, 'report.md'), renderReport(root, process.argv[3] ? resolve(process.argv[3]) : null));
}
