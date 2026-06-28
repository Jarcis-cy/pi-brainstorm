# pi-meeting-blackboard

面向 [pi](https://github.com/earendil-works/pi-coding-agent) subagent 的黑板式头脑风暴和争论会议扩展。

`pi-meeting-blackboard` 提供两个会议命令：`/brainstorm2` 和 `/debate2`。会议中，每个参与者会把完整发言写入 `.pi-meetings/...` 下的 append-only 黑板文件。主会话展示紧凑的发言卡片和主持人的结构化总结，完整 transcript 则保留在磁盘上。

English README: [README.md](./README.md).

## 功能

- 基于 `.pi-meetings/` 的黑板式会议记录。
- 主会话中展示紧凑的参与者发言卡片。
- 参与者完整发言以 Markdown 文件保存。
- 使用 JSONL 索引作为轻量级跨轮上下文入口。
- 内置头脑风暴和争论会议命令。
- 首次使用时可安装内置的默认参与者 agent 定义。

## 安装

通过 npm 安装：

```bash
pi install npm:pi-meeting-blackboard
```

通过 GitHub 安装：

```bash
pi install git:github.com/Jarcis-cy/pi-meeting-blackboard@v0.1.1
```

本地开发安装：

```bash
pi install /Users/jarcis/Project/pi-meeting-blackboard
```

## 前置条件

该扩展依赖 pi 中已有的 `subagent` 工具。命令处理器会先创建会议黑板，然后让主 Agent 调用这些参与者：

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

## 工作方式

```text
参与者 -> meeting_append_entry -> .pi-meetings/... 文件
参与者 -> 短 WROTE_ENTRY 摘要 -> 主持人上下文
文件 watcher -> 短卡片 -> 主会话可见区域
主持人 -> 共识 / 分歧 / 最终结论
```

黑板文件是会议事实源。主持人可以按需读取索引或具体条目，然后生成结构化总结。

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

`blackboard.md` 是完整会议记录。`index.jsonl` 是紧凑索引。参与者全文放在 `entries/`。

## 安全边界

扩展会校验会议路径必须留在当前工作区的 `.pi-meetings/` 下，并拒绝符号链接形式的会议目录、entry 文件、index 文件和 blackboard 文件。entry 写入使用 exclusive creation，避免覆盖已有文件。

## 开发

```bash
npm pack --dry-run
```

该扩展由 pi 的扩展加载器直接加载 TypeScript。运行时从 pi 引入的 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 和 `typebox` 按 pi package 规范声明为 peer dependencies。

## License

MIT
