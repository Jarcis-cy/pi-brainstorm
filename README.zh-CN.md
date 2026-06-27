# pi-meeting-blackboard

面向 [pi](https://github.com/earendil-works/pi-coding-agent) subagent 的黑板式头脑风暴和争论会议扩展。

`pi-meeting-blackboard` 增加 `/brainstorm2` 和 `/debate2`。它不再把每个参与者的长篇发言传回主持人上下文，再让主持人复述、再补写会议记录；参与者会通过 append-only 的会议黑板工具，把完整发言直接写入 `.pi-meetings/...`。主会话只接收短卡片和主持人的结构化总结。

English README: [README.md](./README.md).

## 为什么需要它

旧的纯 prompt 版 brainstorm/debate 有几个实际问题：

- 子 Agent 输出较长时容易被工具输出限制截断。
- 主持人上下文被迫承载“接收全文、复述全文、再记录全文”的重复数据流。
- 会议记录是事后重建的，不是会议过程中的事实源。

这个包把数据流改成：

```text
参与者 -> meeting_append_entry -> .pi-meetings/... 文件
参与者 -> 短 WROTE_ENTRY 摘要 -> 主持人上下文
文件 watcher -> 短卡片 -> 主会话可见区域
主持人 -> 共识 / 分歧 / 最终结论
```

黑板文件天然就是 transcript。主持人只负责综合和推进。

## 安装

通过 npm 安装：

```bash
pi install npm:pi-meeting-blackboard
```

通过 GitHub 安装：

```bash
pi install git:github.com/Jarcis-cy/pi-meeting-blackboard@v0.1.0
```

本地开发安装：

```bash
pi install /Users/jarcis/Project/pi-meeting-blackboard
```

## 前置条件

该扩展依赖 pi 中已有的 `subagent` 工具。命令处理器会先创建黑板目录，然后让主 Agent 调用这些参与者：

- `gpt-brainstormer`
- `deepseek-brainstormer`
- `minimax-brainstormer`

第一次使用时，如果这些用户级 agent 不存在，扩展会询问是否把内置默认定义写入 `~/.pi/agent/agents/`。已有同名文件不会被覆盖。

## 命令

```text
/brainstorm2 <主题>
/debate2 <主题>
```

`/brainstorm2` 启动三轮黑板式头脑风暴。

`/debate2` 启动开放式黑板争论，直到收敛或用户介入为止。

它不会替换旧的 `/brainstorm` 和 `/debate`。

## 工具

扩展注册三个会议工具：

- `meeting_append_entry`：把参与者完整发言写入磁盘，只返回短引用。
- `meeting_read_index`：读取黑板索引，包含 id、speaker、phase、summary、path。
- `meeting_read_entry`：在主持人或参与者需要时读取某条完整发言。

## 文件结构

每次会议会在当前工作目录下创建 append-only 目录：

```text
.pi-meetings/YYYY-MM-DD-topic/
  manifest.json
  index.jsonl
  blackboard.md
  entries/
    0001-gpt-round_1.md
    0002-deepseek-round_1.md
```

`blackboard.md` 是自然形成的完整会议记录。`index.jsonl` 是紧凑索引。参与者全文放在 `entries/`。

## 安全边界

扩展会校验会议路径必须留在当前工作区的 `.pi-meetings/` 下，并拒绝符号链接形式的会议目录、entry 文件、index 文件和 blackboard 文件。entry 写入使用 exclusive creation，避免覆盖已有文件。

## 开发

```bash
npm pack --dry-run
```

该扩展由 pi 的扩展加载器直接加载 TypeScript。运行时从 pi 引入的 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 和 `typebox` 按 pi package 规范声明为 peer dependencies。

## License

MIT
