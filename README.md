# pi-meeting-blackboard

Blackboard-based brainstorm and debate meetings for [pi](https://github.com/earendil-works/pi-coding-agent) subagents.

`pi-meeting-blackboard` adds `/brainstorm2` and `/debate2`. Instead of sending every participant's long answer through the facilitator's context and then asking the facilitator to repeat it, participants write their full contributions to `.pi-meetings/...` through an append-only meeting blackboard. The main chat receives only short entry cards and facilitator summaries.

中文说明见 [README.zh-CN.md](./README.zh-CN.md).

## Why

The original prompt-only brainstorm/debate flow had three practical problems:

- Long subagent outputs can be truncated by tool output limits.
- The facilitator wastes context by receiving, repeating, and then recording the same text.
- Meeting records are reconstructed after the fact instead of being the natural source of truth.

This package changes the data flow:

```text
participant -> meeting_append_entry -> .pi-meetings/... files
participant -> short WROTE_ENTRY summary -> facilitator context
file watcher -> compact visible card -> main chat
facilitator -> structural summary / final conclusion
```

The blackboard files become the transcript. The facilitator stays focused on synthesis.

## Install

From npm:

```bash
pi install npm:pi-meeting-blackboard
```

From GitHub:

```bash
pi install git:github.com/Jarcis-cy/pi-meeting-blackboard@v0.1.0
```

For local development:

```bash
pi install /Users/jarcis/Project/pi-meeting-blackboard
```

## Prerequisites

This extension expects pi's `subagent` tool to be available. The command handler creates the blackboard and then instructs the main agent to run:

- `gpt-brainstormer`
- `deepseek-brainstormer`
- `minimax-brainstormer`

On first use, if any of these user-level agents are missing, the extension asks before writing bundled defaults to `~/.pi/agent/agents/`. Existing files are never overwritten.

## Commands

```text
/brainstorm2 <topic>
/debate2 <topic>
```

`/brainstorm2` starts a three-round blackboard brainstorming session.

`/debate2` starts an open-ended blackboard debate that should continue until convergence or user intervention.

The older `/brainstorm` and `/debate` commands are not replaced.

## Tools

The extension registers three tools for meeting participants and the facilitator:

- `meeting_append_entry` writes a full participant contribution to disk and returns only a short reference.
- `meeting_read_index` lists blackboard entries by id, speaker, phase, summary, and path.
- `meeting_read_entry` reads one full entry when the facilitator or a participant needs it.

## Files

Each meeting writes an append-only folder under the current working directory:

```text
.pi-meetings/YYYY-MM-DD-topic/
  manifest.json
  index.jsonl
  blackboard.md
  entries/
    0001-gpt-round_1.md
    0002-deepseek-round_1.md
```

`blackboard.md` is the natural transcript. `index.jsonl` is the compact context entry point. Full participant text lives in `entries/`.

## Safety

The extension validates that meeting paths stay under the current workspace's `.pi-meetings/` directory and rejects symlinked meeting paths, entry files, index files, and blackboard files. Entry writes use exclusive creation to avoid overwriting existing files.

## Development

```bash
npm pack --dry-run
```

The extension is TypeScript loaded by pi through its extension loader. Runtime dependencies imported from pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) are declared as peer dependencies per pi package guidance.

## License

MIT
