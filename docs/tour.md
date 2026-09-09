# 导览：十四步走完一款 Lumio 游戏

这份导览按真实文件记录示例游戏的十四步链路。需求真值在架构仓；本文只说明本仓当前的落点。

| 步 | 做什么 | 状态 |
|---|---|---|
| 1 | 编译配表，生成 typed Reader | 待写（S-10） |
| 2 | 起账号服，注册登录 | 客户端已落 [`integration/account-client.mjs`](../integration/account-client.mjs) + [`integration/bot-credential.mjs`](../integration/bot-credential.mjs)；真 Platform 换票等启动器（R-00520）接线。本步还不能一条命令跑起来。 |
| 3 | 起 DS，加载配表快照与 tick 频率 | 待写（S-3 + S-10） |
| 4 | 进房间（准入五步） | 待写（S-3） |
| 5 | 加载底图并从存档恢复 | 规范快照文件 [`maps/sample.voxel`](../maps/sample.voxel)，DS 开机 restore 待 S-5（R-00522） |
| 6 | 玩家入场 | 待写（S-6） |
| 7 | 跑动 | 待写（S-6） |
| 8 | 聊天 | 待写（S-6） |
| 9 | 挖掘（技能五步准入） | 等引擎卡 R-00468 |
| 10 | 矿脉储量 -1（方块实体绑定） | 等引擎卡 R-00469 |
| 11 | 储量归零，方块变空气（体素帧末批量写） | 等引擎卡 R-00469 |
| 12 | 掉出矿石（结构单） | 等引擎卡 R-00462 |
| 13 | 走过去捡（Effect 改属性两本账） | 等引擎卡 R-00480 |
| 14 | 存档，重启 DS，地图与矿石数都还在 | 等引擎卡 R-00498 / R-00507 |

> 两轮同底图哈希对账（S-7）贯穿全程，不单列一步。

## 第 2 步：注册登录

账号走 LumioPlatform 的 WebSocket `/account`（子协议 `lumio-account-v1`，登录即注册）。进房票只来自 `POST /api/games/sample/launch` 的 Bearer 换票——本仓不自签票据。口令来自 `LUMIO_ACCOUNT_PASSWORD` 或本轮生成，不入库、不进日志。Bot 命名空间必须带 Platform 签发的 `LUMIO_BOT_TOOL_CREDENTIAL`。

今天能跑的是 hermetic 协议测试（`node --test integration/account-client.test.mjs`）。对着真 Platform + `lumio-ds` 换票准入，等 S-3（R-00520）把启动器接上。

## 第 5 步：加载底图

底图是规范快照文件，不由玩法程序集程序化生成。[`maps/sample.voxel`](../maps/sample.voxel) 为占位文件，不可 restore；真底图由 S-5 经 SDK 写格 + capture 产出；DS 开机 restore 和快照写入由 S-5（R-00522）接线。

`integration/verify-evidence.mjs` 只读取两轮日志，逐位核对 `eventOrder` 与 `appliedTicks`，并比较日志中的 `baseMapSha256`。它不从其它字段推导事件，也不使用多重集比较。
