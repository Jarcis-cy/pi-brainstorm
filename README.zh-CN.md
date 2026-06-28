# pi-brainstorm

面向 [pi](https://github.com/earendil-works/pi-coding-agent) 的多模型头脑风暴与辩论插件。

`pi-brainstorm` 让来自不同供应商的不同模型参与同一场讨论。使用 `/brainstorm` 启动结构化的多轮头脑风暴；使用 `/debate` 启动更强对抗性的 battle，让不同 Agent 互相质疑假设、攻击薄弱点，直到讨论收敛。

插件会把每个参与者的完整发言保存在 `.pi-meetings/...` 下的本地会议黑板中。黑板是实现亮点，不是主要卖点：它让主会话保持简洁，只展示短卡片、主持人总结、共识、分歧和最终结论，同时完整 transcript 仍然保存在磁盘上。

English README: [README.md](./README.md).

## 功能

- 多模型头脑风暴：默认包含 GPT、DeepSeek、MiniMax 风格参与者。
- 辩论 / battle 模式：Agent 会攻击、审视、反驳彼此的观点。
- 每轮输出聚焦共识、分歧、关键问题和下一步方向。
- 参与者完整发言以 Markdown 文件保存到 `.pi-meetings/`。
- 主会话中展示紧凑发言卡片，而不是粘贴长篇 transcript。
- 使用 JSONL 索引作为轻量级跨轮上下文入口。
- 首次使用时可安装内置的默认参与者 agent 定义。

## 安装

通过 npm 安装：

```bash
pi install npm:pi-brainstorm
```

通过 GitHub 安装：

```bash
pi install git:github.com/Jarcis-cy/pi-brainstorm@v0.2.0
```

本地开发安装：

```bash
pi install /Users/jarcis/Project/pi-brainstorm
```

## 前置条件

该扩展依赖 pi 中已有的 `subagent` 工具。命令处理器会先创建本地会议记录，然后让主 Agent 调用这些参与者：

- `gpt-brainstormer`
- `deepseek-brainstormer`
- `minimax-brainstormer`

第一次使用时，如果这些用户级 agent 不存在，扩展会询问是否把内置默认定义写入 `~/.pi/agent/agents/`。已有同名文件不会被覆盖。

## 命令

```text
/brainstorm <主题>
/debate <主题>
```

`/brainstorm` 启动三轮多模型头脑风暴。

`/debate` 启动开放式多 Agent battle，直到收敛或用户介入为止。

## 工作方式

```text
参与者模型 -> meeting_append_entry -> .pi-meetings/... 文件
参与者模型 -> 短 WROTE_ENTRY 摘要 -> 主持人上下文
文件 watcher -> 短卡片 -> 主会话可见区域
主持人 -> 共识 / 分歧 / 最终综合
```

黑板文件是会话事实源。主持人可以按需读取索引或具体条目，然后生成结构化总结。

## 工具

扩展注册三个工具：

- `meeting_append_entry`：把参与者完整发言写入磁盘，只返回短引用。
- `meeting_read_index`：读取条目索引，包含 id、speaker、phase、summary、path。
- `meeting_read_entry`：在主持人或参与者需要时读取某条完整发言。

## 文件结构

每次会话会在当前工作目录下创建 append-only 目录：

```text
.pi-meetings/YYYY-MM-DD-topic/
  manifest.json
  index.jsonl
  blackboard.md
  entries/
    0001-gpt-round_1.md
    0002-deepseek-round_1.md
```

`blackboard.md` 是完整 transcript。`index.jsonl` 是紧凑索引。参与者全文放在 `entries/`。

## 安全边界

扩展会校验会议路径必须留在当前工作区的 `.pi-meetings/` 下，并拒绝符号链接形式的会议目录、entry 文件、index 文件和 blackboard 文件。entry 写入使用 exclusive creation，避免覆盖已有文件。

## 开发

```bash
npm pack --dry-run
```

该扩展由 pi 的扩展加载器直接加载 TypeScript。运行时从 pi 引入的 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 和 `typebox` 按 pi package 规范声明为 peer dependencies。

## License

MIT
