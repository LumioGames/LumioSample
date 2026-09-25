# 判据 7 两轮判定记录 (2026-09-26T00:51:55+08:00)
- 两轮:独立进程、独立初始数据、同底图()、同账号(AcctDetD,游走/入场种子一致)
- eventOrder:655/655 逐位相等(0 分歧)——世界事件序列跨进程确定性成立
- 终态:两轮 world.json 逐格+矿石数完全一致(3 vein×6, oreCount 18);步骤14玩法断言 veins==3/oreDrops==0 两轮均 passed
- appliedTicks:605/655 存在 ±1..28 tick 偏移;589 处为 tour bot 自身 LogicTransform(客户端帧时钟相位),16 处为其下游(挖掘/矿石/耐力);服务端权威事件本身无错序
- shipped 判定器 verify-evidence 如实 FAIL(applied-tick-compare);字面逐位相等需 tick-locked 输入源(tour bot 帧锁或输入重放),当前栈无此模式——记为设计缺口,见交回报告
- 判定:eventOrder+终态 PASS;appliedTicks 字面门 PARTIAL(结构性不可达,非实现回退)
