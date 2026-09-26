# 判据 7 两轮判定记录 (初判 2026-09-26T00:51:55+08:00 · 按 ADR-125 重判 2026-09-26)
- 两轮:独立进程、独立初始数据、同底图、同账号(AcctDetD,游走/入场种子一致)
- 底图身份:baseMapSha256 `26c8115efd044496ad3132fa98c0608c02a1b0edbf5e32049b2bb9f116414df2`
  = sha256(`Server/Assets/Maps/sample.voxel`,LF 归一后与原字节同值);该文件头
  `rootIdentity` `4781b611bae8f7039edd7146dcae416d32c574a865acf476ca21af113eb3e2da`;
  两轮 observer-raw.ndjson 的 recorder.start 行携带同值,与文件哈希互相印证
- 判定依据:ADR-125(只比事件先后顺序 + 终态世界;appliedTicks 降为格式检查;结论只有 PASS/FAIL)
- eventOrder:收录类别(entity-create/entity-field/entity-destroy)655/655 逐位相等(0 分歧)——
  世界事件序列跨进程确定性成立;排除类别 rpc-delivery(消息投递,不改世界)每轮 2 条,
  判定器具名跳过,不参与顺序与条数比较
- 终态:两轮 world.json 逐格+矿石数完全一致(3 vein×6, oreCount 18);步骤 14
  SampleRestoreVerifyScenario(内含 veins==3/oreDrops==0 断言)两轮均 passed
  (det-round-N/launcher/bot-verify/result.ndjson)
- appliedTicks:按 ADR-125 决策 2 只查格式——每轮 657 条(655 世界事件 + 2 rpc)全部非负、
  单调不减、与 eventOrder 逐条成对,检查通过。历史差帧记录:605/655 存在 ±1..28 tick 偏移,
  589 处为 tour bot 自身 LogicTransform(客户端帧时钟相位),16 处为其下游;该偏移不再参与
  两轮比较,保留作背景(机器人按本机时钟发操作,帧号差测的是机器人时钟,不是引擎)
- 判定器:Tools/verify-evidence.mjs(ADR-125 改造后),报告 det-verify/report.json `ok=true`
- **判定:PASS**
