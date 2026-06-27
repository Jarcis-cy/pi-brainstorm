/**
 * meeting-blackboard — Blackboard-based brainstorm/debate extension for Pi
 *
 * Replaces in-chat passing of giant agent responses with a filesystem-based
 * blackboard. Subagents write their full contribution to disk via a tool,
 * and the main conversation only sees short entry notification cards.
 *
 * Features:
 * - meeting_append_entry tool — concurrency-safe append to meeting folder
 * - meeting_read_index tool — read meeting index
 * - meeting_read_entry tool — read full entry content
 * - /brainstorm2 command — blackboard-based brainstorming
 * - /debate2 command — blackboard-based open-ended debate
 * - meeting-entry message renderer — compact cards with expandable content
 * - File watcher — auto-posts new entries into the main conversation
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text, Box } from "@earendil-works/pi-tui";

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

/** Sanitize a string for use in filenames (keep letters, digits, hyphens, underscores). */
function sanitizeFilenamePart(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60)
    .toLowerCase() || "unknown";
}

/** Convert a topic string to a filesystem-safe slug. */
function topicToSlug(topic: string): string {
  return sanitizeFilenamePart(topic).slice(0, 40);
}

/** Format today's date as YYYY-MM-DD. */
function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Validate that meetingDir is a subdirectory of cwd/.pi-meetings. Returns the resolved absolute path. */
function validateMeetingDir(meetingDir: string, cwd: string): string {
  const resolved = path.resolve(cwd, meetingDir);
  const meetingsRoot = path.resolve(cwd, ".pi-meetings");
  if (!fs.existsSync(meetingsRoot)) {
    fs.mkdirSync(meetingsRoot, { recursive: true });
  }
  assertDirectoryNoSymlink(meetingsRoot, "meetings root");
  assertPathInside(meetingsRoot, resolved, "meetingDir");
  const rootReal = fs.realpathSync(meetingsRoot);
  const targetReal = fs.existsSync(resolved)
    ? fs.realpathSync(resolved)
    : fs.realpathSync(path.dirname(resolved));
  assertPathInside(rootReal, targetReal, "meetingDir real path");
  return resolved;
}

function assertPathInside(baseDir: string, targetPath: string, label: string): void {
  const rel = path.relative(baseDir, targetPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} must stay under ${baseDir}, got ${targetPath}`);
  }
}

function assertDirectoryNoSymlink(dirPath: string, label: string): void {
  const stat = fs.lstatSync(dirPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${dirPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory: ${dirPath}`);
  }
}

function assertExistingFileNoSymlink(filePath: string, label: string): void {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
}

function assertWritableFilePath(filePath: string, baseDir: string, label: string): void {
  assertPathInside(baseDir, filePath, label);
  if (fs.existsSync(filePath)) {
    assertExistingFileNoSymlink(filePath, label);
    assertPathInside(fs.realpathSync(baseDir), fs.realpathSync(filePath), `${label} real path`);
  }
}

/** Parse entry filename like "0001-gpt-round-1.md" into parts. */
function parseEntryFilename(
  filename: string
): { id: string; speaker: string; phase: string } | null {
  const match = filename.match(/^(\d{4})-(.+)-(.+)\.md$/);
  if (!match) return null;
  return { id: match[1], speaker: match[2], phase: match[3] };
}

/** Read the first heading from an entry file to use as display summary. */
function readEntrySummary(absPath: string): string {
  try {
    const content = fs.readFileSync(absPath, "utf-8");
    const m = content.match(/^#\s*(.+)$/m);
    return m ? m[1].trim() : path.basename(absPath, ".md");
  } catch {
    return path.basename(absPath, ".md");
  }
}

// ────────────────────────────────────────────────────────
// Watcher management
// ────────────────────────────────────────────────────────

/** Active watchers: meetingDir (absolute) → { watcher, debounce timers } */
const activeWatchers = new Map<
  string,
  { watcher: fs.FSWatcher; debounceTimers: Map<string, NodeJS.Timeout> }
>();

function startWatching(pi: ExtensionAPI, meetingDir: string): void {
  const absDir = meetingDir;
  const entriesDir = path.join(absDir, "entries");

  // Ensure entries directory exists
  fs.mkdirSync(entriesDir, { recursive: true });
  assertDirectoryNoSymlink(absDir, "meeting directory");
  assertDirectoryNoSymlink(entriesDir, "entries directory");

  // Stop any existing watcher for this meeting
  stopWatching(absDir);

  const debounceTimers = new Map<string, NodeJS.Timeout>();

  const watcher = fs.watch(entriesDir, (_eventType, filename) => {
    if (!filename || !filename.endsWith(".md")) return;

    // Debounce: wait 300ms before processing to let the file be fully written
    const existing = debounceTimers.get(filename);
    if (existing) clearTimeout(existing);

    debounceTimers.set(
      filename,
      setTimeout(() => {
        debounceTimers.delete(filename);
        const entryPath = path.join(entriesDir, filename);
        try {
          if (!fs.existsSync(entryPath)) return;
          assertExistingFileNoSymlink(entryPath, "meeting entry");
          assertPathInside(fs.realpathSync(entriesDir), fs.realpathSync(entryPath), "meeting entry real path");
          const parsed = parseEntryFilename(filename);
          if (!parsed) return;
          const summary = readEntrySummary(entryPath);

          pi.sendMessage(
            {
              customType: "meeting-entry",
              content: `${parsed.speaker} · ${parsed.phase}`,
              display: true,
              details: {
                path: entryPath,
                speaker: parsed.speaker,
                phase: parsed.phase,
                summary,
                meetingDir: absDir,
              },
            },
            { deliverAs: "steer" }
          );
        } catch {
          // Silently ignore watcher errors
        }
      }, 300)
    );
  });

  watcher.on("error", () => {
    // Silently handle watcher errors (e.g., directory deleted)
  });

  activeWatchers.set(absDir, { watcher, debounceTimers });
}

function stopWatching(meetingDir: string): void {
  const entry = activeWatchers.get(meetingDir);
  if (!entry) return;
  for (const timer of entry.debounceTimers.values()) {
    clearTimeout(timer);
  }
  try {
    entry.watcher.close();
  } catch {
    // Ignore close errors
  }
  activeWatchers.delete(meetingDir);
}

// ────────────────────────────────────────────────────────
// Manifest helpers
// ────────────────────────────────────────────────────────

interface MeetingManifest {
  topic: string;
  created: string;
  lastUpdate: string;
  entryCount: number;
}

const BRAINSTORM_AGENT_FILES: Record<string, string> = {
  "gpt-brainstormer.md": `---
name: gpt-brainstormer
description: GPT brainstorming consultant. Visionary strategist for multi-model discussion sessions.
tools: read, grep, find, ls, meeting_append_entry, meeting_read_index, meeting_read_entry
model: vendor-codex/gpt-5.5:xhigh
---

# GPT Brainstormer - Visionary Strategist

你是多模型头脑风暴中的愿景战略家。思考大局，发现别人忽略的机会，将复杂权衡综合为清晰方向。用中文回答。

## What You Do
- 提出创新的战略方向和解决方案
- 发现别人忽略的机会和盲点
- 把零散想法综合成连贯战略

## What You Do Not Do
- 写代码或修改项目文件，你只读项目文件
- 委派给其他 Agent
- 在聊天中直接粘贴长篇分析；当明确指示使用 meeting_append_entry 时，必须将完整贡献写入会议黑板，最终回复仅写 WROTE_ENTRY + 一句话摘要

## Worker Preamble
You are a terminal worker. Work directly with tools. Do NOT spawn sub-agents.
`,
  "deepseek-brainstormer.md": `---
name: deepseek-brainstormer
description: DeepSeek brainstorming consultant. Meticulous systems thinker for multi-model discussion sessions.
tools: read, grep, find, ls, meeting_append_entry, meeting_read_index, meeting_read_entry
model: deepseek/deepseek-v4-pro:xhigh
---

# DeepSeek Brainstormer - Meticulous Systems Thinker

你是多模型头脑风暴中的系统思考者。分析结构、依赖、扩展上限和失败模式。用中文回答。

## What You Do
- 从结构、依赖和风险角度分析提案
- 识别隐藏耦合、扩展上限和失败模式
- 提出具体、可实现、可验证的技术优化方案

## What You Do Not Do
- 写代码或修改项目文件，你只读项目文件
- 委派给其他 Agent
- 在聊天中直接粘贴长篇分析；当明确指示使用 meeting_append_entry 时，必须将完整贡献写入会议黑板，最终回复仅写 WROTE_ENTRY + 一句话摘要

## Worker Preamble
You are a terminal worker. Work directly with tools. Do NOT spawn sub-agents.
`,
  "minimax-brainstormer.md": `---
name: minimax-brainstormer
description: MiniMax brainstorming consultant. Creative lateral thinker for multi-model discussion sessions.
tools: read, grep, find, ls, meeting_append_entry, meeting_read_index, meeting_read_entry
model: minimax-cn/MiniMax-M3:xhigh
---

# MiniMax Brainstormer - Creative Lateral Thinker

你是多模型头脑风暴中的创意顾问。跳出框框思考，挑战隐性假设，提出非常规方案。用中文回答。

## What You Do
- 从意想不到的角度切入问题
- 提出打破常规的创新方案
- 挑战团队隐性假设

## What You Do Not Do
- 写代码或修改项目文件，你只读项目文件
- 委派给其他 Agent
- 在聊天中直接粘贴长篇分析；当明确指示使用 meeting_append_entry 时，必须将完整贡献写入会议黑板，最终回复仅写 WROTE_ENTRY + 一句话摘要

## Worker Preamble
You are a terminal worker. Work directly with tools. Do NOT spawn sub-agents.
`,
};

async function ensureBrainstormAgents(ctx: any): Promise<boolean> {
  const agentsDir = path.join(getAgentDir(), "agents");
  const missing = Object.keys(BRAINSTORM_AGENT_FILES).filter(
    (filename) => !fs.existsSync(path.join(agentsDir, filename))
  );
  if (missing.length === 0) return true;

  if (!ctx.hasUI) {
    ctx.ui?.notify?.(
      `Missing meeting agents: ${missing.join(", ")}. Install them under ${agentsDir}.`,
      "warning"
    );
    return false;
  }

  const ok = await ctx.ui.confirm(
    "Install meeting brainstorm agents?",
    `The blackboard meeting commands need these user-level agents:\n${missing
      .map((name) => `- ${name}`)
      .join("\n")}\n\nThey will be created under ${agentsDir}. Existing files are not overwritten.`
  );
  if (!ok) return false;

  await fsp.mkdir(agentsDir, { recursive: true });
  for (const filename of missing) {
    const target = path.join(agentsDir, filename);
    await fsp.writeFile(target, BRAINSTORM_AGENT_FILES[filename], {
      encoding: "utf-8",
      flag: "wx",
    });
  }
  ctx.ui.notify(`Installed ${missing.length} meeting agent(s).`, "info");
  return true;
}

async function readManifest(absDir: string): Promise<MeetingManifest | null> {
  const manifestPath = path.join(absDir, "manifest.json");
  try {
    assertWritableFilePath(manifestPath, absDir, "manifest");
    const raw = await fsp.readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as MeetingManifest;
  } catch {
    return null;
  }
}

async function writeManifest(
  absDir: string,
  manifest: MeetingManifest
): Promise<void> {
  const manifestPath = path.join(absDir, "manifest.json");
  assertWritableFilePath(manifestPath, absDir, "manifest");
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

async function getEntryCount(absDir: string): Promise<number> {
  const indexJsonlPath = path.join(absDir, "index.jsonl");
  try {
    assertWritableFilePath(indexJsonlPath, absDir, "meeting index");
    const raw = await fsp.readFile(indexJsonlPath, "utf-8");
    if (!raw.trim()) return 0;
    return raw.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

// ────────────────────────────────────────────────────────
// Main Extension
// ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Tool: meeting_append_entry ─────────────────────────

  pi.registerTool({
    name: "meeting_append_entry",
    label: "Meeting Append Entry",
    description:
      "Append a contribution to a meeting blackboard. Write your FULL brainstorm/debate response to disk. " +
      "This is append-only and concurrency-safe. After writing, reply ONLY with WROTE_ENTRY plus a one-sentence summary — do NOT paste the full content into chat.",
    promptSnippet:
      "meeting_append_entry({ meetingDir, speaker, phase, title?, summary, content }) — write full contribution to meeting blackboard",
    promptGuidelines: [
      "Use meeting_append_entry to write your FULL brainstorm/debate contribution to disk. Then reply ONLY with 'WROTE_ENTRY: <one-sentence summary>' — do NOT repeat the full content in chat.",
    ],
    parameters: Type.Object({
      meetingDir: Type.String({
        description:
          "Absolute path to the meeting directory (e.g., /path/to/.pi-meetings/2026-06-28-my-topic)",
      }),
      speaker: Type.String({
        description: "Speaker identifier (e.g., GPT, DeepSeek, MiniMax)",
      }),
      phase: Type.String({
        description: "Meeting phase (e.g., Round 1, Round 2, Final)",
      }),
      title: Type.Optional(
        Type.String({
          description: "Optional title for this entry",
        })
      ),
      summary: Type.String({
        description:
          "One-sentence summary of this contribution (shown in meeting index)",
      }),
      content: Type.String({
        description:
          "FULL contribution content in Markdown. This is the complete text that will be stored on disk.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const absDir = validateMeetingDir(params.meetingDir, cwd);

      // Sanitize filename parts
      const speakerSlug = sanitizeFilenamePart(params.speaker);
      const phaseSlug = sanitizeFilenamePart(params.phase);

      // Use withFileMutationQueue on the manifest to serialize writes for this meeting
      assertDirectoryNoSymlink(absDir, "meeting directory");
      const manifestPath = path.join(absDir, "manifest.json");
      assertWritableFilePath(manifestPath, absDir, "manifest");

      return withFileMutationQueue(manifestPath, async () => {
        // Ensure directories exist
        const entriesDir = path.join(absDir, "entries");
        await fsp.mkdir(entriesDir, { recursive: true });
        assertDirectoryNoSymlink(entriesDir, "entries directory");

        // Read or create manifest
        let manifest = await readManifest(absDir);
        if (!manifest) {
          // Should not normally happen — commands seed the manifest
          manifest = {
            topic: path.basename(absDir),
            created: new Date().toISOString(),
            lastUpdate: new Date().toISOString(),
            entryCount: 0,
          };
          await writeManifest(absDir, manifest);
        }

        // Determine entry number from existing index
        const currentCount = await getEntryCount(absDir);
        const entryId = String(currentCount + 1).padStart(4, "0");
        const entryFilename = `${entryId}-${speakerSlug}-${phaseSlug}.md`;
        const entryRelPath = path.join("entries", entryFilename);
        const entryAbsPath = path.join(absDir, entryRelPath);
        assertWritableFilePath(entryAbsPath, absDir, "meeting entry");

        // Format the entry file content
        const heading = params.title
          ? `# ${params.speaker} (${params.phase}): ${params.title}\n\n`
          : `# ${params.speaker} (${params.phase}): ${params.summary}\n\n`;
        const entryContent = heading + params.content;

        // Write entry file. wx prevents overwriting pre-existing files or symlinks.
        await fsp.writeFile(entryAbsPath, entryContent, {
          encoding: "utf-8",
          flag: "wx",
        });

        // Append to index.jsonl
        const indexEntry = {
          id: entryId,
          speaker: params.speaker,
          phase: params.phase,
          title: params.title ?? null,
          summary: params.summary,
          path: entryRelPath,
          timestamp: new Date().toISOString(),
        };
        const indexJsonlPath = path.join(absDir, "index.jsonl");
        assertWritableFilePath(indexJsonlPath, absDir, "meeting index");
        await fsp.appendFile(
          indexJsonlPath,
          JSON.stringify(indexEntry) + "\n",
          "utf-8"
        );

        // Append to blackboard.md
        const blackboardPath = path.join(absDir, "blackboard.md");
        assertWritableFilePath(blackboardPath, absDir, "meeting blackboard");
        const blackboardEntry = [
          "",
          `## ${params.speaker} (${params.phase}): ${params.title ?? params.summary}`,
          "",
          params.content,
          "",
          "---",
          "",
        ].join("\n");
        await fsp.appendFile(blackboardPath, blackboardEntry, "utf-8");

        // Update manifest
        manifest.lastUpdate = new Date().toISOString();
        manifest.entryCount = currentCount + 1;
        await writeManifest(absDir, manifest);

        // Return only short reference — NOT full content
        return {
          content: [
            {
              type: "text" as const,
              text: `Entry ${entryId} written: ${entryRelPath} — ${params.summary}`,
            },
          ],
          details: {
            id: entryId,
            path: entryRelPath,
            summary: params.summary,
          },
        };
      });
    },
  });

  // ── Tool: meeting_read_index ──────────────────────────

  pi.registerTool({
    name: "meeting_read_index",
    label: "Meeting Read Index",
    description:
      "Read the index of all entries in a meeting blackboard. Returns the list of entries with id, speaker, phase, title, summary, and path.",
    promptSnippet:
      "meeting_read_index({ meetingDir, limit? }) — list meeting entries",
    parameters: Type.Object({
      meetingDir: Type.String({
        description:
          "Absolute path to the meeting directory (e.g., /path/to/.pi-meetings/2026-06-28-my-topic)",
      }),
      limit: Type.Optional(
        Type.Number({
          description:
            "Maximum number of entries to return (most recent first). Omit for all.",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absDir = validateMeetingDir(params.meetingDir, ctx.cwd);
      const indexJsonlPath = path.join(absDir, "index.jsonl");

      try {
        assertWritableFilePath(indexJsonlPath, absDir, "meeting index");
        const raw = await fsp.readFile(indexJsonlPath, "utf-8");
        const lines = raw
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l));

        const result = params.limit
          ? lines.slice(-params.limit).reverse()
          : [...lines].reverse();

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Meeting index (${result.length} of ${lines.length} entries):\n` +
                result
                  .map(
                    (e) =>
                      `  [${e.id}] ${e.speaker} · ${e.phase} — ${e.summary}`
                  )
                  .join("\n"),
            },
          ],
          details: { entries: result },
        };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: "Meeting index is empty or does not exist yet.",
            },
          ],
          details: { entries: [] },
        };
      }
    },
  });

  // ── Tool: meeting_read_entry ──────────────────────────

  pi.registerTool({
    name: "meeting_read_entry",
    label: "Meeting Read Entry",
    description:
      "Read the full content of a specific entry from a meeting blackboard. Use this to get the complete text of a participant's contribution.",
    promptSnippet:
      "meeting_read_entry({ meetingDir, entryPath }) — read full entry content",
    parameters: Type.Object({
      meetingDir: Type.String({
        description:
          "Absolute path to the meeting directory (e.g., /path/to/.pi-meetings/2026-06-28-my-topic)",
      }),
      entryPath: Type.String({
        description:
          "Relative path to the entry file within the meeting (e.g., entries/0001-gpt-round-1.md)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absDir = validateMeetingDir(params.meetingDir, ctx.cwd);
      const absEntryPath = path.resolve(absDir, params.entryPath);

      // Validate that entryPath doesn't escape the meeting directory
      const rel = path.relative(absDir, absEntryPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Invalid entryPath: ${params.entryPath} escapes meeting directory.`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      try {
        assertExistingFileNoSymlink(absEntryPath, "meeting entry");
        assertPathInside(fs.realpathSync(absDir), fs.realpathSync(absEntryPath), "meeting entry real path");
        const content = await fsp.readFile(absEntryPath, "utf-8");
        return {
          content: [
            {
              type: "text" as const,
              text: `Entry: ${rel}\n\n${content}`,
            },
          ],
          details: { path: rel, content },
        };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `Entry not found: ${params.entryPath}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });

  // ── Message Renderer: meeting-entry ───────────────────

  pi.registerMessageRenderer(
    "meeting-entry",
    (message, { expanded }, theme) => {
      const details = message.details as
        | {
            path?: string;
            speaker?: string;
            phase?: string;
            summary?: string;
            meetingDir?: string;
          }
        | undefined;

      const contentStr: string =
        typeof message.content === "string"
          ? message.content
          : (message.content as Array<{ type: string; text?: string }>)
              .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
              .join("");

      const speaker = details?.speaker ?? "Unknown";
      const phase = details?.phase ?? "";
      const summary = details?.summary ?? contentStr;

      // Compact view: speaker · phase — summary
      let text = theme.fg("accent", `▸ ${speaker}`);
      if (phase) text += theme.fg("dim", ` · ${phase}`);
      text += `\n${theme.fg("muted", summary)}`;

      // Expanded view: read full content from disk
      if (expanded && details?.path) {
        try {
          assertExistingFileNoSymlink(details.path, "meeting entry");
          if (details.meetingDir) {
            assertPathInside(fs.realpathSync(details.meetingDir), fs.realpathSync(details.path), "meeting entry real path");
          }
          const fullContent = fs.readFileSync(details.path, "utf-8");
          text += `\n\n${theme.fg("dim", fullContent)}`;
        } catch {
          text += `\n\n${theme.fg("error", "(entry file not found)")}`;
        }
      }

      const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
      box.addChild(new Text(text, 0, 0));
      return box;
    }
  );

  // ── Command: /brainstorm2 ─────────────────────────────

  pi.registerCommand("brainstorm2", {
    description:
      "Start a blackboard-based multi-model brainstorming session on a topic",
    handler: async (args, ctx) => {
      if (!args || !args.trim()) {
        ctx.ui.notify("Usage: /brainstorm2 <topic>", "warning");
        return;
      }

      const agentsReady = await ensureBrainstormAgents(ctx);
      if (!agentsReady) return;

      const topic = args.trim();
      const slug = topicToSlug(topic);
      const dateStr = todayStr();
      const meetingName = `${dateStr}-${slug}`;
      const absDir = validateMeetingDir(
        path.resolve(ctx.cwd, ".pi-meetings", meetingName),
        ctx.cwd
      );

      // Create meeting folder structure
      await fsp.mkdir(path.join(absDir, "entries"), { recursive: true });
      assertDirectoryNoSymlink(absDir, "meeting directory");
      assertDirectoryNoSymlink(path.join(absDir, "entries"), "entries directory");

      // Seed manifest
      const manifest: MeetingManifest = {
        topic,
        created: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
        entryCount: 0,
      };
      await writeManifest(absDir, manifest);

      // Seed index.jsonl (empty)
      const indexJsonlPath = path.join(absDir, "index.jsonl");
      assertWritableFilePath(indexJsonlPath, absDir, "meeting index");
      if (!fs.existsSync(indexJsonlPath)) {
        await fsp.writeFile(indexJsonlPath, "", "utf-8");
      }

      // Seed blackboard.md header
      const blackboardPath = path.join(absDir, "blackboard.md");
      assertWritableFilePath(blackboardPath, absDir, "meeting blackboard");
      const blackboardHeader = [
        `# Meeting: ${topic}`,
        `> Created: ${new Date().toISOString()}`,
        `> Type: Brainstorming (3 rounds)`,
        "",
        "---",
        "",
      ].join("\n");
      await fsp.writeFile(blackboardPath, blackboardHeader, "utf-8");

      // Start watcher
      startWatching(pi, absDir);

      ctx.ui.notify(
        `🧠 Blackboard meeting: ${meetingName}\n` +
          `  Folder: .pi-meetings/${meetingName}/\n` +
          `  Watcher active — entries will appear as cards`,
        "info"
      );

      // Send orchestration prompt to main agent
      pi.sendUserMessage([
        {
          type: "text" as const,
          text: [
            `BLACKBOARD BRAINSTORMING SESSION: ${topic}`,
            "",
            `Meeting folder: \`${absDir}\``,
            "",
            "You are facilitating a round-robin brainstorming session using the MEETING BLACKBOARD.",
            "Each consultant writes their FULL contribution to disk via meeting_append_entry.",
            "",
            "## Consultants (3 rounds)",
            "- **GPT**: use the gpt-brainstormer subagent. Visionary strategist.",
            "- **DeepSeek**: use the deepseek-brainstormer subagent. Systems thinker.",
            "- **MiniMax**: use the minimax-brainstormer subagent. Creative lateral thinker.",
            "",
            "## CRITICAL INSTRUCTIONS",
            "",
            "### For subagents (include in EVERY task):",
            "1. Write your FULL contribution using the meeting_append_entry tool with:",
            `   - meetingDir: "${absDir}"`,
            "   - speaker: your name (GPT, DeepSeek, or MiniMax)",
            '   - phase: "Round 1", "Round 2", or "Round 3"',
            "   - summary: a ONE-SENTENCE summary of your contribution",
            "   - content: your FULL analysis in Chinese (中文)",
            "2. After writing, your FINAL ANSWER must be ONLY:",
            "   `WROTE_ENTRY: <your one-sentence summary>`",
            "3. DO NOT paste your full analysis into the chat. The main agent and user will read it from the blackboard.",
            "",
            "### For you, the facilitator:",
            "- Do NOT paste participant full text into chat. They are on the blackboard.",
            "- After each round, read the index with meeting_read_index and present a structural overview.",
            "- Optionally read full entries with meeting_read_entry when needed.",
            "- Present each consultant's summary + your structural overview (conflict matrix, consensus table).",
            "- When the user gives feedback, relay it VERBATIM to the consultants in the next round.",
            "",
            "## Protocol",
            "Round 1: Each consultant gives initial analysis on the topic. Run all 3 in parallel.",
            "Round 2: Feed prior discussion back to each. Ask each to challenge the others and propose improvements.",
            "Round 3: Each gives FINAL recommendation, synthesizing the best ideas.",
            "",
            "After Round 3, present the complete structural overview and a synthesized conclusion.",
            "",
            "## IMPORTANT",
            "- All responses in Chinese (中文).",
            "- Save transcript.md and (after user confirms) conclusion.md per the MEETING OUTPUT PROTOCOL.",
            "- The user can intervene at any time to steer the discussion.",
          ].join("\n"),
        },
      ]);
    },
  });

  // ── Command: /debate2 ─────────────────────────────────

  pi.registerCommand("debate2", {
    description:
      "Start a blackboard-based open-ended multi-agent debate — runs until convergence",
    handler: async (args, ctx) => {
      if (!args || !args.trim()) {
        ctx.ui.notify("Usage: /debate2 <topic>", "warning");
        return;
      }

      const agentsReady = await ensureBrainstormAgents(ctx);
      if (!agentsReady) return;

      const topic = args.trim();
      const slug = topicToSlug(topic);
      const dateStr = todayStr();
      const meetingName = `${dateStr}-${slug}`;
      const absDir = validateMeetingDir(
        path.resolve(ctx.cwd, ".pi-meetings", meetingName),
        ctx.cwd
      );

      // Create meeting folder structure
      await fsp.mkdir(path.join(absDir, "entries"), { recursive: true });
      assertDirectoryNoSymlink(absDir, "meeting directory");
      assertDirectoryNoSymlink(path.join(absDir, "entries"), "entries directory");

      // Seed manifest
      const manifest: MeetingManifest = {
        topic,
        created: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
        entryCount: 0,
      };
      await writeManifest(absDir, manifest);

      // Seed index.jsonl (empty)
      const indexJsonlPath = path.join(absDir, "index.jsonl");
      assertWritableFilePath(indexJsonlPath, absDir, "meeting index");
      if (!fs.existsSync(indexJsonlPath)) {
        await fsp.writeFile(indexJsonlPath, "", "utf-8");
      }

      // Seed blackboard.md header
      const blackboardPath = path.join(absDir, "blackboard.md");
      assertWritableFilePath(blackboardPath, absDir, "meeting blackboard");
      const blackboardHeader = [
        `# Debate: ${topic}`,
        `> Created: ${new Date().toISOString()}`,
        `> Type: Open-ended debate (until convergence)`,
        "",
        "---",
        "",
      ].join("\n");
      await fsp.writeFile(blackboardPath, blackboardHeader, "utf-8");

      // Start watcher
      startWatching(pi, absDir);

      ctx.ui.notify(
        `⚔️ Blackboard debate: ${meetingName}\n` +
          `  Folder: .pi-meetings/${meetingName}/\n` +
          `  Watcher active — entries will appear as cards\n` +
          `  Open-ended — runs until convergence or you intervene`,
        "info"
      );

      // Send orchestration prompt to main agent
      pi.sendUserMessage([
        {
          type: "text" as const,
          text: [
            `⚔️ BLACKBOARD DEBATE: ${topic}`,
            "",
            `Meeting folder: \`${absDir}\``,
            "",
            "You are facilitating an OPEN-ENDED debate using the MEETING BLACKBOARD.",
            "Each debater writes their FULL argument to disk via meeting_append_entry.",
            "Continue until the debate CONVERGES or the user intervenes.",
            "",
            "## Debaters (cycling indefinitely)",
            "- **GPT** (gpt-brainstormer): THE PROSECUTOR — Attack other positions ruthlessly. Find every logical flaw, hidden assumption, and missing edge case.",
            "- **DeepSeek** (deepseek-brainstormer): THE SYSTEMS SKEPTIC — Dissect structural implications. What breaks at scale? Where are the hidden costs?",
            "- **MiniMax** (minimax-brainstormer): THE CONTRARIAN — Take the opposite position. Expose groupthink. Propose radical alternatives.",
            "",
            "## CRITICAL INSTRUCTIONS",
            "",
            "### For subagents (include in EVERY task):",
            "1. Write your FULL contribution using the meeting_append_entry tool with:",
            `   - meetingDir: "${absDir}"`,
            "   - speaker: your name (GPT, DeepSeek, or MiniMax)",
            '   - phase: "Cycle 1", "Cycle 2", etc.',
            "   - summary: a ONE-SENTENCE summary of your argument",
            "   - content: your FULL argument in Chinese (中文)",
            "2. After writing, your FINAL ANSWER must be ONLY:",
            "   `WROTE_ENTRY: <your one-sentence summary>`",
            "3. DO NOT paste your full argument into the chat.",
            "",
            "### Include the FULL VERBATIM prior debate record in each subagent task.",
            "Use meeting_read_index and meeting_read_entry to retrieve the complete debate history.",
            "NEVER summarize or truncate the debate record when passing to subagents.",
            "",
            "### For you, the facilitator:",
            "- Do NOT paste participant full text into chat. They are on the blackboard.",
            "- Run debaters in CHAIN mode (one at a time, each sees all prior entries).",
            "- Read the index with meeting_read_index frequently.",
            "- Read full entries with meeting_read_entry when synthesizing.",
            "- After EACH full cycle (all 3 spoke), check for CONVERGENCE:",
            "  * Do 2+ agents agree on a specific conclusion?",
            "  * Did the last cycle introduce any NEW arguments?",
            "  * Did anyone explicitly concede?",
            "- If NOT converged: run another cycle. Keep going.",
            "- If converged: present synthesis to me.",
            "",
            "## Rules",
            "- NEVER stop at a predetermined count. Only convergence or user intervention ends this debate.",
            "- All responses in Chinese (中文).",
            "- After convergence, save transcript.md immediately and (after user confirms) conclusion.md per the MEETING OUTPUT PROTOCOL.",
            "- Present: (1) the debate arc, (2) who conceded what, (3) final synthesis.",
          ].join("\n"),
        },
      ]);
    },
  });

  // ── Cleanup on session shutdown ───────────────────────

  pi.on("session_shutdown", () => {
    for (const dir of activeWatchers.keys()) {
      stopWatching(dir);
    }
  });
}
