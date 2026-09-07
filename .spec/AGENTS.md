# 项目中心文档

本项目使用 [LumioAgentSpec](https://github.com/LumioGames/LumioAgentSpec) 插件提供的调度与编码规程。
**通用规程(调度核心 / 编码约定 / 交回物格式 / 宿主差异)由插件在每次会话注入,本文件不复述**——这里只写本项目独有的东西。

## 项目是什么

游戏「示例」——Lumio 引擎的参考实现，也是新游戏的模板仓。C# (net10.0 + netstandard2.1) 玩法程序集 + Node 端到端启动器。

- **只做十四步链路**：登录 → 起服 → 进房 → 体素地图 → 入场 → 跑动 → 聊天 → 挖掘 → 储量 → 变空气 → 掉矿 → 拾取 → 存档 → 重启恢复。需求真值在架构仓 `.spec/knowledge/features/sample.md`。
- **不做**：伤害、死亡、重生、AI、胜负、美术、性能验收。战斗面归炸弹人切片。
- **不复述公共契约**：ABI / wire / 设计概要的唯一事实源是架构仓 `LumioGameEngine`。
- **红线：clone 即编译。** 禁止 `ProjectReference` 到任何私有仓源码路径；引擎依赖只经公开包。解析不到时必须显式报错，不许静默降级。

## 收口门槛

```bash
dotnet build LumioSample.slnx
dotnet test  LumioSample.slnx
```

碰 `integration/` 再加：

```bash
node --test integration/
```

**「运行了零个测试」不算通过**——CI 用 `--minimum-expected-tests 1` 把它判为失败（退出码 9）。

## 项目专属约定

只写与插件通用规程**不同或更严**的部分：

- **本仓是教学材料**，可读性是一等要求。宁可多写一行注释解释「为什么这么做」，也不要留下需要读者自己推断的巧妙写法。
- **不留死配置。** 例：`Directory.Build.props` 在 csproj 顶部导入，在那里写依赖 csproj 属性的 `Condition` 永远不成立——目标框架一律写在各自 csproj 里。
- **确定性优先。** 任何随机都要可复现（固定种子 + 自带 PRNG，不用 `System.Random`，它的实现跨版本可变）。
- **不为示例往引擎加专属原语。** 缺能力就回架构仓提需求，不在本仓造替代品。

## 知识与决策

- 规范与功能记录:[`knowledge/README.md`](knowledge/README.md)(导航)
- 决策唯一落点:[`decisions/`](decisions/README.md)(ADR,不改写、只新增取代)
- 实现计划:[`plans/`](plans/README.md)(历史记录,日期前缀、不设索引)
- 离线任务卡:[`tasks/`](tasks/README.md)(无内置任务工具的宿主用)
