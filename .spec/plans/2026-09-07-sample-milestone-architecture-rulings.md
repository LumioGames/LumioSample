---
status: pending
---

# 2026-09-07 「示例」里程碑架构裁决流水

> 讨论形式：引擎架构师逐题向 Owner 摆窟窿，Owner 逐题拍板。每一题都先在仓里实查代码再谈，结论附 `文件:行`。
> 决策正式落点是 ADR-077（架构仓 `.spec/decisions/ADR-077-sample-milestone-architecture-rulings.md`）；本文是完整的流水（为什么、依据、怎么做、怎么排）。需求真值 `sample.md`（架构仓 `.spec/knowledge/features/sample.md`） 按 §4 清单修订。
> **本文是架构仓 `LumioGameEngine/.spec/reviews/2026-09-07-sample-milestone-architecture-rulings.md` 的副本**（Owner 要求样例仓也保存一份），两份内容一致，以架构仓为准；文中「本仓」指架构仓。

## 0. 一页摘要

1. **轨 A「不等引擎卡的那半」只剩两张**（S-7 对账脚本、S-9 LumioGame 导航）。其余七张都要等引擎或平台的接线；S-2（SDK 打包）是所有实现卡的真 wave 0。
2. **最大的三个空洞都不在原来六张引擎卡里**：DS 怎么装载用户玩法（S-2 契约空）、DS 侧体素那道门（`lumio-ds` 只认 `runtime-only`）、配表的 typed Reader 与装载器（M8 / M9 都不存在）。
3. **客户端形态定了**：C# Bot 执行十四步；浏览器是最终核心验收场景（真玩家），残版可先只用 Bot 收口；体素进浏览器要先调研（Rust→wasm32 今天没有任何 crate 证明过能编）。
4. **一切按正规做、不留顶替**：移动是 GAS Ability；Bot 是 Client 通用宿主 + 游戏交场景；一个体素世界一个主人；范围判定用引擎唯一一份空间索引；Local Entity 不加声明、按文件边判定；底图是快照文件不是程序化生成。
5. **样例前置约 20 张卡、横跨 6 仓 5 Room**，整理成 wave 0–3 挂 R-00517 引用边，由主 loop 统一管；可行性盘点卡缩到三件事。
6. **（2026-09-07 补，§2.14）** 外部审查复核又查出四条：**非 Windows CoreCLR 宿主恒定失败且无人认领**（Linux / macOS 上 DS 装载不了任何 C# 玩法，比 S-2 更靠前的 wave 0）、Windows integration 红是 Hello 关闭码另一回事、M8 已有上游卡 R-00325 别重建、装载兜底与存档切点两处隐患。同时**更正本文一处归因**：integration 两个红都不在 LumioClient，R-00495 不是根因。复核带出的两条外部性问题 Owner 当日已裁：**判据 2 第一阶段是内部验收**（Platform 镜像未公开，发镜像排 S-16）、**公开使用面随 SDK 包发**（私有架构仓不作外部手册）。

## 1. 方法与真值优先级

- 真值顺序：仓里的代码与实跑输出 > `engine/wire` / `engine/abi` 契约 > 生效 ADR > 设计文档 > 任务卡正文。设计文档说的是「应该有什么」，不是「已经有什么」。
- 实查范围：`LumioGameEngine`（本仓）、`LumioServer`、`LumioGameRuntime`、`LumioClient`、`LumioVoxelEngine`、`LumioNativeCore`、`LumioConfig`、`LumioPlatform`、`LumioGame`、`LumioSample` 本地工作区（只读），行号以 2026-09-07 各仓 HEAD 为准。
- 世界模型四问（`rules/system.md`（架构仓 `.spec/rules/system.md`））与「引擎归引擎、玩法归玩法」「如无必要勿增实体」「AI Agent 友好」是每题的判据。

## 2. 十三组裁决

每组四段：**结论** / **事实依据** / **定了什么** / **落卡**。

### 2.1 DS 怎么装载用户改完的 C# 玩法（S-2 契约）

- **结论**：装载机制代码里已有，但「玩法编译时依赖的 Runtime DLL 从哪来」没人定，S-2 卡面在这里是空的。
- **事实依据**：`LumioServer/modules/process/src/ds.rs`：`lumio-ds --config server.json`，`clr` 段含 `engine_native / hostfxr / runtime_config / assembly / entry_type / entry_method / replication_assembly / ecs_assembly / registry_assembly`；`LumioServer/eng/server.example.json` 里 `registry_assembly: managed/YourGame.Server.dll`。`entity-chat-host/.../HostEntry.cs:131-145`：按路径 `Assembly.LoadFrom` 用户 DLL，从 `replication_assembly` / `ecs_assembly` 所在目录按 `Lumio.GameRuntime.*.dll` 通配加载同级程序集（`:182`），再找 `EcsRegistry.Current` 或扫描生成的注册表子类。本仓 `engine/managed/Lumio.Engine.SDK/Lumio.Engine.SDK.csproj` 只引用 `Lumio.Engine.NativeLoader`，不含 Runtime 的 Ecs / Replication。`gen-declarations` 只在 `LumioGameRuntime/Directory.Build.targets:32,45` 里跑过，从未出过仓；`LumioGame` 也不调用它（其 `ChatComponent` 来自引用 Runtime 的样例工程）。
- **定了什么**：DS 包不带任何 Runtime DLL；`server.json` 三个路径（`replication_assembly` / `ecs_assembly` / `registry_assembly`）全指向用户 `dotnet build` 出来的 `bin/` 目录；Ecs / Replication（后续 Gas / Coordination）随 SDK NuGet 包进用户 bin，只此一份；`gen-declarations` 以 MSBuild 任务随包分发。理由：一处维护、一份版本，排错只看一个目录。
- **落卡**：S-2（R-00519）卡面重写；顺带删 `Lumio.Sample.Gameplay.csproj` 的 `netstandard2.1` 目标（注释写着 Unity / HybridCLR，已降为候选，浏览器走 .NET wasm 也是 net10.0）。

### 2.2 DS 侧体素那道门与存档「快门线」

- **结论**：`lumio-ds` 只认 `world_profile = "runtime-only"`，第 5 / 10 / 11 / 14 步全过不了这道门；核心不是「读档 / 删档」，而是「谁按快门」——体素的 capture / restore 在 VoxelEngine 里都有，但 ABI 上没有这两个函数，Runtime 够不着，DS 只能写 `voxel: None`。体素代码零改动。
- **事实依据**：`ds.rs:41-42` 拒收其他 profile；`save()`（`:148-156`）固定 `voxel: None`；`boot()`（`:178-184`）见带体素的检查点直接拒绝恢复。`LumioServer/Cargo.toml` 无任何 voxel crate；本仓 `engine/native/modules/sdk-native/Cargo.toml` 已链五个 voxel crate，`sdk-native/src/voxel.rs:119` 自建了世界（角色写死 `Authority`）。`LumioVoxelEngine/crates/lumio-voxel-world/src/port/adapter.rs:103/209/227` 有 `create_world / capture / restore`；`engine/abi/native-abi.json` 120 个符号里只有 `block_read_* / block_write_* / raycast / sweep / overlap / residency_pin_* / section_delivery / section_revision_query / timer_* / clr_host`，没有 capture / restore。ADR-070（架构仓 `.spec/decisions/ADR-070-persistence-container-ownership.md`） 已裁「体素改动层切片归 Runtime」；`engine/wire/persistence-container-v1.json` 已有 `voxelParticipant` / `baseMapReference`。`.spec/plans/2026-09-07-lumioserver-24h-bugs-fix-prompts.md:562` 明写「不要求立刻交付 WAL / baseMap / Voxel」。
- **定了什么**：三处接线、零行体素代码——① 本仓 ABI / SDK 加 voxel `capture` / `restore` 两槽；② Runtime 在提交点切时顺手拍体素那半；③ `lumio-ds` 加 `runtime+voxel` profile：开机建 native 体素世界、`boot` 把世界句柄交给 Runtime、`save()` 在同一提交屏障取两份切、`boot()` 恢复两份。样例是 ADR-070 首个消费方，做完顺手转 Accepted。删档 = 丢改动层回底图（save-load M5 单层 diff），删目录即可，不立卡。
- **落卡**：架构仓 1 张（ABI 两槽）、Runtime 1 张（体素切进提交点快照）、Server 1 张（`lumio-ds` 体素 profile + 双存 / 双恢复）；三张写成 S-12 / S-15 前置。

### 2.3 配表：M8 / M9 不存在；数据必须是文件；JSON 只解析一次

- **结论**：S-10 不是「无前置、可最先做」，是 BLOCKED。编译这一头能跑，typed Reader 生成器（M8）和 DS 开机装载器（M9）都不存在。
- **事实依据**：在 `LumioConfig` 实跑 `python3 tools/lumio_config.py export --out <scratch>` → `export: OK (3 table(s))`，产出 `server/skills.json`（`rows[]` 已按 schema 带类型）与带三重指纹的 `manifest.json`；`src/lumio_config/` 无任何代码生成模块；`LumioConfig/README.md` 明写「不实现运行时装载器」。`LumioGameRuntime/modules/config/src/Lumio.GameRuntime.Config/`：`IGeneratedConfigArtifactPort.Submit(GeneratedConfigArtifactView)` 等着有人把 export 目录读成视图；`ConfigTableReader.TryGet(key, column)` 返回 `ConfigValueView(CanonicalText)`——字符串，`ConfigSnapshotCell(Column, CanonicalText)` 每格存文本；无文件装载器。`LumioServer` HostEntry 不读配表，`server.json` 没有配表目录，`content_fingerprint` 手填。`.spec/plans/2026-09-01-lumioconfig-parallel-dispatch.md:93` 明写「M9 本轮暂缓」。
- **定了什么**：① M8 归 LumioConfig（导表器顺手生成 C# typed Reader），**生成的 C# 只含类型与读法，不含数值**；② M9 归 Runtime + Server HostEntry：`server.json` 加配表目录，读 manifest → Submit → Stage → 首帧激活，`content_fingerprint` 从 manifest 读不再手填；③ **数据必须是文件**（现在 JSON、阶段 3 换二进制内芯）——理由是本项目自己的三条要求：V 端由 Rust 读（voxel.md 材质类表来源即同一份配表）、M9 / M10 的 reload / 回放钉版 / 浏览器分包、内容指纹按数据算；④ JSON 只在 M9 装载时解析一次，快照存按 schema 生成的强类型，Reader 直接返回类型值，Runtime 现有文本格快照随 M9 改掉；⑤ `server.json`（端口 / 密钥 / 限额）与配表（玩法数值）本就是两套，不算重复。
- **落卡**：LumioConfig 1 张（M8 C# 路）、Runtime + Server 1 张（M9）；S-10（R-00527）改为依赖它们、从 wave 1 挪后；`sample.md` 判据 3「重编重启」改「换文件重启」。

### 2.4 tick 频率一处真值

- **结论**：`server.json` 的 `host.tick_hz` 是死字段，DS 真正的节拍是写死的 10 ms，R-00462 定的 `WorldEntity.TickRate` 宿主又拿不到。
- **事实依据**：`LumioServer/modules/process/src/entity_chat/mod.rs:105,146-147,198` 声明、默认、校验 `tick_hz`，全仓无读取；`entity_chat/host.rs:49` `OWNER_CADENCE_MS = 10`，`:614` `schedule_repeating(TimerMode::TickFrame, 1, 1, DISPATCH_TICK)`；HostEntry `boot` 只回 `Ok()`；`tick.md`（架构仓 `.spec/knowledge/features/tick.md`） §5「频率是游戏配置、随快照入档」；`.spec/plans/2026-09-05-bomber-engine-runtime-cards.md:76` RT-1 定 `WorldEntity.TickRate` 为唯一真值；Runtime 里 `TickRate` 尚无代码（R-00462 未落）。
- **定了什么**：删 `tick_hz` 与常量；HostEntry `boot` 响应带回 `tickRate`（新世界从 WorldEntity 读、恢复从快照读），宿主按它设 owner 节拍。
- **落卡**：R-00462 追加一条验收（boot 响应含 tickRate）；Server 1 张小卡（按响应设节拍、删两处旧值）。

### 2.5 一条命令的真拓扑与客户端形态

- **结论**：「起账号服 + DS + N Bot + 浏览器」这条链今天没有一环接通；S-3 / S-4 让复用的那套指向的是要退役的东西。
- **事实依据**：`lumio-ds` 从没被任何脚本端到端拉起过（`LumioServer/modules/process/tests/config_example.rs` 只校验示例 json；Server 仓 CI 只有 `repository-policy.yml`）。`LumioGame/integration/entity-chat/launcher.mjs` 的 SUCCESS 路径写死 `lumio-entity-chat-replay`（test-harness 专用 bin，固定 100 Bot 剧本进程内跑完），`entity_chat/discover.rs` 要 `LumioServer/account-server/` 的 `lumio-account-server.dll`（ADR-061（架构仓 `.spec/decisions/ADR-061-lumioplatform-repository-and-account-authority.md`） 定整目录删）。`lumio-ds` 只认 allocation 绑定票（`entity_chat/secure.rs`），票只能由 LumioPlatform `POST /api/games/{slug}/launch` 签发（`LumioPlatform/.spec/knowledge/features/lobby-launch.md:33`），该端口（R-00416）未合入，Platform OpenAPI 只有 `/healthz`，且 `PLATFORM_DB_CONNECTION_STRING is required`（PostgreSQL）。`entity_chat/wire.rs:719-741` `upgrade_credential` 只认 `Authorization: Bearer` 或 `lumio-admission.` 子协议前缀；`LumioClient/modules/bot/host/FoundationHostCommand.cs:131-150` 走 `{connectionId}` 首帧的旧附着路径（`requiresMvpChannelAuth: false`），真带票时 `MvpChannelAuth` 发的是 `lumio.mvp.v0, <token>, <nonce>` 三段，对不上。浏览器端 `LumioServer/eng/connect-ds.mjs` 已按 launch 应答接 DS。
- **定了什么**：样例启动器就是 `lumio-ds` 的第一个真 E2E harness，起真拓扑：Platform（账号 + launch，Postgres 走 docker compose）→ `lumio-ds` → N 个 C# Bot 执行、浏览器经 `connect-ds.mjs` 旁观。判据 2 接受 Docker（判据 1 的 `dotnet build` 不受影响）。**客户端形态**：十四步由 C# Bot 执行；浏览器是最终核心验收场景（真玩家），第一阶段（残版）可先只用 Bot 收口，但里程碑「做完」= 浏览器跑通十四步。
- **落卡**：Platform R-00416；Client 1 张「Bot 改 Bearer 载体、删 connectionId 附着」；Server 无新卡；S-3 / S-4 卡面「复用」改「参考」。

### 2.6 轨 A 实情与按 wave 排法

- **结论**：九张轨 A 卡里今天真能派的只有 S-7、S-9；S-2 成了所有实现卡的真 wave 0。
- **事实依据**：S-3 / S-4 等 R-00416 与 Client Bearer 卡；S-5 等 R-00469 读路径与 Server 体素 profile（Runtime 里没有任何 public 体素读接口，`IVoxelWorldPort` 是 `Lumio.GameRuntime.Coordination` 的 internal）；S-6 要先能编译到 Runtime 程序集（S-2）；S-10 等 M8 / M9；S-8 在 S-3~S-6 之后。main 上 integration 连红（tools / managed 绿，integration ubuntu + windows 红）。**归因已更正（2026-09-07 外部审查复核）**：两个红是两个各自独立的宿主级根因——ubuntu 死在本仓 `engine/native/modules/clr-host/src/sys.rs:248-269` 非 Windows `load_clr` 恒返 `InitFailed`（证据包 `server.log`：`create_clr_host failed with status 3 (ClrInitFailed)`），windows 死在 `LumioServer/modules/process/src/server.rs:372` Hello writer 发空 `Message::Close(None)`（1005）与 `eng/dev-run.mjs:119` 断言 `[1000,1001]` 不符；**都不在 LumioClient**。R-00495 仍要修（Bot 要走那条会话链），但不是 integration 红的根因——见 `2026-09-07-sample-external-review-audit.md`（架构仓 `.spec/reviews/2026-09-07-sample-external-review-audit.md`） §2.1 / §2.2 / §3。
- **定了什么**：「示例前置」整理成跨 Room 的 wave 清单，全部挂 R-00517 引用边，主 loop 按 wave 派（见 §3）；「轨 A / 轨 B」改按 wave 说；可行性盘点卡缩到三件事（§5）。
- **落卡**：主 loop 落 Workflow 引用边；卡面文件加 wave 重排说明。

### 2.7 浏览器：最终核心验收；体素进浏览器要先调研；体素只出网格数据

- **结论**：网页端今天只能看到聊天字；浏览器不从判据 2 拿掉，它是最终核心验收场景；体素进浏览器今天没有卡、没有 ADR、没有编译目标。
- **事实依据**：`LumioClient/modules/web/` 只有 hello / chat 两页纯 JS（chat 页 49 行，无画布、不画位置）；`LumioVoxelEngine` 六个 crate 无 wasm32 目标、无 wasm-bindgen；`native-core.md`（架构仓 `.spec/knowledge/features/native-core.md`）:26 明写「同一份 Rust 编 wasm32；今天没有任何 crate 证明过能编」；ADR-067（架构仓 `.spec/decisions/ADR-067-browser-client-prediction-dotnet-wasm.md`） 与 R-00470（AC06「浏览器显示移动 / 纠偏 / 销毁」）只管 Runtime 的 C# 进浏览器；此前唯一的调研 CL-1（`LumioClient/docs/spikes/2026-09-05-spike-runtime-wasm.md`）也是 C# 路线。`voxel.md`（架构仓 `.spec/knowledge/features/voxel.md`） M4：网格生成在体素侧、零拷贝交付、「不把 Section 数据搬过边界让外面算网格」、「不做渲染提交、不管材质与着色器」。
- **定了什么**：① 浏览器是最终核心验收（真玩家），R-00470 与体素进浏览器列为 S-16 前置；② 立一张 Rust→WASM 调研卡（像 CL-1 先 spike）：VoxelEngine 六 crate + NativeCore hfsm / kernel 一起编 wasm32 证明、M4 网格零拷贝交到页面、与 .NET-wasm 的 Runtime 客户端同页共存；结论出体素版 ADR-067；③ **体素只出网格数据，渲染表现归 client**（这正是 M4 的分工；若要让 client 自己从 Section 算网格，那是改 M4，先开 ADR）。
- **落卡**：VoxelEngine 1 张调研 + 契约卡，排 R-00470 之后、S-16 之前。

### 2.8 改名脚本不做；删 `netstandard2.1`

- **事实依据**：`LumioSample` 里 11 个文件、31 处带 `Sample / 示例`；GitHub 模板功能只复制文件不改名；`Lumio.Sample.Gameplay.csproj` 多编一份 `netstandard2.1`（注释「Unity / HybridCLR」）。
- **定了什么**：改名脚本不做、不进任何卡（S-16 发布时若有必要再看）；`netstandard2.1` 随 S-2 重写时删除。

### 2.9 Local Entity：三个「Local」与按文件边判定

- **结论**：世界模型第四类「Local 实体」引擎今天没有这个模式，也没有卡。
- **事实依据**：三个 Local 要分开：① Local Entity = 普通实体，只是不上网、只在客户端本地（挂特效）；② Local Position = 局部坐标（`LogicTransform.cs` 的 `TransformSpace.Local`）；③ Local Server = 本地模式，服务器客户端同进程（Client `LocalEmbedded` 路径、ecs.md 0-11「同进程双端环回」；2026-08-30 存档裁决「网页无 Local 模式」指的是它）。Runtime 里 `Local` 只出现为 ② 与写入原因 `ChangeReason.Local`；`tools/gen-declarations` 无实体模式；ECS 契约卡 0-9（`ecs.md`（架构仓 `.spec/knowledge/features/ecs.md`） §5，含 CS / Local 模式）未开；`World.cs` 全部按 `NetEntityId` 索引（槽位表、创建序、账号索引、Transform 控制器）；R-00466 只产 `IPresentationDiff { Started, Continued, Ended }` 差集不建实体；Bot 的表现适配器是 `NullPresentationSink`。`gen-declarations/SourceModel.cs:108-111` 已按 `.Server.cs` / `.Client.cs` 后缀分边。
- **定了什么**：Local Entity **不加任何声明**——一个 EntityType 只在 `.Client.cs` 里有组件 / 声明，生成器就只把它发进客户端注册表，服务器根本不知道它；客户端自己 `Create`，不发网络号、不进同步 / 视野 / 存档 / 哈希。0-9 卡的实质 = 给 World 加一条「无网络号」的创建路径。R-00466 差集「fx_key 开始」建它、「结束」销毁；Bot 换一个记日志的表现适配器出证据「Local 实体 N 个、上行 0」。
- **落卡**：Runtime ECS 0-9 一张；排 wave 2，与 R-00468 / R-00480 同批（火花只在挖掘时出现，不影响残版收口）。

### 2.10 底图是数据，不是程序化生成

- **结论**：地图由地编 / 编辑器 / Minecraft 导入产出，本里程碑先用最土的办法准备一份；S-1 的程序化 `MapLayout` 生成器方向错，删。
- **事实依据**：`save-load.md`（架构仓 `.spec/knowledge/features/save-load.md`） M1「原始地图是不可变全量快照（格式复用规范快照，零新格式）」；voxel.md M10「检查器只读，永不写回存档——不提供绕过引擎的修改路径」；`LumioVoxelEngine` 无任何离线工具（无 `[[bin]]`）。
- **定了什么**：底图 = 规范快照文件（如 `maps/sample.voxel`），由一次性脚本经 SDK 写格（地板、硬墙、几片矿石）再 capture 生成，脚本与产物一起入库、产物不手改；DS 开机 = restore 底图；玩法首次开档扫矿石格建储量实体并登记引用；之后每次开机 = 底图 + 改动层；判据 7 从「同种子」改「同底图」。底图字节不得手改（M10），只能经引擎写再 capture。地编 / Minecraft 导入不进本里程碑。
- **落卡**：并入 S-5（R-00522）改写：删 `MapLayout`、加底图脚本与 restore 加载。

### 2.11 矿脉「两半拆法」的稀疏引用断了三处

- **结论**：体素引擎里表有了，但 ABI 没有绑定函数、capture / restore 不带这张表、R-00469 没提绑定。
- **事实依据**：`LumioVoxelEngine/crates/lumio-voxel-domain/src/binding.rs`（每 Section 一张「格内偏移 → NetEntityId」稀疏表，策略注入）；`engine/wire/voxel-world-v1.json` `blockEntityBinding` 把不变量、同提交点、损坏语义写全；ABI 120 个符号里含「bind」的只有 `timer_bind_slot`；本仓 `sdk-native/src/voxel.rs:643-645` 只映射了三个绑定错误码；`lumio-voxel-world/src/world/{capture,restore}.rs` 无 binding；Runtime 零处 `BlockEntity`；`.spec/reviews/2026-09-05-engine-repos-progress-assessment.md:145`「M6a … `NetEntityId` 接线归 Runtime（R-00469）」。
- **定了什么**：三处各归各家——本仓 ABI 加绑定 `set / clear / get` 三槽，随 `block_write_prepare` 同批提交；VoxelEngine 一张小卡把稀疏表进 capture / restore（M6a 做完标准本来就写着「放箱子再读档两半同时在」）；R-00469 追加验收「绑定与结构单同提交点」。否掉「引用放实体上」（契约「实体不得绕开该表私自认领坐标」）与「储量塞 BlockState」（system.md 禁体素里存业务数据）。
- **落卡**：架构仓 1 张（ABI 三槽）、VoxelEngine 1 张、R-00469 追加；排 wave 2。

### 2.12 Bot 与「正规方案」六条

- **结论**：Bot 今天只会聊天；十四步里的跑、挖、捡它一个都发不出去；「跑」比原以为的更靠后。Owner 要求一切按正规、可以慢、不留顶替。
- **事实依据**：`LumioGameRuntime/.../WireCodec.cs:14,174` 上行只认 `chat.input / FieldWrite / ServerRpc`；技能输入的 `Activate<T>` 随 R-00468 生成（RT-4 卡）；`movement.md`（架构仓 `.spec/knowledge/features/movement.md`）:17「GAS 接受移动意图」；Client 输入管线通用（`IGameInputMapper.TryMap`、`IBotScenarioDriver.FillSamples(RawInputSample)`），`HeadlessBotHost(session, driver, ingress, hook, timer)` 宿主通用、驱动注入，tick 是客户端 Runtime 自己那份（`ClientTimerManager` 挂 NativeCore `tickFrame`）；但 `BotDriverContext` 只有一个 tick 号，驱动看不见世界，现有 `DeterministicBotDriver` 每帧发一个零样本；本仓 `engine/managed/Lumio.Engine.NativeLoader/VoxelFacade.cs` 有 Raycast / Sweep / Overlap，`NativeEngineLease.CreateVoxelWorld(nint world)` 包一个**给定**句柄，Runtime 与 HostEntry 零处引用 NativeLoader；NativeCore `lumio-spatial`（AABB R-tree）零消费者、不在 ABI，`ds-server.md`（架构仓 `.spec/knowledge/features/ds-server.md`） M5 / 0-5 卡本来就要为视野粗筛在 root 表增槽；ds-server.md:60「体素同步是独立自治的子系统，三条接缝共享：同一条连接（体素大件有带宽配额）、同一个提交点、同一个整帧作废单元」；`voxel-world-v1.json` 只定了送达入口信封 `sectionDelivery`，没定 Section 在连接上的帧与配额；`lumio-ds` 零体素派发；`.spec/plans/2026-09-06-client-w0-card-and-kickoff.md:117`「Client Chunk 三态 / RTT 校正（R-00296 / 298）不开：Stage 0 不下发」；`sdk-native/src/voxel.rs:121` 建世界角色写死 `Authority`、pin 预算无上限。
- **定了什么**（六条，全按正规）：
  1. **跑动 = GAS Ability**，输入包由 R-00468 生成的 `Activate<T>` 上行；不直写坐标。S-6 拆成「入场 + 聊天」（wave 1）和「跑动」（wave 2）。
  2. **Bot = Client 通用宿主 + 游戏交的场景**：Client 立卡——CLI 按名装载玩法 + 场景程序集；驱动上下文加只读 World 视图与输入词汇表（来自生成注册表）；内置按 Seed 的随机驱动（枚举游戏声明的技能乱按）；场景 = C# 类 + 断言（状态哈希 / 表现差集）；**不加脚本语言**。样例只交输入映射（放两端共用的玩法程序集里）和场景类。
  3. **物理一个世界一个主人**：Rust 宿主开机建体素世界（restore 底图），`boot` 交句柄，Runtime 用 `CreateVoxelWorld(句柄)` 包一层给技能提供扫掠 / 射线 / 重叠端口；并进 2.2 的 Server 卡与 R-00469 验收。
  4. **范围判定用引擎唯一一份实体空间索引**：`lumio-spatial` 经 root 表增槽，ECS 包成 `World.QueryAabb`，视野粗筛与玩法的捡拾 / 近战 / 触发区共用；排最后一波，样例的「捡」等它。
  5. **客户端体素副本与本地预测**：同一段技能代码，服务器拿服务器的世界句柄问、客户端拿客户端的问（voxel.md M7 ⑥「两端必须同结果」；「体素不进预测世界」只是不被克隆回滚）。本仓 ABI 加「按角色 + 预算建世界」槽；技能物理端口按端注入（并进 R-00468 验收）；Client 立「体素副本 + 本地物理端口」卡；浏览器那份走 2.7 的 WASM 调研。
  6. **体素 Section 同步通道**：实体走 ECS 同步，方块走 Section 同步（首次全量、之后增量，业务数据永不随体素派发）。本仓契约补「Section 在连接上的帧 + 带宽配额」；Server 卡「`lumio-ds` 体素派发：按视野 / pin 选 Section、首全量后增量、配额、同提交点同整帧作废」；Client 把 R-00296 / 298 重开并与第 5 条合成一张。S-5 的「首包全量下发」依赖它。
- **落卡**：见 §3 wave 2 / wave 3。

### 2.13 旧账号服退役与验收链改接

- **结论**：ADR-061 定 `LumioServer/account-server/` 整目录删，但 RM-00011 的验收链（`lumio-entity-chat-replay` + LumioGame entity-chat 启动器 + 本仓 integration 作业）写死了要它；样例走 Platform 之后它是唯一还挂在旧账号服上的东西。
- **定了什么**：Server 一张卡「replay 与验收链改接 Platform（账号 WS + launch 票）」，做完当天删旧目录；排在 R-00416 之后、与样例 S-3 同批，两条链吃同一份 Platform 拓扑。

### 2.14 外部审查复核吸收项（2026-09-07 补）

- **结论**：另一个 Agent 的独立审查（P01–P18）里有四条我们本轮没讨论、且已在源码与 CI 上实证的东西；全部采纳，落 ADR-077（架构仓 `.spec/decisions/ADR-077-sample-milestone-architecture-rulings.md`） 决策 13–16。逐条判定与证据见 `2026-09-07-sample-external-review-audit.md`（架构仓 `.spec/reviews/2026-09-07-sample-external-review-audit.md`）。
- **事实依据与定案**：
  1. **非 Windows CoreCLR 宿主恒定失败，且无人认领**——`engine/native/modules/clr-host/src/sys.rs:248-269` `#[cfg(not(windows))] load_clr` 恒返 `Err(LoadError::InitFailed)`（文件头自认 MS-00002 Wave 2 known gap）。ADR-052（架构仓 `.spec/decisions/ADR-052-ms00002-hello-wire-and-clr-host-abi.md`） 定装载链归本仓；ADR-067（架构仓 `.spec/decisions/ADR-067-browser-client-prediction-dotnet-wasm.md`）:25 的 D24 / R-00408 是 LumioServer 侧 Rust loader，**不覆盖本仓 `clr-host` 的 Unix 实现**。→ 本仓补 Unix（Linux + macOS）dlopen 路径，是判据 2（一条命令 / Docker / Linux）与 CI 转绿的 wave 0 前置。
  2. **Hello 关闭码**——`LumioServer/modules/process/src/server.rs:372,383` 发 `Message::Close(None)`（对端读 1005），`eng/dev-run.mjs:119` 断言 `[1000,1001]`；正式传输 `entity_chat/wire.rs:820+` 一律带 `CloseFrame`，两条路径不同。→ Server 一张小卡，Hello writer 发正常关闭码；**不许**放宽 `dev-run.mjs` 断言变绿。
  3. **M8 复用 R-00325**——`LumioConfig/.spec/plans/2026-09-02-lumioconfig-dispatch-prompt.md:49,111` 已有该卡（`backlog`，守门条件「需要架构仓合同」）。§2.3 的裁决就是那份合同。→ 不新建卡，改为复用并解除守门、按 ADR-077 §3 收窄到 C# typed Reader；M9 仍是新卡。
  4. **装载兜底与存档切点**——`HostEntry.cs:159` 注册 DLL 缺失静默跳过、`:170` `EcsRegistry.Current ?? FindGeneratedRegistry()`（`:185` 遍历已加载程序集取第一个能用的）、`WorldManager.cs:74-76` `CreateFromSnapshot` 取全局注册表：外部用户改完 C# 却跑着别人的注册表也不报错。另 `WorldManager.cs:153-158` `CaptureSnapshot()` 自带 `CommitCreates()`——取快照本身有结构提交副作用。→ 装载绑定唯一（删兜底、启动与恢复同一注册上下文）；「可存档切点」写进失败语义，延迟结构工作未落地不得取检查点。
- **验收补项**：`sample.md` 判据 5 加最小竞争 / 重复输入反例；判据 6 加半挖矿脉、未拾取掉落、已拾取不重生、逆序登录归属与底图身份可解析；判据 7 加两轮各自独立初始数据与世界断言（日志一致 ≠ 结果正确）。
- **两条外部性问题 Owner 当日已裁**（复核报告 §5，落 ADR-077 决策 17 / 18）：① **判据 2 第一阶段是内部验收**——Platform 镜像现由私有仓源码构建（compose `build: .`），文档要写清「不是外部一条命令」，发镜像排 S-16 发布前，本阶段不立卡；判据 1 不受影响。② **公开使用面随 SDK 包发**——XML doc + 由 `engine/wire` / `engine/abi` 单源生成的公开 API 与错误码参考，私有架构仓不作外部手册，`LumioSample` 文档只链接公开产物；并入 S-2 产出清单，公开范围与 ADR-072 §4 一起审。
- **落卡**：wave 0 增两张（架构仓 Unix CoreCLR 宿主、Server Hello 关闭码）；wave 1 的 M8 改为复用 R-00325；wave 表的 R-00495 行备注改写；**S-2 产出清单加「公开使用面」**（决策 18），S-16 加「发布 Platform 镜像」（决策 17）。

## 3. 排期（wave 0–3）

全部卡挂 R-00517（RM-00015 原始需求）引用边；跨 Room 的由主 loop 统一按 wave 派，批间串行、批内文件集不重叠即并行。

| wave | 卡 | 仓 / Room | 前置 | 备注 |
|---|---|---|---|---|
| 0 | **非 Windows CoreCLR 宿主**：`clr-host` 补 Unix（Linux + macOS）dlopen 装载路径，Linux / Windows 双绿 | 架构仓 | — | 新卡（§2.14①）；判据 2 与 CI 转绿的真前置，排在 S-2 之前 |
| 0 | Hello writer 发正常关闭码（对齐 `dev-run.mjs` 断言），**不放宽断言** | LumioServer | — | 新卡（§2.14②）；Windows integration 红根因 |
| 0 | S-2 重写：SDK 包含 Runtime Ecs / Replication + gen-declarations MSBuild + **公开使用面**（XML doc + `engine/wire` / `engine/abi` 生成的公开 API / 错误码参考）；DS 包不带 Runtime DLL；`server.json` 指用户 `bin/`；删 `netstandard2.1` | 架构仓 + LumioSample | S-1 | 所有实现卡的真 wave 0；公开使用面按 §2.14 决策 18 |
| 0 | S-7 两轮哈希对账 | LumioSample | — | 参考 entity-chat `verify-evidence.mjs` |
| 0 | S-9 LumioGame 改导航 | LumioGame | — | |
| 0 | R-00416 launch 端口 | LumioPlatform | — | 已有卡 |
| 0 | Bot 改 Bearer 载体、删 connectionId 附着 | LumioClient | — | 新卡 |
| 0 | R-00495 会话链落 Faulted | LumioClient | — | 已有卡；Bot 要走的会话链。**不是 integration 红的根因**（§2.6 已更正），但仍要修 |
| 1 | R-00462 追加「boot 响应带 tickRate」 | Runtime | — | 已有卡追加验收 |
| 1 | 宿主按 boot 响应设节拍；删 `tick_hz` 与 10 ms 常量 | Server | R-00462 | 新卡 |
| 1 | M8：导表器生成 C# typed Reader（只含类型与读法） | LumioConfig | — | **复用已有 R-00325**（`backlog`），按 §2.3 解除守门、收窄到 C# 路；不新建卡（§2.14③） |
| 1 | M9：装载器（`server.json` 加配表目录、指纹从 manifest 读、装载时解析一次、快照存强类型） | Runtime + Server HostEntry | M8 | 新卡；S-10 改依赖它 |
| 1 | ABI / SDK 加 voxel `capture` / `restore` 两槽 | 架构仓 | — | 新卡 |
| 1 | S-6 前半：入场 + 聊天 | LumioSample | S-2 | |
| 1 | S-3 启动器（真拓扑）/ S-4 登录 | LumioSample | S-2、R-00416、Client Bearer 卡 | 「复用」改「参考」 |
| 2 | R-00469 + 追加「绑定与结构单同提交点」「玩法经端口调扫掠」 | Runtime | ABI 两槽、绑定三槽 | 已有卡追加 |
| 2 | Runtime 体素切进提交点快照 | Runtime | ABI 两槽 | 新卡 |
| 2 | `lumio-ds` runtime+voxel profile：建世界、boot 交句柄、存 / 恢复两份 | Server | ABI 两槽、R-00498 | 新卡；S-5 / S-12 / S-15 前置 |
| 2 | ABI 绑定 `set / clear / get` 三槽 | 架构仓 | — | 新卡 |
| 2 | 稀疏表进 capture / restore | VoxelEngine | — | 新卡 |
| 2 | ECS 0-9：Local Entity 无网络号创建路径 | Runtime | — | 新卡 |
| 2 | R-00468（移动是 Ability；技能物理端口按端注入）/ R-00480 | Runtime | R-00462 | 已有卡追加 |
| 2 | ABI「按角色 + 预算建世界」槽 | 架构仓 | — | 新卡 |
| 2 | 体素副本 + 本地物理端口（重开 R-00296 / 298） | LumioClient | 上一行 | 新卡 |
| 2 | 契约补 Section 在连接上的帧与带宽配额 | 架构仓 | — | 新卡 |
| 2 | `lumio-ds` 体素派发（按视野 / pin 选 Section、首全量后增量、配额、同提交点同整帧作废） | Server | 上一行、Server 体素 profile | 新卡 |
| 2 | Bot 宿主：按名装载玩法 + 场景程序集；驱动上下文带只读 World 视图与输入词汇表；内置 Seed 随机驱动；场景 = C# 类 + 断言 | LumioClient | R-00468 | 新卡 |
| 2 | S-5 改写（底图快照 + restore 加载 + 首次开档建储量实体）/ S-6 后半（跑动）/ S-8 tour 前段 | LumioSample | 本 wave 引擎卡 | |
| 3 | R-00498 / R-00507 + 轨 B 六卡（S-11 ~ S-16） | 多仓 | wave 2 | S-16 发布前加「发布 Platform 容器镜像、compose 改 `image:`」（§2.14 决策 17），本阶段不立卡 |
| 3 | `lumio-spatial` 经 root 表增槽 + ECS `World.QueryAabb` | 架构仓 + NativeCore + Runtime | — | 新卡；「捡」等它 |
| 3 | replay 与验收链改接 Platform，做完当天删 `LumioServer/account-server/` | Server | R-00416 | 新卡 |
| 3 | R-00470（Runtime 客户端进浏览器） | LumioClient | R-00466 | 已有卡；S-16 前置 |
| 3 | Rust→wasm32 调研卡（六 crate + hfsm / kernel 编译证明、M4 网格零拷贝到页面、与 .NET-wasm 同页共存）→ 体素版 ADR-067 | VoxelEngine | R-00470 | 新卡；S-16 前置 |

## 4. 需求真值改动清单（`sample.md` / ADR-075 / 卡面）

- 客户端：C# Bot 执行十四步；浏览器是最终核心验收（真玩家），残版可先只用 Bot 收口。
- 第 5 步改「加载底图」：底图 = 规范快照文件，一次性脚本经 SDK 写格 + capture 入库；删 `MapLayout`；首次开档扫矿石格建储量实体并登记引用。
- 判据 2 接受 Docker（Platform + Postgres）；判据 3「重编重启」改「换文件重启」；判据 7「同种子」改「同底图」。
- S-3 / S-4「复用 entity-chat」改「参考」；S-6 拆「入场 + 聊天」与「跑动」；S-10 挪后；改名脚本不做；删 `netstandard2.1`。
- 「轨 A / 轨 B」改按 wave 说；清单挂 R-00517。
- ADR-075 §6 打包条款按 2.1 细化（DS 包不带 Runtime DLL）；ADR-070 随样例首个消费方转 Accepted。

## 5. 留给可行性盘点卡的三件事

原 `2026-09-07-sample-track-a-feasibility-probe.md`（架构仓 `.spec/plans/2026-09-07-sample-track-a-feasibility-probe.md`） 的逐卡判定本文已给出，盘点卡缩到：

1. S-5 读路径：从外部玩法程序集出发有没有任何公开 API 能读体素（`IVoxelWorldPort` 为 internal 的实证与替代路径）。
2. ~~main 上 integration 红的根因是否在样例链路上~~ —— **已答（§2.14①②、§2.6）**：不在样例链路上，是两个各自独立的宿主级根因（ubuntu = 本仓 `clr-host` 非 Windows 未实现；windows = LumioServer Hello 关闭码）。盘点卡不必再查这条。
3. native 体素世界句柄从 Rust 宿主交到 Runtime 的具体 ABI 路径（`create_clr_host` 三槽先例 → `boot` 请求字段形状）。

## 6. 已裁决、本次未再议

内容 = 挖矿十四步、无战斗；一仓一游戏、`LumioGame` 兼导航、否 monorepo / submodule / 跨仓软链；命名通用朴素；两轨并行（改按 wave 表述，原则不变）；第一阶段残版不对外发；开发期跟 main 不钉号、红当天修、不加锁文件与 required gate。

## 7. 相关

`sample.md`（架构仓 `.spec/knowledge/features/sample.md`） · ADR-075（架构仓 `.spec/decisions/ADR-075-sample-game-repository-and-topology.md`） · ADR-072（架构仓 `.spec/decisions/ADR-072-open-source-boundary-and-licensing.md`） · ADR-070（架构仓 `.spec/decisions/ADR-070-persistence-container-ownership.md`） · ADR-067（架构仓 `.spec/decisions/ADR-067-browser-client-prediction-dotnet-wasm.md`） · ADR-069（架构仓 `.spec/decisions/ADR-069-nativecore-audit-rulings.md`） · `2026-09-07-sample-game-cards.md`（架构仓 `.spec/plans/2026-09-07-sample-game-cards.md`） · `2026-09-07-sample-milestone-architecture-review-prompt.md`（架构仓 `.spec/plans/2026-09-07-sample-milestone-architecture-review-prompt.md`）

## 8. 落单结果（2026-09-07，Workflow lumiogamesengine，蓝图 `sample-milestone-rulings-20260907/r1`）

Owner 授权后全部登记（含 conditional，登记 ≠ 可开工）；21 张新卡全部挂 R-00517 引用边，另 22 条按接口依赖的引用边、16 条评论、7 条追加验收项（R-00462 ×2、R-00468 ×2、R-00469 ×3）均已读回核对。R-00296 / R-00298 为 rejected 不重开，由新卡取代；R-00416 已在 acceptance，只加评论。

- **wave 0**：R-00529 Bot 以 Bearer 携带 launch 票进 lumio-ds；删除 co…（RM-00007）
- **wave 1**：R-00536 lumio-ds 节拍取自 HostEntry boot 响应的 tickRat…（RM-00006）；R-00535 M8：导表器生成 C# typed Table Reader（只含类型与读法，不…（RM-00009）；R-00544 M9 装载器（Runtime 侧）：读 LumioConfig export →…（RM-00005）；R-00547 HostEntry 配表装载：server.json 加配表目录、content…（RM-00006）；R-00533 ABI / SDK 增 voxel capture / restore 两槽（体…（RM-00001）
- **wave 2**：R-00538 ABI 增方块-实体绑定 set / clear / get 三槽，随 bloc…（RM-00001）；R-00542 ABI 增「按角色 + 驻留预算建世界」槽（客户端体素副本用）…（RM-00001）；R-00545 契约：Section 在 DS 连接上的帧、首全量后增量与带宽配额…（RM-00001）；R-00543 提交点切携带体素那半：Runtime 经 ABI capture 出体素切、恢复…（RM-00005）；R-00546 lumio-ds runtime+voxel profile：开机建体素世界、b…（RM-00006）；R-00531 稀疏引用表进 capture / restore；放箱子再读档两半同时在…（RM-00003）；R-00539 ECS 0-9 · Local Entity：只在 .Client.cs 声明的…（RM-00005）；R-00549 lumio-ds 体素派发：按视野 / pin 选 Section、首全量后增量…（RM-00006）；R-00548 客户端体素副本 + 本地物理端口：收首包与 Section 增量喂本地世界，技能…（RM-00007）；R-00534 Bot 宿主：CLI 按名装载玩法 + 场景程序集；驱动上下文带只读 World…（RM-00007）；R-00540 跑动：移动作为 GAS Ability（两端同一段代码），服务器权威、Bot 发…（RM-00015）
- **wave 3**：R-00537 root 表增 spatial 槽（lumio-spatial upsert /…（RM-00001）；R-00541 ECS World.QueryAabb：实体空间索引随 LogicTransfo…（RM-00005）；R-00532 replay 与 RM-00011 验收链改接 Platform（账号 WS +…（RM-00006）；R-00530 Rust→wasm32 调研：VoxelEngine 六 crate + Nat…（RM-00003）

引用边读回说明：项目级图谱按 300 节点截断、需求室子图不显示跨室引用，40 条跨室边以幂等 `PUT` 返回 200（契约「已存在」）确认，3 条室内边经子图读回。bundle 归档于 `~/LumioGames/.workflow-drafts-parked/sample-milestone-rulings-20260907/`。
