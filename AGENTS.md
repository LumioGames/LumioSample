<!-- lumio:init -->
## LumioAgentSpec

本项目使用 LumioAgentSpec 插件的调度与编码规程。项目自身的定位、收口门槛与知识导航见:

- [`.spec/AGENTS.md`](.spec/AGENTS.md) —— 项目中心文档(先读)
- [`.spec/knowledge/README.md`](.spec/knowledge/README.md) —— 知识导航
- [`.spec/decisions/`](.spec/decisions/README.md) —— 决策唯一落点(ADR)

> 通用规程与硬红线由插件在每次会话注入(Claude Code);无此机制的宿主请主动读取上述文件。

## 引擎只从 `Engine/` 来（ADR-123）

- `Engine/` 是只读子模块（公开仓 `LumioEngineRelease` 的一个 tag）：编译的 SDK 包、`lumio-ds`、Bot 宿主、旁观页引擎零件、`process-tools.mjs`、Platform compose 都在里面。**不得**再引入同级仓路径、指向散落产物的环境变量或任何私有仓检出；缺什么向发布物提需求，不从私有仓拷文件进本仓。不在 `Engine/` 里改或提交任何文件。
- 前置条件：git、.NET SDK（`global.json`）、Node.js 22、Docker。clone 用 `--recursive`；漏了就 `git submodule update --init --depth 1 Engine`。
- 升级引擎：`node Tools/update-engine.mjs <版本>`，再提交子模块指针。
- 引擎组内部、首个 tag 之前或要验引擎 `main`：在架构仓跑 `node eng/pack-release.mjs --from-main --out <本仓>/Engine` 填 `Engine/`（同一布局、同一条路，不另开同级路径）；这样填的内容已被 `.gitignore` 挡住，不得当普通文件提交。

收口门槛：`dotnet build LumioSample.slnx`；`dotnet test LumioSample.slnx -- --minimum-expected-tests 1`；`node --test Tools/verify-evidence.mjs`（显式测试文件，至少 1 个测试）；`node eng/spec-lint.mjs`。前三项需要 `Engine/` 有内容。
