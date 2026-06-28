# pi-brainstorm

Multi-model brainstorming and debate sessions for [pi](https://github.com/earendil-works/pi-coding-agent).

`pi-brainstorm` lets different models from different providers join the same discussion. Use `/brainstorm` for a structured round-robin ideation session, or `/debate` for a more adversarial battle where agents challenge each other's assumptions until the discussion converges.

The plugin stores each participant's full contribution in a local meeting blackboard under `.pi-meetings/...`. The blackboard is an implementation feature: it keeps the main chat focused on compact cards, summaries, conflicts, and conclusions while preserving the complete transcript on disk.

中文说明见 [README.zh-CN.md](./README.zh-CN.md).

## Features

- Multi-model brainstorming with GPT, DeepSeek, and MiniMax style participants.
- Debate / battle mode where agents prosecute, stress-test, and challenge positions.
- Round-by-round summaries focused on consensus, disagreement, and next questions.
- Full participant contributions stored as Markdown files under `.pi-meetings/`.
- Compact visible cards in the main conversation instead of long pasted transcripts.
- JSONL index for lightweight cross-round context.
- Bundled default participant agent definitions for first-time setup.

## Install

From npm:

```bash
pi install npm:pi-brainstorm
```

From GitHub:

```bash
pi install git:github.com/Jarcis-cy/pi-brainstorm@v0.2.0
```

For local development:

```bash
pi install /Users/jarcis/Project/pi-brainstorm
```

## Prerequisites

This extension expects pi's `subagent` tool to be available. The command handler creates the local meeting record and then instructs the main agent to run:

- `gpt-brainstormer`
- `deepseek-brainstormer`
- `minimax-brainstormer`

On first use, if any of these user-level agents are missing, the extension asks before writing bundled defaults to `~/.pi/agent/agents/`. Existing files are never overwritten.

## Commands

```text
/brainstorm <topic>
/debate <topic>
```

`/brainstorm` starts a three-round multi-model brainstorming session.

`/debate` starts an open-ended multi-agent battle that should continue until convergence or user intervention.

## How It Works

```text
participant model -> meeting_append_entry -> .pi-meetings/... files
participant model -> short WROTE_ENTRY summary -> facilitator context
file watcher -> compact visible card -> main chat
facilitator -> consensus / disagreement / final synthesis
```

The blackboard files are the source of truth for the session. The facilitator can read the index or specific entries when producing summaries.

## Tools

The extension registers three tools for participants and the facilitator:

- `meeting_append_entry` writes a full participant contribution to disk and returns only a short reference.
- `meeting_read_index` lists entries by id, speaker, phase, summary, and path.
- `meeting_read_entry` reads one full entry when the facilitator or a participant needs it.

## Files

Each session writes an append-only folder under the current working directory:

```text
.pi-meetings/YYYY-MM-DD-topic/
  manifest.json
  index.jsonl
  blackboard.md
  entries/
    0001-gpt-round_1.md
    0002-deepseek-round_1.md
```

`blackboard.md` is the full transcript. `index.jsonl` is the compact context entry point. Full participant text lives in `entries/`.

## Safety

The extension validates that meeting paths stay under the current workspace's `.pi-meetings/` directory and rejects symlinked meeting paths, entry files, index files, and blackboard files. Entry writes use exclusive creation to avoid overwriting existing files.

## Development

```bash
npm pack --dry-run
```

The extension is TypeScript loaded by pi through its extension loader. Runtime dependencies imported from pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) are declared as peer dependencies per pi package guidance.

## License

MIT
