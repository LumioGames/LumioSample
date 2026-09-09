# 0002 · sibling 模式调用 Runtime 生成器并对齐 SDK 包分析器豁免

- 日期:2026-09-09
- 状态:生效

## 背景

NuGet / 外部 clone 靠 SDK 包的 `.props` / `.targets` 跑 `gen-declarations` 并在生成器开启时豁免 CA1051 等。sibling（`LumioRuntimeRoot`）原先只注入 Ecs / Replication 的 `ProjectReference`，不跑生成器。第一个 `partial` 组件会 CS8795；引擎要求的 `public Sync<T>` 字段会被本仓 `TreatWarningsAsErrors` 判成 CA1051。

消费方 csproj 不得再抄一份 `NoWarn`（包 props 是 nuget 路径的唯一落点）。也不能增加第四条 SDK 解析路径。

## 决策

1. sibling 闭合加上 Gas 工程（Ability / Effect / Attribute 在该程序集）。
2. sibling 只 import Runtime 仓内的 `Lumio.Tools.GenDeclarations.props`（默认打开生成、排除 `generated/**`），再 `dotnet build` 生成器工程并 `dotnet exec`，与 SDK targets 同一调用形。
3. 分析器豁免写在 `Directory.Build.targets` 的 sibling + generate 条件里，不写进 `Lumio.Sample.Gameplay.csproj`。条目与 SDK 包 props 对齐。
4. 默认按 server 侧编译，排除 `*.Client.cs`。这不是新的解析路径。

## 后果

内部 CI（sibling）与外部 clone（nuget）都能编到第一批实体。生成物与源码一起提交，不得手改。
