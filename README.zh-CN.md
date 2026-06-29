# pi-brainstorm

面向 [pi](https://github.com/earendil-works/pi-coding-agent) 的多模型头脑风暴与辩论插件。

`pi-brainstorm` 让来自不同供应商的不同模型参与同一场讨论。使用 `/brainstorm` 启动结构化的多轮头脑风暴；使用 `/debate` 启动更强对抗性的 battle，让不同 Agent 互相质疑假设、攻击薄弱点，直到讨论收敛。

插件会把每个参与者的完整发言保存在 `.pi-meetings/...` 下的本地会议黑板中。黑板是实现亮点，不是主要卖点：它让主会话保持简洁，只展示短卡片、主持人总结、共识、分歧和最终结论，同时完整 transcript 仍然保存在磁盘上。

English README: [README.md](./README.md).

## 功能

- 多模型头脑风暴：参与者可配置（默认：GPT、DeepSeek、MiniMax、GLM）。
- 辩论 / battle 模式：Agent 会攻击、审视、反驳彼此的观点。
- 配置驱动：通过 YAML 添加、删除或自定义参与者。
- 每轮输出聚焦共识、分歧、关键问题和下一步方向。
- 参与者完整发言以 Markdown 文件保存到 `.pi-meetings/`。
- 主会话中展示紧凑发言卡片，而不是粘贴长篇 transcript。
- 使用 JSONL 索引作为轻量级跨轮上下文入口。
- 由配置自动生成托管的 agent 文件——更新一个 YAML，所有 agent 同步。

## 安装

通过 npm 安装：

```bash
pi install npm:pi-brainstorm
```

通过 GitHub 安装：

```bash
pi install git:github.com/Jarcis-cy/pi-brainstorm@v0.4.0
```

本地开发安装：

```bash
pi install /Users/jarcis/Project/pi-brainstorm
```

## 配置

参与者通过 YAML 定义。插件按以下顺序加载配置（后者覆盖前者）：

1. 包默认配置：`config/default.yaml`（随包发布）
2. 用户级覆盖：`~/.pi/agent/pi-brainstorm.yaml`
3. 项目级覆盖：`.pi-brainstorm.yaml` 或 `.pi/pi-brainstorm.yaml`

数组（如 `participants`）整体替换；对象字段深度合并。

### 添加新参与者

创建 `~/.pi/agent/pi-brainstorm.yaml`（用户级）或 `.pi-brainstorm.yaml`（项目级）：

```yaml
participants:
  - displayName: Claude
    agentName: claude-brainstormer
    description: Claude 头脑风暴顾问。细致入微的分析师，用于多模型讨论。
    model: anthropic/claude-sonnet-4-20250514:xhigh
    roleTitle: 细致分析师
    rolePrompt: |
      你是多模型头脑风暴中的分析顾问。擅长细致入微的论证和长篇分析。用中文回答。
    whatYouDo:
      - 提供细致、深入的逐点分析
      - 识别细微差别和边缘情况
      - 撰写结构清晰的长篇论证
    debatePersona:
      label: THE ANALYST
      prompt: |
        DEBATE MODE. You are THE ANALYST. Dissect every argument with precision. Find the weakest link in every chain of reasoning. Use Chinese.
    brainstormRole: 细致分析师
```

如需完全替换默认参与者，在覆盖文件中定义完整的 `participants` 列表即可。

用户级配置可以在确认后创建或更新 `~/.pi/agent/agents/` 下的受管理 agent 文件。项目级配置只影响当前会话编排，但不会自动写入全局 agent 文件；如果需要自动同步 agent，请手动创建对应 agent，或把配置移到 `~/.pi/agent/pi-brainstorm.yaml`。

### 托管的 Agent 文件

由 pi-brainstorm 生成的 agent 文件包含 `<!-- managed-by: pi-brainstorm -->` 标记。当配置变更时，这些文件会被覆盖。不含此标记的已有 agent 文件永远不会被修改。

## 前置条件

`pi-brainstorm` 通过 Pi 的 `subagent` 工具来调用各个参与者。使用 `/brainstorm` 或 `/debate` 前，请先单独安装提供 `subagent` 工具的包：

```bash
pi install npm:@narumitw/pi-subagents
```

`@narumitw/pi-subagents` 会注册 `subagent` 工具，让 `pi-brainstorm` 能把参与者作为隔离的 Pi 子进程运行。它是运行时前置条件，不随 `pi-brainstorm` 打包。

作为参考，Pi coding-agent 发行包中也包含一个 example implementation，通常位于：

```text
/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/
```

命令处理器会先创建本地会议记录，然后让主 Agent 通过 `subagent` 调用配置中定义的参与者（默认：`gpt-brainstormer`、`deepseek-brainstormer`、`minimax-brainstormer`、`glm-brainstormer`）。

第一次使用时，如果这些用户级 agent 不存在，扩展会询问是否写入内置默认定义。已有同名且不含托管标记的文件不会被覆盖。

## 命令

```text
/brainstorm <主题>
/debate <主题>
```

`/brainstorm` 启动交互式三轮多模型头脑风暴。Round 1 和 Round 2 结束后，主持人应停止、总结本轮，并等待你的反馈或继续许可，再进入下一轮。

`/debate` 启动开放式多 Agent battle，直到收敛或用户介入为止。

## 工作方式

```text
参与者模型 -> meeting_append_entry -> .pi-meetings/... 文件
参与者模型 -> 短 WROTE_ENTRY 摘要 -> 主持人上下文
文件 watcher -> 短卡片 -> 主会话可见区域
主持人 -> 每轮 checkpoint / 共识 / 分歧 / 最终综合
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
