# R-00588 入仓证据的每账号准入计数 (2026-09-26)

统计源:两轮入仓的 `launcher/bot-1/admission-events.ndjson` 与 `launcher/bot-group-*/admission-events.ndjson`
(逐行计数;`ticket_accepted` = 该账号拿到票并被 DS 接纳,是 verify-rounds.mjs 的 admitted 派生源)。

## round-1

| 账号 | ticket_accepted | handshake_accepted | 其他账号行 |
|---|---|---|---|
| AcctWq01 (bot-1) | 1 | 1 | 0 |

bot-1 的文件共 3 行:process_up(host) + handshake_accepted(AcctWq01) + ticket_accepted(AcctWq01)。
bot-group-1..5(每组 20 账号)的 admission-events.ndjson 各只有 1 行 process_up(account=host),
**没有任何账号行**——组内 100−1=99 个账号在入仓证据里准入计数为 0(无记录)。

## round-2

| 账号 | ticket_accepted | handshake_accepted | 其他账号行 |
|---|---|---|---|
| AcctWq01 (bot-1) | 1 | 1 | 0 |

与 round-1 完全同形:bot-1 三行,bot-group-1..5 各只有 process_up(host) 一行,0 行账号行。

## 如实说明

- 入仓证据里唯一出现 ticket_accepted 的账号是 `AcctWq01`(bot-1,tour 账号),两轮各 1 次;
  verify-rounds 的 `ticket_accepted bot dirs 1 != 100` 失败项即由此而来,与本表一致。
- 组宿主只有 started 行、没有账号行,是第 41 名玩家入场即 DS runtime tick failure(README)
  的另一面:组内账号未及留下 connected/admitted 记录。**「入仓证据里没有」不等于「这些账号被拒」**。
- DS 侧逐账号的 host.admit 轨迹在各轮 `launcher/ds-boot-1/*.log`;该目录本轮未入仓
  (原始日志在操作侧 .run,将补入),补齐前组内账号的准入以 DS 侧日志为准。
