# Platform compose（内部）

判据 2 第一阶段的 Platform 镜像从私有仓 `build: .`。公开 clone 拿不到那份 compose，本目录因此不放 `docker-compose.yml`——放一份指向私仓路径的文件会变成死配置，也会把私仓名写进模板。

内部验收把 compose 文件路径交给启动器：

```bash
export LUMIO_PLATFORM_COMPOSE=/path/to/internal-platform-compose.yml
export LUMIO_PLATFORM_ORIGIN=http://127.0.0.1:…
node integration/launcher.mjs --bots 2
```

外部机器在 S-16 发布前不应指望一条命令起 Platform。缺这份文件时启动器印 `BLOCKED_ENV` 并 exit 2。
