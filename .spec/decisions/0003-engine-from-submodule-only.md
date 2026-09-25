# 0003 · 引擎只从子模块 Engine/ 取，删掉 sibling 与 nuget 两条解析路径

- 日期:2026-09-25
- 状态:生效

## 背景

本仓原先有两条引擎解析路径：内部 sibling（按同级 Runtime 检出注入 `ProjectReference` 并现跑生成器，见 [0002](0002-sibling-generate-matches-sdk-pack.md)）与外部 nuget（等一个从未发布的 nuget.org 包）。外部 clone 因此编不过、跑不起来；运行侧还要二十多个环境变量指向私有仓的产物。架构仓 ADR-123 定了引擎发布物仓 `LumioEngineRelease`：一个 tag 一整套二进制，游戏仓经只读子模块 `Engine/` 钉版本。

## 决策

1. `Lumio.Engine.SDK` 只从 `Engine/sdk/` 解析，版本读 `Engine/manifest.json#version`；`NuGet.config` 以 package source mapping 把这个包限定到该目录。没有 sibling、global-packages 或 nuget.org 的第二条路。`Engine/` 为空即 `LUMIO_SDK_UNRESOLVED`，并打印 `git submodule update --init --depth 1 Engine`。
2. 启动器、旁观页、Bot 场景、Host 用例与压测工具的引擎一半全部取自 `Engine/`（`server/<rid>/`、`bot/<rid>/`、`web/`、`tools/`、`platform/`），指向散落产物的环境变量删除；解析集中在 `Tools/engine-release.mjs` 与 `Server/Tests/EngineRelease.cs`。
3. 生成器与分析器豁免只由 SDK 包的 props/targets 提供，0002 的 sibling 接线随之删除。
4. 升级引擎只经 `Tools/update-engine.mjs <版本>`：新版自带的 `verify-release.mjs` 通过才切指针。

## 后果

外部机器 `git clone --recursive` 即可编译、运行（钉号后）。内部开发者要验引擎 `main` 时，用架构仓 `pack-release --from-main` 填 `Engine/`，走同一布局，不再有同级源码路径；因此也不能再对着 Runtime 源码改一行立刻编 Sample，需先出一份临时发布物。
