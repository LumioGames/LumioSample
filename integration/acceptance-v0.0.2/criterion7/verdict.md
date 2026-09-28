# 判据 7 · 两轮同底图同结果 —— **PASS**

真值来源：`node Tools/verify-evidence.mjs --dir verify`（ADR-125）——对**入仓证据**重跑判定
exit 0、`"ok": true`（见 `verify/verify-evidence.out`）。

- 两轮：`rounds-meta/round-late{2,3}-observer-raw.ndjson`（同账号 `AcctDetV21` / 观察者
  `AcctDetV2Obs`、同底图 sha `26c8115e…`、各自独立 DS 新进程与全新存档；`derive-rounds`
  报 `factsHold=true`：存活 3 脉 × remaining 6、oreCount 18 = 授权 4 脉 − tour 挖穿 1 条，
  与步骤 14 玩法断言 veins==3 / oreDrops==0 交叉核对）。
- `eventOrder`：收录类别逐位相等，各 587 条（verify-evidence 的 compare 未报任何差异）。
- `appliedTicks`：仅格式校验（非负、单调、与 eventOrder 等长），不做两轮逐位比较（ADR-125）。
- 十四步：两轮 launcher verification.json 均 `status=PASS`（`rounds-meta/*-launcher-verification.json`）。
- 清单外新类别：判定器未报（收录/排除清单具名于 `Tools/verify-evidence.mjs`）。
- 未覆盖/未改写旧目录：`integration/determinism/det-verify/` 原样未动。

## 过程注记（如实）

1. **入场对齐是本机主要难点**：观察者入场 tick 有 ±百毫秒竞争（先跑 4 对「全新 Platform ×
   两轮」全部差 1–5 tick，工具建议整对重跑）。最终采用 step03 门控 + 同对共享 Platform +
   预热注册后连续多轮、取首 tick 相同的两轮（late-2/late-3，tick=4）配对。编排进仓：
   `run-det-round.mjs`（含重试环）。
2. **规格张力（记录给 ADR-125 跟进）**：任务口径「两轮独立初始数据（新 Platform 库）」与
   `IdentityComponent.colorHue = StableAccountHue(platform accountId)` 相遇时，全新 Platform
   给同一登录名发不同 acct id → 两轮 hue 不同 → eventOrder 必在 hue 一位分叉。仓内已提交的
   通过先例（`integration/determinism/det-verify`）同为两轮共用 Platform。本轮按先例执行
   （世界独立性 = 每轮全新存档/DS 进程），并在此明确记录该张力。
