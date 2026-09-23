<!-- lumio:init -->
## LumioAgentSpec

本项目使用 LumioAgentSpec 插件的调度与编码规程。项目自身的定位、收口门槛与知识导航见:

- [`.spec/AGENTS.md`](.spec/AGENTS.md) —— 项目中心文档(先读)
- [`.spec/knowledge/README.md`](.spec/knowledge/README.md) —— 知识导航
- [`.spec/decisions/`](.spec/decisions/README.md) —— 决策唯一落点(ADR)

中心文档与知识导航在每次会话强制载入（漏了 = 会话静默不加载）：

@.spec/AGENTS.md

@.spec/knowledge/README.md

> 通用规程与硬红线由插件在每次会话注入(Claude Code);无此机制的宿主请主动读取上述文件。
