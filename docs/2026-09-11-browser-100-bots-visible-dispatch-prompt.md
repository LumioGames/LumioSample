---
name: 2026-09-11-browser-100-bots-visible-dispatch-prompt
description: 浠婃棩鍒囩墖鈥斺€旀祻瑙堝櫒鐪嬭 100 涓?Bot 鏉冨▉浣嶇Щ锛涗富 loop 骞惰娌欑洅銆佸厛鍐欎唬鐮佸悗鎬昏皟;娲炬椿鏃舵暣娈靛鍒?metadata:
  type: doc
  status: 璁捐涓?---

# 浠婃棩鍒囩墖 路 娴忚鍣ㄧ湅瑙?100 涓?Bot 鍦ㄨ蛋锛堜富 loop 寮€宸ユ彁绀鸿瘝锛?
> **鏁存澶嶅埗缁欎富浼氳瘽 Agent銆?* 鏈枃浠惰嚜瓒炽€傚伐浣滃唴瀹逛互鏈枃涓哄噯锛涙棦鏈?Workflow 鍗曪紙R-00520 / R-00540 / R-00588 / R-00523 / R-00470锛夋槸涓婚褰掑睘锛屾湰鍒囩墖涓嶆柊寤哄崱銆佷笉鏀?Workflow 鐘舵€侊紝闄ら潪 Owner 鍙︽巿鏉冦€?
---

## 0. 浣犳槸璋併€佷粖澶╀氦浠€涔?
浣犳槸鏋舵瀯浠撲富浼氳瘽锛圱D 璋冨害锛夈€備粖澶?**鍙仛涓€浠朵骇鍝佷簨瀹?*锛?
**鍦ㄤ竴鍙?Windows 娴嬭瘯鏈虹殑妗岄潰 Chrome 閲岋紝鎵撳紑涓€寮犳梺瑙傞〉锛岀湅瑙佸悓涓€灞€ DS 閲?100 涓?C# Bot 鐨勬潈濞佷綅绉诲湪鍔紙绌哄湴鐢荤偣鍗冲彲锛夈€?*

涓嶆槸鍗佸洓姝ャ€佷笉鏄寲鐭裤€佷笉鏄綋绱犵綉鏍笺€佷笉鏄?5 鍒嗛挓鍘嬫祴浜旀潯銆佷笉鏄娴嬬籂鍋忋€佷笉鏄編鏈€傜湅瑙?100 涓偣鍦ㄨ蛋 = 浠婃棩 Done銆?
**鏄ㄥぉ宸叉湁鐨勶紙鍙鐢紝涓嶈閲嶅仛锛夛細** 鐪?Platform `:8080` 鐧诲綍 + launch锛沗lumio-ds` 鍒?`DS_READY`锛?00/100 浜掍笉鐩稿悓杩涙埧绁紙R-00586 鐜板満锛夛紱C# `Bot.Host` 鑳芥媺璧峰苟灏濊瘯杩?DS銆?
**鏄ㄥぉ娌℃湁銆佷笖琚璇荤殑锛?* `LumioClient/modules/bot/host/BotHostResidentLoop.cs` 鍦ㄥ鎴风鍓湰涓?`LogicTransform.SetLocalPose`锛堟帶鍒跺櫒鍚?`BotStressMovement`锛夈€傞偅鏄湰鍦版秱鍧愭爣锛?*涓嶆槸** DS 鏉冨▉浣嶇Щ锛屾祻瑙堝櫒鏃佽鐪嬩笉瑙併€備粖澶╁繀椤绘敼鎴愮湡 `Activate<MoveAbility>`銆?
---

## 1. 宸ヤ綔鏂瑰紡锛堢‖鎬э紝杩濊儗鍗冲け璐ワ級

1. **鍏堝苟琛屽啓浠ｇ爜锛屾渶鍚庢墠鎬昏皟銆?* Wave A 鐨?6 涓矙鐩?**鍚屾椂**寮€宸ャ€備换涓€娌欑洅鍦?Wave A 鏈叏閮ㄤ氦鍥炲墠 **绂佹** 璧?Platform / `lumio-ds` / 100 Bot / 寮€娴忚鍣ㄨ仈璋冦€傚崟浠?`dotnet test` / `node --test` / `cargo test` 鍙祴鏈粨鏂囦欢锛岀畻銆屽啓浠ｇ爜銆嶏紝涓嶇畻鎬昏皟銆?2. **6 涓?git worktree 娌欑洅骞惰**锛屾枃浠堕泦浜掓枼锛埪?锛夈€倃orktree **涓€寰?*寤哄湪 `C:\Work\LumioGames\` 鐩村睘瀛愮洰褰曪紙Windows 鏈満锛沗sdk-native` 闈犲厔寮熶粨鐩稿璺緞锛屾斁 `.claude/worktrees` / `/tmp` 浼氭柇锛夈€傚懡鍚嶏細
   - `LumioClient-a1-move-uplink`
   - `LumioSample-a2-spawn-physics`
   - `LumioGameRuntime-a3-open-space`
   - `LumioServer-a4-admit-spawn`
   - `LumioClient-a5-spectator-page`锛堜笌 A1 **鍚屼粨涓嶅悓鏂囦欢**锛屽繀椤荤浜屼釜 worktree锛?   - `LumioSample-a6-launcher-hold`锛堜笌 A2 **鍚屼粨涓嶅悓鏂囦欢**锛屽繀椤荤浜屼釜 worktree锛?3. **姣忎釜娌欑洅涓€涓嫭绔嬪瓙 Agent**锛堟垨鐙珛浼氳瘽锛夈€備富浼氳瘽鍙皟搴︺€佸喕缁撴帴鍙ｃ€佹敹 PR銆佹渶鍚庤窇 Wave B銆傚瓙 Agent **涓嶅緱鍐嶆淳鐢熷瓙 Agent**銆?4. 姣忎釜娌欑洅浠庤浠?`origin/main` 鎷夋柊鍒嗘敮锛岃蛋 PR + **merge commit**锛堢姝?squash / rebase-merge锛夈€侰I 鏈豢涓嶅悎銆傜孩涓婁笉鍙犮€?5. Wave A 浜ゅ洖鐗?= 鏀瑰姩娓呭崟 + 鏈粨鍗曟祴鍛戒护涓庣湡瀹炶緭鍑?+ known gaps + PR 閾炬帴銆?*涓嶅啓銆屽凡鍦ㄧ湡 DS 鐪嬭 Bot 璧拌矾銆?*鈥斺€旈偅鏄?Wave B 鐨勪簨銆?6. 璇佹嵁鍙紩鐢ㄥ凡鎺?origin 鐨勬彁浜ゃ€傚绾︾己鍙ｅ仠涓嬩笂鎶ワ紝涓嶆湰鍦扮粫杩囥€?
---

## 2. 浠婃棩鍥犳灉閾撅紙鍐欎唬鐮佹椂瀵圭潃瀹冿級

```text
100 Bot 鍙?Activate<MoveAbility>({Dx,Dz})
  鈫?DS Admit 鍚?Create<PlayerEntity> + BindPlayer + 鎸傜┖鍦扮墿鐞嗙鍙?  鈫?鏈嶅姟鍣?Execute 鍐欐潈濞?LogicTransform
  鈫?WorldChange/Delta 甯?100 涓?localPosition
  鈫?绗?101 涓瀵熻€咃紙娴忚鍣紝Bearer 绁級杩涘悓涓€鎴块棿
  鈫?椤甸潰鐢?Runtime 瀹㈡埛绔▼搴忛泦瑙ｅ寘锛圝S 涓嶅啓绗簩浠?codec锛?  鈫?Canvas 鎸?LogicTransform 鐢?100 涓偣锛屼綅缃殢 Delta 鍙?```

鏂湪浠讳綍涓€鎴?= 娴忚鍣ㄩ潤姝€備紭鍏堜慨鏂偣锛屼笉鍑嗘嬁 Hello 椤佃В鏋?Delta 鐢讳汉锛堢浜屼唤 codec锛孉DR-067 閫€鍥烇級銆?
---

## 3. 鍐荤粨鎺ュ彛锛圵ave A 寮€宸ュ墠涓讳細璇濇妱鍒版瘡涓矙鐩掓彁绀鸿瘝锛?
鍚勬矙鐩掓寜杩欎簺鍚嶅瓧鎺ョ嚎銆傝鏀圭鍚嶅繀椤诲厛鍋溿€佷富浼氳瘽鏀规湰鑺傘€佸啀璁╃浉鍏虫矙鐩掗噸寮€鈥斺€?*绂佹绉佽嚜鏀归偦灞呭绾?*銆?
### 3.1 绉诲姩鎰忓浘

- Ability锛歚Lumio.Sample.Gameplay.MoveAbility`锛宍TypeId = 1u`锛宍PredictionKind.LogicPredict`銆?- 杈撳叆锛歚MoveAbility.Input { int Dx; int Dz; }`锛宍MaxAbsStep = 1`銆俻ayload 甯冨眬宸插瓨鍦細`Write` 杩藉姞 `Dx.ToString`銆乣Dz.ToString`銆?- 瀹㈡埛绔彂鍑猴細`AbilityComponent.EmitServerRpc("Activate", [ "MoveAbility", dx, dz, sequence ])`锛宮appingId = `WireCodec.ServerRpc`锛坄"server.rpc"`锛夈€?- Bot 璇嶈〃锛歚BotInputKind.Activate`锛宍ComponentName = "AbilityComponent"`锛宍Member = "MoveAbility"`锛宍Arguments = [ "MoveAbility", "1", "0", sequence ]`锛堢ず渚嬩竴姝?+X锛夈€傜粡鐜版湁 `ReplicaBotCommandSink.EmitActivate`锛?*绂佹** `SetLocalPose` / `SetLocalPosition` 浣滀负鍘嬫祴璺緞銆?
### 3.2 绌哄湴鐗╃悊绔彛

- 绫诲瀷锛歚Lumio.GameRuntime.Gas.RecordingAbilityPhysicsPort`锛堝凡鍦?`IAbilityPhysicsPort.cs`锛歴weep miss銆乣TravelFraction = 1.0`锛夈€備粖鏃ュ垏鐗?**鐩存帴鐢ㄥ畠**锛屼笉鏂伴€犵涓変唤銆岀┖鍦般€嶅疄鐜般€?- 鎸傝浇锛氭瘡涓凡 `BindPlayer` 鐨?`AbilityComponent.Physics = new RecordingAbilityPhysicsPort()`銆傛病鏈夌鍙ｅ垯 `MoveAbility.Execute` fail-closed 涓嶅啓鍧愭爣銆?
### 3.3 杩涙埧鐢熸垚

- 瀹炰綋锛歚Lumio.Sample.Gameplay.EntityTypes.PlayerEntity`锛堝凡 `[Has] LogicTransform + AbilityComponent + 鈥锛夈€?- 鐜╂硶鍏ュ彛锛歚SampleGameplay.BindPlayer(World world, NetEntityId player)` 宸插瓨鍦紝A2 鍙湪鍏跺悗鎸?Physics銆?- Admit 鍚庢湇鍔″櫒蹇呴』 `Commands.Create<PlayerEntity>()`锛堟垨绛変环 `CreateFor(typeof(PlayerEntity))`锛夛紝鎻愪氦鐩镐寒鐩稿悗鍐?`BindPlayer` + 鎸傜鍙ｃ€俙entityType` 瀛楃涓插 Runtime 蹇呴』鑳?`TryResolveEntityType` 鍒?`PlayerEntity`銆?- 鏃佽鑰咃紙绗?101 涓繛鎺ワ級**涔熸槸**涓€涓?`PlayerEntity`锛堝彲鍘熷湴涓嶅姩锛夛紱绂佹涓烘梺瑙傚彟閫犲疄浣撶绫汇€?
### 3.4 澶嶅埗

- 鏉冨▉浣嶅Э瀛楁锛歚LogicTransform` 鐨?sync fieldId `localPosition` / `localRotation` / `parent` / `teleportId`锛坄Lumio.GameRuntime.Ecs.LogicTransform` 宸插疄鐜?`IGeneratedSyncMetadata`锛夈€?- 娴忚鍣ㄥ彧璇诲鍒朵笘鐣岄噷杩欎簺瀛楁銆備笉寮曞叆鏂?wire 娑堟伅銆?
### 3.5 鏃佽椤?
- 浼犺緭锛歚LumioServer/eng/connect-ds.mjs` 鐨?`connectDs(launch, { allowLoopback: true })`銆傚瓙鍗忚 `lumio.mvp.v0`锛屽嚟璇佽蛋鎻℃墜锛?*涓嶈繘 URL / localStorage / 椤甸潰鏂囨**銆?- 瑙勫垯浠ｇ爜锛歊untime 瀹㈡埛绔▼搴忛泦 + Sample **client** 鐜╂硶绋嬪簭闆嗭紝缁?.NET browser-wasm锛圓DR-067锛夈€侸S 鍙仛锛歐ebSocket 鎼瓧鑺傘€丆anvas 鐢荤偣銆佽緭鍏ワ紙鏃佽椤典粖鏃ユ棤杈撳叆锛夈€?- 璇佹嵁锛歚window.__lumioSpectator = { status, botCount, positions: [{id,x,z}], updatedAtMs }`銆侰hrome 鎺у埗鍙拌兘璇诲埌 `botCount >= 100` 涓斿潗鏍囬殢鏃堕棿鍙樸€?- 鍚姩锛氶潤鎬佹枃浠舵湇鍔″嵆鍙€傚惎鍔ㄥ櫒鎵撳嵃 URL锛屼笉寮哄埗鑷姩 `start chrome`銆?
### 3.6 鍚姩鍣紙A6 鍙帴绾匡紝涓嶆敼鍗佸洓姝ヨ瘹瀹炵己鍙ｏ級

- 鐜版湁锛歚LumioSample/integration/launcher.mjs`銆俉ave A **涓嶅緱**鎶?step 05鈥?4 鐨?`BLOCKED_ENV` 鏀规垚 PASS銆?- A6 鍙姞锛歚--spectator`锛堟墦鍗版梺瑙?URL + 绗?101 寮犵エ锛夈€佹妸 Bot 寰幆鍒囧埌 MoveAbility锛堜緷璧?A1 鍚堝叆鍚庣殑 Bot.Host 鍙傛暟锛岄粯璁よ涓烘敼涓?Activate锛夈€乣--bots 100` 鏃?hold 绐楀彛鐩村埌鏃佽椤佃繛涓婃垨 `--duration-ms`銆?- 鎬昏皟鑴氭湰锛堜粎 Wave B 鍐欙級锛歚LumioSample/integration/spectator-100.mjs`锛堟垨 launcher 鐨?`--mode spectator-100`锛夈€俉ave A 鍚勬矙鐩?**涓嶅啓** 杩欎釜鏂囦欢銆?
---

## 4. 鍏釜娌欑洅锛堝悓鏃跺紑宸ワ級

姣忎釜娌欑洅鎻愮ず璇嶇粨鏋勭浉鍚岋細鐩爣銆佹枃浠剁櫧鍚嶅崟銆佺姝㈢銆佹湰浠撴祴璇曘€佷氦鍥炪€備富浼氳瘽鎶?搂0鈥撀? + 涓嬮潰瀵瑰簲涓€鑺傝创缁欒瀛?Agent銆?
### A1 路 LumioClient 路 Bot 鏀逛负 Activate 涓婅

**浠擄細** `C:\Work\LumioGames\LumioClient`  
**鍒嗘敮锛?* `feat/spectator-100-move-activate`  
**worktree锛?* `C:\Work\LumioGames\LumioClient-a1-move-uplink`

**鏀硅繖浜涳紙鐧藉悕鍗曪級锛?*

- `modules/bot/host/BotHostResidentLoop.cs` 鈥?**鍒犻櫎** `BotStressMovement` / `SetLocalPose` 鏁存銆傛敼涓哄姣忎釜宸?`InputEnabled` 鐨?bot锛歚new ReplicaBotCommandSink(world).Issue(BotIssuedCommand.Activate("MoveAbility", new[] { dx, dz, seq }, seqUlong))`銆俙dx/dz` 鐢ㄩ€愭寰€杩旀垨鍥哄畾涓€姝ワ紙渚嬪濂囨暟 tick `1,0` 鍋舵暟 `0,1`锛夛紝`|step|<=1`銆?- 鑻?`BotIssuedCommand.Activate` 鐨勫弬鏁伴『搴忎笌 sink 鐨?`[typeName, ...payload, sequence]` 涓嶄竴鑷达紝鍙敼 host 璋冪敤鐐瑰幓閫傞厤鐜版湁 sink锛?*涓嶆敼** `ReplicaBotCommandSink` 濂戠害銆?- `modules/bot/tests/**` 閲岃鐩?resident 寰幆鐨勬祴璇曪細鏂█鍙戝嚭 Activate銆佹柇瑷€婧愮爜涓嶅啀鍑虹幇 `BotStressMovement`銆?
**绂佹锛?* `modules/web/**`銆乣spikes/**`銆乣modules/session/**`銆乣modules/replica/src/**`锛堟祴璇曞彲寮曠敤锛夈€佹敼 HFSM銆佹敼 prediction銆?
**鏈粨娴嬭瘯锛圵ave A 鍐呭厑璁革級锛?* 鐜版湁 Bot 鍗曟祴 + 鏂板銆宺esident 寰幆鍙?Activate銆佷笉鍐?SetLocalPose銆嶇殑娴嬭瘯銆備笉杩炵湡 DS銆?
### A2 路 LumioSample 路 spawn + BindPlayer + 鎸傜┖鍦扮鍙?
**浠擄細** `C:\Work\LumioGames\LumioSample`  
**鍒嗘敮锛?* `feat/spectator-100-spawn-physics`  
**worktree锛?* `C:\Work\LumioGames\LumioSample-a2-spawn-physics`

**鏀硅繖浜涳細**

- `src/Lumio.Sample.Gameplay/SampleGameplay.cs` 鈥?`BindPlayer` 鏈熬锛歚abilities.Physics = new RecordingAbilityPhysicsPort();`锛坲sing `Lumio.GameRuntime.Gas`锛夈€?- 鏂板鐜╂硶渚?Admit hook锛堝悕绉拌嚜瀹氫絾蹇呴』琚?Server A4 鐢ㄥ弽灏勬垨宸茬煡闈欐€佹柟娉曟壘鍒帮級锛屽缓璁細
  `public static NetEntityId AdmitPlayer(World world, string accountId)`  
  鍐呴儴锛歚Create<PlayerEntity>()` 鈫?鎻愪氦鍚?`BindPlayer` 鈫?鍐?Identity 鑻ュ凡鏈夊瓧娈?鈫?杩斿洖 id銆?- `generated/` 鑻ュ洜澹版槑鍙樺姩闇€瑕侀噸璺?`gen-declarations`锛屾湰娌欑洅璺戯紝鎻愪氦鐢熸垚鐗┿€?- 娴嬭瘯锛氳繘绋嬪唴 World锛宍AdmitPlayer` 鍚?`Activate<MoveAbility>` 浣嶇疆蹇呴』鏀瑰彉锛堟湁绔彛锛夛紱涓嶆寕绔彛鍒欎綅缃笉鍙橈紙閿?fail-closed锛夈€?
**绂佹锛?* `integration/launcher.mjs`銆乣integration/stress-move.mjs`銆乣integration/spectator-100.mjs`锛堜笉瀛樺湪灏卞埆寤猴級銆乣maps/`銆佹妸 `BLOCKED_ENV` 鏀?PASS銆佹寲鐭块摼璺€?
### A3 路 LumioGameRuntime 路 鐢熶骇璺緞鑳芥寕绌哄湴绔彛 + Activate 鏃犳秷鑰楁妧鑳戒笉鎷?
**浠擄細** `C:\Work\LumioGames\LumioGameRuntime`  
**鍒嗘敮锛?* `feat/spectator-100-open-space-port`  
**worktree锛?* `C:\Work\LumioGames\LumioGameRuntime-a3-open-space`

**鏀硅繖浜涳紙浠呯己鍙ｏ級锛?*

- 纭 `RecordingAbilityPhysicsPort` 瀵?Sample 鐢熶骇鍙紩鐢紙涓嶈 `internal`銆佷笉瑕佷粎娴嬭瘯宸ョ▼鍙锛夈€傝嫢琚?`IsPackable=false` 鎸″湪 SDK 澶栵紝鎶婂畠鎸埌 **Gas 鐢熶骇绋嬪簭闆?* 宸叉湁鏂囦欢鏃侊紝鎴栧姞涓€涓敓浜у悕 `OpenSpaceAbilityPhysicsPort`锛堝疄鐜颁笌 Recording 鐩稿悓锛歴weep miss锛夛紝**Sample A2 鎸変富浼氳瘽鏀瑰喕缁撳悕**鈥斺€旇嫢浣犺鏀瑰悕锛屼氦鍥炵涓€鍙ヨ瘽鍐欐柊鍏ㄥ悕锛屼富浼氳瘽鏀?搂3.2 鍚庡啀璁?A2 璺熶笂銆備紭鍏堜笉鏀瑰悕銆?- `AbilityComponent.Activate`锛歚MoveAbility` 鏃?Cost 鏃朵笉寰?`Reject(3)`銆傚綋鍓?`CreateOwnedContext` 瀵圭┖ Cost 宸?`() => 1L`锛涜ˉ涓€鏉?**鐢熶骇璺緞** 娴嬭瘯锛氭病鏈変换浣曟墜宸?`ActivationContext` 鐨勫疄浣擄紙浠呯洰褰曟敞鍐岋級`Activate<鏃燙ost鎶€鑳?` 鎴愬姛銆傝嫢宸叉湁娴嬭瘯瑕嗙洊锛屽湪浜ゅ洖閲岃创鐢ㄤ緥鍚嶏紝鏈矙鐩掑彲浠ュ嚑涔庣┖ PR锛屼絾蹇呴』璺戣繃骞跺啓杈撳嚭銆?- 纭 `LogicTransform` 鑴忚处鍦?`SetLocalPosition` 鍚庤繘鍏ュ鍒跺彇鏍凤紙宸叉湁 sync metadata锛夈€傝嫢鐢熶骇 Tick 涓嶅彇鏍疯瀛楁锛屼慨鍙栨牱鑰屼笉鏄敼 Sample銆?
**绂佹锛?* 閲嶅啓 GAS 鍏€併€佹崲 hfsm銆佸姩浣撶礌 provider銆佸姩 `modules/prediction`銆佹妸娴嬭瘯鏇胯韩鎵撹繘銆屽亣瑁呯湡 mesher銆嶃€?
### A4 路 LumioServer 路 Admit 鍚庤蛋鐜╂硶 spawn

**浠擄細** `C:\Work\LumioGames\LumioServer`  
**鍒嗘敮锛?* `feat/spectator-100-admit-spawn`  
**worktree锛?* `C:\Work\LumioGames\LumioServer-a4-admit-spawn`

**鏀硅繖浜涳細**

- Admit 璺緞锛坄HostEntry` / `entity_chat` 閲屾瀯閫?`AdmitConnectionMessage` 涔嬪悗銆乄elcome 涔嬪墠锛夛細瀵?Sample 娉ㄥ唽琛ㄨВ鏋愬嚭鐨?`PlayerEntity` 璋冪敤 A2 鐨?`AdmitPlayer`锛堝弽灏勬壘 `Lumio.Sample.Gameplay.SampleGameplay.AdmitPlayer` 鍗冲彲锛?*涓嶈**鍦?Server 鍐欑帺娉曠被鍨嬶級銆俇sername 鏍锋澘璺緞淇濇寔鍘熸牱锛岀敤娉ㄥ唽琛ㄧ被鍨嬪悕鍖哄垎锛岀姝㈡妸 Sample 鍐欒繘寮曟搸榛樿銆?- `entityType` 蹇呴』鏄?Runtime 鑳借В鏋愮殑鍚嶅瓧锛坄PlayerEntity` 鎴栨敞鍐岃〃 TypeName锛夈€侭ot 涓庣湡浜哄悓涓€绫诲瀷銆?- 娴嬭瘯锛欻ostEntry 绾ф垨 CLR 妗ユ祴璇曗€斺€擜dmit 涔嬪悗涓栫晫閲岃兘鏌ュ埌鏂扮殑 `PlayerEntity` + `LogicTransform`銆傛棤鐪?DS 杩涚▼涔熷彲锛屼絾蹇呴』鍔犺浇 Sample 鐜╂硶绋嬪簭闆嗭紙娴嬭瘯鐢?ProjectReference / 宸茬紪 dll锛屼笌鐜版湁 RuntimeBackedBoot 鍚岀被锛夈€?
**绂佹锛?* 鏀?`connect-ds.mjs` 鐨勫嚟璇佺邯寰嬨€佹敼鍏抽棴鐮併€佹敼 persistence 瀹瑰櫒銆佹妸 voxel save 濉炶繘鏈垏鐗囥€?
### A5 路 LumioClient 路 鏃佽椤碉紙绗簩涓?Client worktree锛?
**浠擄細** `C:\Work\LumioGames\LumioClient`  
**鍒嗘敮锛?* `feat/spectator-100-page`  
**worktree锛?* `C:\Work\LumioGames\LumioClient-a5-spectator-page`

**鏀硅繖浜涳細**

- **鏂扮洰褰?* `modules/web/spectator/`锛堜笉瑕佹敼 `modules/web/hello/**`銆乣modules/web/chat/**`锛夈€?  - `index.html` + `main.js` + `README.md`
  - JS锛歭aunch 鎴?`?` 浠呭甫闈炴満瀵嗗弬鏁帮紱鐢ㄤ笌 `connect-ds.mjs` 鐩稿悓鐨勫瓙鍗忚瑙勫垯杩?`ws`锛堥〉闈㈤噷澶嶅埢 connect 瑙勫垯锛屾垨 fetch 鍚岀洰褰曚竴浠?**鏃犲嚟璇?* 鐨勫皬妯″潡锛?*涓嶈**鎶?admission 鍐欒繘 query锛夈€?  - 瑁呰浇 .NET wasm锛氱収 `spikes/runtime-wasm` 鐨勩€孞S 鍙惉瀛楄妭銆嶅舰鐘讹紝浣?**鏂板伐绋?* 寮曠敤 Sample **client** 鐜╂硶 + Runtime 瀹㈡埛绔▼搴忛泦锛屼笉瑕佹妸 spike 鎷疯繘 `modules/`銆?  - Canvas锛氭瘡涓?`PlayerEntity` 涓€涓渾鐐癸紱鍧愭爣鏉ヨ嚜 wasm 瀵煎嚭鐨?`LogicTransform.LocalPosition`锛圕# `[JSExport]` 鍙悙 `{id,x,z}[]`锛孞S 涓嶈В鐮?WorldChange锛夈€?  - `window.__lumioSpectator` 瑙?搂3.5銆?- 椤甸潰宸ョ▼ csproj 鏀?`modules/web/spectator/host/` 鎴栧苟鍒楋紝涓嶈繘 spike 鐩綍銆佷笉杩?allowlist 鐨勭敓浜?Bot 宸ョ▼闄ら潪蹇呰銆?- 娴嬭瘯锛歚node --test` 瀵?JS锛堝嚟璇佷笉杩?URL锛夛紱C# 瀵煎嚭褰㈢姸鍗曟祴銆備笉杩炵湡 DS銆?
**绂佹锛?* 鏀?`BotHostResidentLoop.cs`锛圓1 鐨勬枃浠讹級銆乭ello-wire 瀛楁娓呭崟銆佺浜屼唤 JS codec銆佷綋绱?wasm mesher銆佽嚜鍔ㄦ挱鏀鹃煶鏁堛€?
**涓?A1 鍐茬獊锛?* 闆舵枃浠堕噸鍙犮€傝嫢閮借鏀?`LumioClient.slnx` 鍔犲伐绋嬶紝**鍙湁 A5 鏀?slnx**锛汚1 涓嶅姞鏂?csproj銆?
### A6 路 LumioSample 路 鍚姩鍣?hold + 鏃佽绁紙绗簩涓?Sample worktree锛?
**浠擄細** `C:\Work\LumioGames\LumioSample`  
**鍒嗘敮锛?* `feat/spectator-100-launcher`  
**worktree锛?* `C:\Work\LumioGames\LumioSample-a6-launcher-hold`

**鏀硅繖浜涳細**

- `integration/launcher.mjs`锛氫繚鐣?step 05鈥?4 鐨?`BLOCKED_ENV`銆傛柊澧炲弬鏁?`--spectator-url` / 鎵撳嵃鏃佽椤靛湴鍧€锛堥粯璁?`http://127.0.0.1:<static>/modules/web/spectator/` 鐢?env `LUMIO_SPECTATOR_ORIGIN` 缁欙級銆傜 101 娆?`loginAndLaunch` 浣滀负鏃佽绁紝**涓?*璧风 101 涓?Bot.Host銆?- `integration/launcher.test.mjs`锛氭柇瑷€ 100 Bot + 1 spectator ticket 璁″垝锛涙柇瑷€ step 05鈥?4 浠嶅彲涓?BLOCKED_ENV锛涙柇瑷€涓嶄細鎶婃湰鍦版秱鍧愭爣鍐欐垚 PASS銆?- **涓嶈**鍦?Wave A 鍐?`spectator-100.mjs`銆傛€昏皟鑴氭湰鐣欑粰 Wave B 涓讳細璇濄€?
**绂佹锛?* `src/Lumio.Sample.Gameplay/**`锛圓2 鐨勬枃浠讹級銆乣maps/sample.voxel` 褰撳彲 restore 搴曞浘銆佹妸鍗佸洓姝ユ敼缁裤€?
**涓?A2 鍐茬獊锛?* A6 鍙 `integration/`锛孉2 鍙 `src/` + `tests/`銆俙Directory.Build.*` / `LumioSample.slnx` 璋侀兘涓嶆敼锛岄櫎闈?A2 蹇呴』鍔犳祴璇曞伐绋嬧€斺€旈偅鏃跺彧鏈?A2 鏀广€?
---

## 5. Wave B 路 鎬昏皟锛堝叚涓?PR 閮借繘鍚勪粨 main 涔嬪悗锛屼富浼氳瘽鑷繁鍋氾級

**瑙﹀彂鏉′欢锛?* A1鈥揂6 鐨?PR 鍏ㄩ儴 merge 鍒板悇鑷?`origin/main`锛屾湰鏈?`git pull --ff-only` 鍗佷粨銆傜己涓€涓?PR 涓嶅噯寮€ DS銆?
**鎬昏皟鏈哄櫒锛?* 鏄ㄥぉ閭ｅ彴 Windows 娴嬭瘯鏈恒€傜嫭鍗犫€斺€擶ave B 鏈熼棿绂佹鍏跺畠 agent 缂栬瘧鎶?CPU锛堟椂闂寸被瑙傛祴浼氳櫄楂橈級銆?
**姝ラ锛堟寜椤哄簭锛屽け璐ュ氨鍋滃湪璇ユ锛屼笉瑕佽烦杩囩敾娴忚鍣級锛?*

1. `git pull --ff-only`锛歋ample / Client / Runtime / Server / Platform / Engine銆傛妸鍗佷粨 SHA 鍐欏叆鍗冲皢鐢熸垚鐨?`verification.json`.shas銆?2. 璧?Platform锛堝凡鏈?compose / 鏈満杩涚▼ `:8080`锛夈€俙node LumioPlatform/eng/stress-tickets.mjs --count 101 --origin http://127.0.0.1:8080 --game sample --out .run/spectator-101.json`銆傝 101 寮犱簰寮傜エ锛?00 Bot + 1 鏃佽锛夈€?3. 璧?`lumio-ds`锛岄厤缃敤娴嬭瘯鏈哄凡鑳?`DS_READY` 鐨勯偅浠斤紙浠撳唴 `server.json` 浠嶅彲鑳芥槸鍗犱綅锛涙湰鏈?overlay `.run/server.local.json`锛?*涓嶈**鎶婂瘑閽ユ彁浜よ繘 git锛夈€?4. 璧?100 涓?`Bot.Host`锛宍--gameplay` 鎸囧悜 Sample **client/server 鎸夊涓昏姹?* 鐨勭帺娉?dll锛屽弬鏁拌蛋 A1 涔嬪悗鐨?Activate 寰幆銆傞敊宄?`--stagger-ms`銆?5. **鍏堢敤绗?101 涓?C# Bot 鍙敹鍖呫€佹墦 100 涓?`LogicTransform`**锛堣嫢 A1 鏉ヤ笉鍙婂仛鍙鎺㈤拡锛岀敤涓€灏忔 `dotnet` 涓€娆℃€х▼搴忥紝浠嶈蛋 Bot.Host + `--gameplay`锛屼笉鍙?Activate锛夈€傛帶鍒跺彴蹇呴』鍑虹幇 鈮?00 涓?id锛屼笖 5 绉掑唴鍧愭爣鍙樺寲鐨勫疄浣撴暟 鈮?90銆傝繖涓€姝ヤ笉杩囷紝**涓嶅噯鎵撳紑娴忚鍣?*鈥斺€斿惁鍒欎綘鍙堜細鎶娿€岄〉寮€浜嗐€嶅綋鎴愩€屼汉鍦ㄨ蛋銆嶃€?6. 闈欐€佹墭绠?A5 鏃佽椤碉紱娴忚鍣ㄧ粡 launch 绁?`connectDs`銆侰hrome 閲?100 涓偣鍦ㄥ姩锛沗window.__lumioSpectator.botCount >= 100`銆?7. 褰?20 绉掑睆鎴栦繚瀛?`__lumioSpectator` JSON 蹇収涓や唤锛坱=0 涓?t=5s锛夛紝鏀?gitignored `LumioSample/integration/logs/spectator-100/`锛屾妸 SHA 涓庡懡浠よ緭鍑哄啓杩涙湰娆′細璇濅氦鍥烇紝**涓嶈**鎶婄エ鍐欒繘浠撱€?
**Wave B 鍏佽涓讳細璇濆啓鐨勫敮浜屼釜鏂版枃浠讹細**

- `LumioSample/integration/spectator-100.mjs`锛堢紪鎺?1鈥?锛?- `LumioSample/integration/spectator-100.test.mjs`锛坔ermetic锛氱己 env 鏃?`BLOCKED_ENV`锛屼笉璁稿亣缁匡級

---

## 6. 浠婃棩楠屾敹锛圖one / 鏈畬鎴愶級

**Done锛堝繀椤诲悓鏃舵垚绔嬶級锛?*

- 妗岄潰 Chrome 鏃佽椤靛彲瑙?鈮?00 涓偣銆?- 鐐圭殑浣嶇疆鏉ヨ嚜 DS 澶嶅埗鐨?`LogicTransform`锛屼笉鏄〉闈㈤殢鏈烘憜銆?- 鎶芥牱 5 涓?id锛? 绉掑唴 `|螖x|+|螖z| > 0`銆?- Bot.Host 婧愮爜涓嶅啀鍚?`BotStressMovement` / 鍘嬫祴璺緞 `SetLocalPose`銆?- 鍗佷粨 SHA 璁板湪璇佹嵁鐩綍銆?
**鏈畬鎴愶紙涓嶈鐢ㄨ繖浜涘啋鍏?Done锛夛細**

- Hello 椤?Delta 琛ㄥ湪鍒枫€?- 100 寮犵エ鍙戝嚭鏉ヤ簡浣嗘祻瑙堝櫒绌虹櫧銆?- 鏈満 Bot 鏃ュ織鍧愭爣鍦ㄥ彉銆佹梺瑙傞〉涓嶅姩銆?- `stress-move` 浜旀潯鍒ゆ嵁銆?- 浣撶礌鍦板舰銆佹寲鐭裤€佸瓨妗ｃ€侀娴嬪钩婊戙€?
---

## 7. 绂佸尯锛堟墍鏈夋矙鐩?+ 鎬昏皟锛?
- 涓嶅緱鍦?GAS 澶栧彟閫犻娴嬫垨绉诲姩锛堢孩绾匡級銆傛湰鍦版秱鍧愭爣灏辨槸杩欑銆?- 涓嶅緱 JS/TS 鍐嶅啓涓€浠?WorldChange / LogicTransform 瑙ｆ瀽锛圓DR-067锛夈€?- 涓嶅緱涓烘梺瑙傚彂鏄庣涓夌涓栫晫瀵硅薄锛堝彧鏈変綋绱犱笌瀹炰綋锛夈€?- 涓嶅緱鎶?`RecordingAbilityPhysicsPort` 鎹㈡垚銆屾亽鎴愬姛浣撶礌鎻愪氦銆嶆垨璺宠繃 Ability銆?- 涓嶅緱鎶?launcher 鐨?BLOCKED_ENV 鏀?PASS锛圓DR-088 澶辫触璇箟锛夈€?- 涓嶅緱鍋氬崄鍥涙銆乵esher銆亀asm 浣撶礌浜у搧璺緞銆佹墜鏈烘祻瑙堝櫒銆?- 涓嶅緱鍦?Wave A 璧?100 Bot 鐪熸嫇鎵戙€?- 涓嶅緱 squash-merge锛涗笉寰楁妸 worktree 鏀捐繘 `.claude/worktrees`銆?- 涓嶅緱鍥炴樉 Platform / admission 瀹屾暣绁紱鏃ュ織绾cted銆?
---

## 8. 涓讳細璇濊皟搴︽竻鍗曪紙浣犺嚜宸辨墽琛岋紝涓嶈涓㈢粰涓€涓瓙 Agent 涓茶鍟冨叚浠擄級

```text
T=0     鍏釜 worktree + 鍏釜鍒嗘敮鍚屾椂寤哄ソ
T=0     鍏釜瀛?Agent 鍚屾椂娲?A1鈥揂6锛堝悇璐?搂0鈥撀? + 鑷繁閭ｄ竴鑺傦級
        绛夊緟鍏ㄩ儴浜ゅ洖 PR
        姣?PR锛氭湰浠撴祴璇曠豢 鈫?鍚堝叆 origin/main锛坢erge commit锛?        A2 涓?A4 鏈夋帴鍙ｈ€﹀悎锛欰dmitPlayer 鍏ㄥ悕浠?A2 浜ゅ洖涓哄噯锛?          鑻?A4 鍏堝啓瀹岋紝鍏佽瀹冩寜 搂3.3 鐨勫缓璁悕鍙嶅皠锛孉2 蹇呴』鎻愪緵璇ュ悕
T=鍚堝叆鍚? 涓讳細璇?Wave B锛岀姝㈠啀寮€鍐欎唬鐮佹矙鐩掓姠鏈哄櫒
```

**鍚屼粨涓や釜 worktree 鐨勫悎鍏ラ『搴忥細**

- Client锛欰1 涓?A5 鏃犳枃浠堕噸鍙狅紝璋佸厛缁胯皝鍏堝悎銆?- Sample锛欰2 鍏堝悎锛堢帺娉曪級锛孉6 鍐嶅悎锛坙auncher锛夈€侫6 涓嶈 rebase 鍒拌繃鏈?main 涓婂彔鐜╂硶 diff銆?
**闃诲鍗囩骇锛堢珛鍒诲洖鎶?Owner锛屼笉瑕佹敼鑼冨洿锛夛細**

- Sample 瀹㈡埛绔▼搴忛泦 `LumioEcsSide=client` 缂栦笉杩囷紙鍘嗗彶 CS1061锛夆啋 A5 鍋滐紝鎶ユ枃浠跺垪琛紝涓嶈鍦?JS 閲岀紪瑙ｇ爜椤舵浛銆?- Admit 鍚庝笘鐣岄噷娌℃湁 `PlayerEntity` 鈫?A4/A2 鐨勯棶棰橈紝Wave B 鍋滃湪姝ラ 5銆?- Activate 鍙戝嚭浣嗕綅缃笉鍙?鈫?绔彛娌℃寕鎴?Reject(3)锛屾煡 A2/A3锛屼笉瑕佸湪 Bot 閲?SetLocalPose 鏁戝満銆?
---

## 9. 缁欐瘡涓瓙 Agent 鐨勫紑澶村璇濓紙澶嶅埗鍚庢帴 搂4 瀵瑰簲鑺傦級

```text
浣犲彧鍋氭湰娌欑洅鐧藉悕鍗曟枃浠躲€備笉瑕?git pull 鍒汉鐨勬湭鍚堝垎鏀潵銆屽厛鑱旇皟銆嶃€?涓嶈璧?lumio-ds銆佷笉瑕佽捣 100 Bot銆佷笉瑕佸紑娴忚鍣ㄣ€?鏈粨鍗曟祴蹇呴』璺戯紝鎶婂懡浠ゅ拰閫€鍑虹爜鍐欒繘浜ゅ洖銆?浜ゅ洖鏍煎紡锛氭敼鍔ㄦ竻鍗?/ 楠岃瘉鍛戒护涓庤緭鍑?/ known gaps / PR URL / 鏄惁鏀逛簡鍐荤粨鎺ュ彛锛堥粯璁ゅ惁锛夈€?鍐荤粨鎺ュ彛鍦ㄦ彁绀鸿瘝 搂3锛涜鏀瑰悕瀛楀厛鍋溿€?宸ヤ綔鐩綍 = 鎸囧畾 worktree锛屼笉瑕佸啓杩涗粨鐨勪富 checkout銆?```

---

## 10. 鑳屾櫙閿氱偣锛堝彧璇伙紝涓嶅湪鏈垏鐗囦慨鏀癸級

- 鐩爣鍒囩墖瀹氫箟锛氭灦鏋勪粨 `.spec/knowledge/features/sample.md` 鍒ゆ嵁 2 绗竴闃舵鏃佽锛涗粖鏃ユ瘮瀹冩洿绐勶紙鍙鐪嬭璧帮級銆?- 娴忚鍣ㄨ鍒欎唬鐮侊細ADR-067銆備綋绱犵綉鏍硷細ADR-078锛堜粖鏃ヤ笉鍋氾級銆?- 鍚姩鍣ㄦ梺瑙傚彞锛欰DR-077 鍐崇瓥 5锛沗LumioServer/eng/connect-ds.mjs`銆?- 鏄ㄥぉ璇鐨勬湰鍦版秱鍧愭爣锛歚LumioClient/modules/bot/host/BotHostResidentLoop.cs` 绾?183鈥?96 琛屻€?- 绌哄湴绔彛锛歚LumioGameRuntime/modules/gas/src/Lumio.GameRuntime.Gas/Ability/IAbilityPhysicsPort.cs` 鐨?`RecordingAbilityPhysicsPort`銆?- MoveAbility fail-closed锛歚LumioSample/src/Lumio.Sample.Gameplay/Abilities/MoveAbility.cs`銆?- 鍑虹エ鐜板満锛歚LumioPlatform/.spec/reviews/2026-09-10-r-00586-r-00421-live-evidence.md`銆?
