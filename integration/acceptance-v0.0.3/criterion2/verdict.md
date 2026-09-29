判据2：十四步全 PASS（VERIFICATION_STATUS=PASS, exit=0）
克隆：--recursive @ 0d7578b，Engine=v0.0.3(f56e066)
步骤：01-14 全 PASS（挖掘链路 9-13、存档重启断言 14 均 PASS）
命令：node Tools/launcher.mjs --bots 2 --tour-ticks 15000 --scenario-dll Client/Bots/bin/Debug/net10.0/Lumio.Sample.Bots.dll
前置：dotnet build Gameplay -p:LumioEcsSide=client + Client/Bots 构建
