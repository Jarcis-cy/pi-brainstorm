/**
 * pi-brainstorm — Multi-model brainstorm/debate extension for Pi
 *
 * Runs brainstorm and debate sessions across multiple subagents configured
 * via YAML. Full participant contributions are stored in a local filesystem
 * blackboard, while the main conversation sees compact cards and facilitator
 * synthesis.
 *
 * Features:
 * - Configuration-driven participants (YAML)
 * - meeting_append_entry tool — concurrency-safe append to meeting folder
 * - meeting_read_index tool — read meeting index
 * - meeting_read_entry tool — read full entry content
 * - /brainstorm command — multi-model brainstorming
 * - /debate command — open-ended multi-agent debate
 * - meeting-entry message renderer — compact cards with expandable content
 * - File watcher — auto-posts new entries into the main conversation
 * - Managed agent file generation from config
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text, Box } from "@earendil-works/pi-tui";
import * as YAML from "yaml";

// ────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────

interface DebatePersona {
  label: string;
  prompt: string;
}

interface ParticipantConfig {
  displayName: string;
  agentName: string;
  description?: string;
  model: string;
  roleTitle?: string;
  rolePrompt: string;
  whatYouDo?: string[];
  debatePersona?: DebatePersona;
  brainstormRole?: string;
  tools?: string[];
}

interface BrainstormConfig {
  participants: ParticipantConfig[];
}

// ────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────

const MANAGED_MARKER = "<!-- managed-by: pi-brainstorm -->";
const DEFAULT_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "meeting_append_entry",
  "meeting_read_index",
  "meeting_read_entry",
];

// ────────────────────────────────────────────────────────
// Config helpers
// ────────────────────────────────────────────────────────

/**
 * Deep-merge two values. Arrays are replaced entirely; objects are
 * shallow-merged recursively; scalars use the overlay value.
 */
function deepMerge(base: any, overlay: any): any {
  if (overlay === null || overlay === undefined) return base;
  if (base === null || base === undefined) return overlay;

  if (Array.isArray(base) && Array.isArray(overlay)) {
    return overlay;
  }

  if (
    typeof base === "object" &&
    typeof overlay === "object" &&
    !Array.isArray(base) &&
    !Array.isArray(overlay)
  ) {
    const result: Record<string, any> = { ...base };
    for (const key of Object.keys(overlay)) {
      result[key] =
        key in result
          ? deepMerge(result[key], overlay[key])
          : overlay[key];
    }
    return result;
  }

  return overlay;
}

/**
 * Resolve extension directory from import.meta.url.
 */
function getExtensionDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Load and merge config from all locations, in priority order (later wins):
 *   1. Package default: config/default.yaml (relative to package root or extension dir)
 *      Also try brainstorm.yaml in extension dir (for manual installs)
 *   2. User override: ~/.pi/agent/pi-brainstorm.yaml
 *   3. Project override: {cwd}/.pi-brainstorm.yaml
 *   4. Project override: {cwd}/.pi/pi-brainstorm.yaml
 */
function hasProjectConfig(cwd: string): boolean {
  if (!cwd) return false;
  return [
    path.join(cwd, ".pi-brainstorm.yaml"),
    path.join(cwd, ".pi", "pi-brainstorm.yaml"),
  ].some((candidate) => fs.existsSync(candidate));
}

function loadConfig(cwd: string): BrainstormConfig {
  const extensionDir = getExtensionDir();
  const packageRoot = path.dirname(extensionDir);

  // Step 1: package/extension defaults
  const defaultCandidates = [
    path.join(packageRoot, "config", "default.yaml"),
    path.join(extensionDir, "config", "default.yaml"),
    path.join(extensionDir, "brainstorm.yaml"),
  ];

  let merged: any = {};
  let loadedAny = false;

  for (const candidate of defaultCandidates) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, "utf-8");
        const parsed = YAML.parse(raw);
        if (parsed && typeof parsed === "object") {
          merged = deepMerge(merged, parsed);
          loadedAny = true;
        }
      } catch (err: any) {
        throw new Error(
          `Failed to parse config ${candidate}: ${err.message}`
        );
      }
    }
  }

  if (!loadedAny) {
    throw new Error(
      "No pi-brainstorm config found. Expected config/default.yaml in package root or extension directory."
    );
  }

  // Step 2: user override
  const userPath = path.join(getAgentDir(), "pi-brainstorm.yaml");
  if (fs.existsSync(userPath)) {
    try {
      const raw = fs.readFileSync(userPath, "utf-8");
      const parsed = YAML.parse(raw);
      if (parsed && typeof parsed === "object") {
        merged = deepMerge(merged, parsed);
      }
    } catch (err: any) {
      throw new Error(
        `Failed to parse user config ${userPath}: ${err.message}`
      );
    }
  }

  // Step 3: project overrides
  const projectCandidates = cwd
    ? [path.join(cwd, ".pi-brainstorm.yaml"), path.join(cwd, ".pi", "pi-brainstorm.yaml")]
    : [];

  for (const candidate of projectCandidates) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, "utf-8");
        const parsed = YAML.parse(raw);
        if (parsed && typeof parsed === "object") {
          merged = deepMerge(merged, parsed);
        }
      } catch (err: any) {
        throw new Error(
          `Failed to parse project config ${candidate}: ${err.message}`
        );
      }
    }
  }

  return merged as BrainstormConfig;
}

/**
 * Resolve and validate participants for a command invocation.
 * Returns validated participant array; throws with a clear message on failure.
 */
function isSafeAgentName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(value);
}

function resolveParticipants(cwd: string): ParticipantConfig[] {
  const config = loadConfig(cwd);

  if (
    !config.participants ||
    !Array.isArray(config.participants) ||
    config.participants.length === 0
  ) {
    throw new Error(
      "pi-brainstorm config must define at least one participant under 'participants'."
    );
  }

  const requiredFields: (keyof ParticipantConfig)[] = [
    "displayName",
    "agentName",
    "model",
    "rolePrompt",
  ];

  for (let i = 0; i < config.participants.length; i++) {
    const p = config.participants[i];
    for (const field of requiredFields) {
      if (!p[field]) {
        throw new Error(
          `Participant at index ${i} is missing required field "${field}".`
        );
      }
    }
    if (typeof p.displayName !== "string" || !p.displayName.trim()) {
      throw new Error(
        `Participant at index ${i} has invalid displayName.`
      );
    }
    if (typeof p.agentName !== "string" || !p.agentName.trim()) {
      throw new Error(
        `Participant at index ${i} has invalid agentName.`
      );
    }
    if (!isSafeAgentName(p.agentName)) {
      throw new Error(
        `Participant "${p.displayName}" has unsafe agentName "${p.agentName}". Use only letters, digits, dot, underscore, and hyphen; it must start with a letter or digit.`
      );
    }
    if (typeof p.model !== "string" || !p.model.trim()) {
      throw new Error(
        `Participant at index ${i} has invalid model.`
      );
    }
    if (typeof p.rolePrompt !== "string" || !p.rolePrompt.trim()) {
      throw new Error(
        `Participant at index ${i} has invalid rolePrompt.`
      );
    }
  }

  return config.participants;
}

// ────────────────────────────────────────────────────────
// Agent file generation
// ────────────────────────────────────────────────────────

/**
 * Generate the content of a managed agent markdown file from a participant config.
 */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function generateAgentFile(participant: ParticipantConfig): string {
  const tools = participant.tools && participant.tools.length > 0
    ? participant.tools
    : DEFAULT_TOOLS;
  const toolsStr = tools.join(", ");

  const description =
    participant.description ||
    `${participant.displayName} brainstorming consultant.`;

  const roleTitle = participant.roleTitle
    ? ` - ${participant.roleTitle}`
    : "";

  const whatYouDoLines = (participant.whatYouDo && participant.whatYouDo.length > 0)
    ? participant.whatYouDo.map((item) => `- ${item}`).join("\n")
    : `- 参与多模型讨论并提供${participant.displayName}视角的分析`;

  return [
    MANAGED_MARKER,
    "---",
    `name: ${yamlScalar(participant.agentName)}`,
    `description: ${yamlScalar(description)}`,
    `tools: ${toolsStr}`,
    `model: ${yamlScalar(participant.model)}`,
    "---",
    "",
    `# ${participant.displayName} Brainstormer${roleTitle}`,
    "",
    participant.rolePrompt,
    "",
    "## What You Do",
    whatYouDoLines,
    "",
    "## What You Do Not Do",
    "- 写代码或修改项目文件，你只读项目文件",
    "- 委派给其他 Agent",
    "- 在聊天中直接粘贴长篇分析；当明确指示使用 meeting_append_entry 时，必须将完整贡献写入会议黑板，最终回复仅写 WROTE_ENTRY + 一句话摘要",
    "",
    "## Worker Preamble",
    "You are a terminal worker. Work directly with tools. Do NOT spawn sub-agents.",
    "",
  ].join("\n");
}

/**
 * Ensure agent files exist for all configured participants.
 * - Files with the managed marker are overwritten from current config.
 * - Files without the marker are never touched.
 * - Missing files are created after user confirmation.
 *
 * Returns true if all participants have existing agent files (managed or not).
 */
async function safeWriteAgentFile(targetPath: string, content: string, mode: "create" | "update"): Promise<void> {
  const dir = path.dirname(targetPath);
  assertDirectoryNoSymlink(dir, "agents directory");
  assertPathInside(fs.realpathSync(dir), path.resolve(targetPath), "agent file");

  if (mode === "create") {
    await fsp.writeFile(targetPath, content, { encoding: "utf-8", flag: "wx" });
    return;
  }

  assertExistingFileNoSymlink(targetPath, "agent file");
  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`
  );
  await fsp.writeFile(tempPath, content, { encoding: "utf-8", flag: "wx" });
  try {
    await fsp.rename(tempPath, targetPath);
  } catch (err) {
    try {
      await fsp.unlink(tempPath);
    } catch {
      // Ignore cleanup errors.
    }
    throw err;
  }
}

async function ensureAgentsFromConfig(
  ctx: any,
  participants: ParticipantConfig[],
  options: { allowGlobalWrites: boolean }
): Promise<boolean> {
  const agentsDir = path.join(getAgentDir(), "agents");

  const planned: { filename: string; action: "create" | "update" }[] = [];
  const protectedFiles: string[] = [];

  for (const p of participants) {
    const filename = `${p.agentName}.md`;
    const targetPath = path.resolve(agentsDir, filename);
    assertPathInside(agentsDir, targetPath, "agent file");

    if (fs.existsSync(targetPath)) {
      assertExistingFileNoSymlink(targetPath, "agent file");
      const content = fs.readFileSync(targetPath, "utf-8");
      if (content.includes(MANAGED_MARKER)) {
        planned.push({ filename, action: "update" });
      } else {
        protectedFiles.push(filename);
      }
    } else {
      planned.push({ filename, action: "create" });
    }
  }

  // If nothing to create or update, we're done
  if (planned.length === 0) {
    return true;
  }

  if (!options.allowGlobalWrites) {
    ctx.ui?.notify?.(
      "Project-level pi-brainstorm config is active. For safety, this command will not create or update global agent files. Create the listed agents manually or move the config to ~/.pi/agent/pi-brainstorm.yaml.",
      "warning"
    );
    return false;
  }

  // Non-interactive mode
  if (!ctx.hasUI) {
    // Update managed files silently
    await fsp.mkdir(agentsDir, { recursive: true });
    assertDirectoryNoSymlink(agentsDir, "agents directory");
    for (const plan of planned) {
      if (plan.action === "update") {
        const p = participants.find(
          (p) => `${p.agentName}.md` === plan.filename
        )!;
        const targetPath = path.resolve(agentsDir, plan.filename);
        assertPathInside(agentsDir, targetPath, "agent file");
        await safeWriteAgentFile(
          targetPath,
          generateAgentFile(p),
          "update"
        );
      }
    }
    // Report missing
    const missing = planned.filter((p) => p.action === "create");
    if (missing.length > 0) {
      ctx.ui?.notify?.(
        `Missing meeting agents: ${missing.map((m) => m.filename).join(", ")}. Install them under ${agentsDir}.`,
        "warning"
      );
      return false;
    }
    return true;
  }

  // Interactive mode: ask user
  let message = "";
  if (planned.length > 0) {
    const actionWord = planned.some((p) => p.action === "update")
      ? "created/updated"
      : "created";
    message += `The following agent files will be ${actionWord}:\n`;
    for (const p of planned) {
      message += `  - ${p.filename} (${p.action})\n`;
    }
  }
  if (protectedFiles.length > 0) {
    message += `\nThe following existing files are NOT managed by pi-brainstorm and will be left untouched:\n`;
    for (const f of protectedFiles) {
      message += `  - ${f}\n`;
    }
  }

  const title = planned.some((p) => p.action === "update")
    ? "Update brainstorm agents?"
    : "Install brainstorm agents?";

  const ok = await ctx.ui.confirm(
    title,
    message + `\nFiles will be written to ${agentsDir}.`
  );
  if (!ok) return false;

  await fsp.mkdir(agentsDir, { recursive: true });
  assertDirectoryNoSymlink(agentsDir, "agents directory");
  for (const plan of planned) {
    const p = participants.find(
      (p) => `${p.agentName}.md` === plan.filename
    )!;
    const targetPath = path.resolve(agentsDir, plan.filename);
    assertPathInside(agentsDir, targetPath, "agent file");
    await safeWriteAgentFile(targetPath, generateAgentFile(p), plan.action);
  }

  ctx.ui.notify(`Updated ${planned.length} agent file(s).`, "info");
  return true;
}

// ────────────────────────────────────────────────────────
// Prompt builders
// ────────────────────────────────────────────────────────

/**
 * Build the facilitator prompt for /brainstorm.
 */
function buildBrainstormPrompt(
  topic: string,
  absDir: string,
  participants: ParticipantConfig[]
): string {
  const consultantLines = participants
    .map(
      (p) =>
        `- **${p.displayName}**: use the ${p.agentName} subagent. ${p.brainstormRole || p.roleTitle || "Consultant"}.`
    )
    .join("\n");

  const agentTaskLines = participants
    .map(
      (p) =>
        `   - speaker: "${p.displayName}"`
    )
    .join("\n");

  return [
    `BLACKBOARD BRAINSTORMING SESSION: ${topic}`,
    "",
    `Meeting folder: \`${absDir}\``,
    "",
    "You are facilitating a round-robin brainstorming session using the MEETING BLACKBOARD.",
    "Each consultant writes their FULL contribution to disk via meeting_append_entry.",
    "",
    "## Consultants (3 rounds)",
    consultantLines,
    "",
    "## CRITICAL INSTRUCTIONS",
    "",
    "### For subagents (include in EVERY task):",
    "1. Write your FULL contribution using the meeting_append_entry tool with:",
    `   - meetingDir: "${absDir}"`,
    "   - speaker: your display name, e.g.:",
    agentTaskLines,
    '   - phase: "Round 1", "Round 2", or "Round 3"',
    "   - summary: a ONE-SENTENCE summary of your contribution",
    "   - content: your FULL analysis in Chinese (中文)",
    "   - content must contain only the participant's analysis. Do not include wrapper tags, hidden thinking markers, tool-call text, or WROTE_ENTRY text inside content.",
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
    "Round 1: Each consultant gives initial analysis on the topic. Run all in parallel.",
    "After Round 1: read the index, present summaries plus a structural overview, then STOP. Ask the user for feedback or permission to continue. Do NOT start Round 2 in the same assistant turn.",
    "Round 2: only after the user replies, feed Round 1 plus the user's VERBATIM feedback back to each consultant. Ask each to challenge the others and propose improvements.",
    "After Round 2: read the index, present summaries plus an updated structural overview, then STOP. Ask the user for feedback or permission to continue. Do NOT start Round 3 in the same assistant turn.",
    "Round 3: only after the user replies, feed all prior rounds plus the user's VERBATIM feedback back to each consultant. Each gives FINAL recommendation, synthesizing the best ideas.",
    "",
    "After Round 3, present the complete structural overview and ask whether to write the final conclusion. Only write conclusion.md after the user confirms.",
    "",
    "## FAILURE HANDLING",
    "Subagent calls can fail (timeout, API error, model unavailable, crash). You MUST detect and handle failures:",
    "",
    "### Detecting failure",
    "A subagent call has FAILED if:",
    "- The tool result contains error text (\"error\", \"failed\", \"timeout\", \"unavailable\", \"connection\", etc.)",
    "- The subagent returns no output or empty output",
    "- The subagent output does NOT contain \"WROTE_ENTRY:\" (the expected success marker)",
    "- The subagent produced no meeting_append_entry call (check with meeting_read_index after the parallel batch)",
    "",
    "### Retry strategy",
    "When you detect a failure:",
    "1. Wait 5-10 seconds before retrying (API rate limits may have triggered the failure)",
    "2. Retry the SAME consultant with the SAME task up to 2 more times (3 attempts total)",
    "3. On retry, add to the task: \"PREVIOUS ATTEMPT FAILED. This is retry N of 2. Focus only on completing your contribution and writing WROTE_ENTRY.\"",
    "4. If the consultant succeeds on retry, proceed normally",
    "5. If ALL retries are exhausted, treat this consultant as UNAVAILABLE for this round",
    "",
    "### When a consultant is UNAVAILABLE",
    "- Do NOT wait indefinitely or freeze the session",
    "- Proceed with the remaining consultants who succeeded",
    "- In your structural overview, clearly mark the failed participant as: \"[displayName] ([agentName]): 本轮未响应 / did not respond\"",
    "- Continue to the next round normally — do NOT skip the consultant in future rounds (they may recover)",
    "- If the same consultant fails in 2 consecutive rounds, warn the user with the real display name, e.g.: \"DeepSeek 连续两轮失败，建议检查该模型是否可用\"",
    "",
    "### NEVER do this",
    "- Do NOT fabricate or simulate a consultant's response",
    "- Do NOT impose an extra manual timeout beyond the subagent tool's timeout; if the tool reports timeout, treat that attempt as failed",
    "- Do NOT abort the entire session because one consultant failed",
    "",
    "## IMPORTANT",
    "- All responses in Chinese (中文).",
    "- Save transcript.md and (after user confirms) conclusion.md per the MEETING OUTPUT PROTOCOL.",
    "- The user can intervene at any time to steer the discussion.",
  ].join("\n");
}

/**
 * Build the facilitator prompt for /debate.
 */
function buildDebatePrompt(
  topic: string,
  absDir: string,
  participants: ParticipantConfig[]
): string {
  const debaterLines = participants
    .map((p) => {
      const dp = p.debatePersona;
      if (dp) {
        return `- **${p.displayName}** (${p.agentName}): ${dp.label} — Attack other positions, find flaws, expose assumptions.`;
      }
      return `- **${p.displayName}** (${p.agentName})`;
    })
    .join("\n");

  // Build per-agent debate task prefixes for the facilitator to include
  const taskPrefixLines = participants
    .map((p) => {
      const dp = p.debatePersona;
      if (dp && dp.prompt) {
        return `**${p.displayName}** (${p.agentName}):\n${dp.prompt}`;
      }
      return `**${p.displayName}** (${p.agentName}): Debate participant.`;
    })
    .join("\n\n");

  const agentTaskLines = participants
    .map(
      (p) =>
        `   - speaker: "${p.displayName}"`
    )
    .join("\n");

  return [
    `⚔️ BLACKBOARD DEBATE: ${topic}`,
    "",
    `Meeting folder: \`${absDir}\``,
    "",
    "You are facilitating an OPEN-ENDED debate using the MEETING BLACKBOARD.",
    "Each debater writes their FULL argument to disk via meeting_append_entry.",
    "Continue until the debate CONVERGES or the user intervenes.",
    "",
    "## Debaters (cycling indefinitely)",
    debaterLines,
    "",
    "## DEBATE PERSONAS (include in each subagent task)",
    taskPrefixLines,
    "",
    "## CRITICAL INSTRUCTIONS",
    "",
    "### For subagents (include in EVERY task):",
    "1. Write your FULL contribution using the meeting_append_entry tool with:",
    `   - meetingDir: "${absDir}"`,
    "   - speaker: your display name, e.g.:",
    agentTaskLines,
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
    "- Cycle through debaters in sequence (chain mode) so each sees all prior entries.",
    "- Read the index with meeting_read_index frequently.",
    "- Read full entries with meeting_read_entry when synthesizing.",
    "- After EACH full cycle (all debaters spoke once), check for CONVERGENCE:",
    "  * Do 2+ agents agree on a specific conclusion?",
    "  * Did the last cycle introduce any NEW arguments?",
    "  * Did anyone explicitly concede?",
    "- If NOT converged: run another cycle. Keep going.",
    "- If converged: present synthesis to me.",
    "",
    "## FAILURE HANDLING",
    "Subagent calls can fail (timeout, API error, model unavailable, crash). You MUST detect and handle failures:",
    "",
    "### Detecting failure",
    "A subagent call has FAILED if:",
    "- The tool result contains error text (\"error\", \"failed\", \"timeout\", \"unavailable\", \"connection\", etc.)",
    "- The subagent returns no output or empty output",
    "- The subagent output does NOT contain \"WROTE_ENTRY:\" (the expected success marker)",
    "- The subagent produced no meeting_append_entry call (check with meeting_read_index after the chain step)",
    "",
    "### Retry strategy",
    "When you detect a failure in a chain step:",
    "1. Wait 5-10 seconds before retrying (API rate limits may have triggered the failure)",
    "2. Retry the SAME debater with the SAME task up to 2 more times (3 attempts total)",
    "3. On retry, add to the task: \"PREVIOUS ATTEMPT FAILED. This is retry N of 2. Focus only on completing your argument and writing WROTE_ENTRY.\"",
    "4. If the debater succeeds on retry, proceed to the next debater in the chain",
    "5. If ALL retries are exhausted, SKIP this debater for this cycle and move to the next debater",
    "",
    "### When a debater is UNAVAILABLE",
    "- Do NOT wait indefinitely or freeze the session",
    "- Skip to the next debater in the cycle",
    "- In your structural overview, clearly mark the failed participant as: \"[displayName] ([agentName]): 本轮未响应 / did not respond\"",
    "- Continue the debate with remaining debaters — do NOT abort the whole debate",
    "- If the same debater fails in 2 consecutive cycles, warn the user with the real display name, e.g.: \"DeepSeek 连续两轮失败，建议检查该模型是否可用\"",
    "",
    "### NEVER do this",
    "- Do NOT fabricate or simulate a debater's argument",
    "- Do NOT impose an extra manual timeout beyond the subagent tool's timeout; if the tool reports timeout, treat that attempt as failed",
    "- Do NOT abort the entire debate because one debater failed",
    "- Do NOT get stuck in an infinite retry loop — 3 attempts max per debater per cycle",
    "",
    "## Rules",
    "- NEVER stop at a predetermined count. Only convergence or user intervention ends this debate.",
    "- All responses in Chinese (中文).",
    "- After convergence, save transcript.md immediately and (after user confirms) conclusion.md per the MEETING OUTPUT PROTOCOL.",
    "- Present: (1) the debate arc, (2) who conceded what, (3) final synthesis.",
  ].join("\n");
}

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

/** Sanitize a string for use in filenames (keep letters, digits, hyphens, underscores). */
function sanitizeFilenamePart(raw: string): string {
  return (
    raw
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 60)
      .toLowerCase() || "unknown"
  );
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
          assertPathInside(
            fs.realpathSync(entriesDir),
            fs.realpathSync(entryPath),
            "meeting entry real path"
          );
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

  (watcher as any).on?.("error", () => {
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
        assertPathInside(
          fs.realpathSync(absDir),
          fs.realpathSync(absEntryPath),
          "meeting entry real path"
        );
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
            assertPathInside(
              fs.realpathSync(details.meetingDir),
              fs.realpathSync(details.path),
              "meeting entry real path"
            );
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

  // ── Command: /brainstorm ─────────────────────────────

  pi.registerCommand("brainstorm", {
    description:
      "Start a multi-model brainstorming session on a topic",
    handler: async (args, ctx) => {
      if (!args || !args.trim()) {
        ctx.ui.notify("Usage: /brainstorm <topic>", "warning");
        return;
      }

      // Resolve participants from config
      let participants: ParticipantConfig[];
      try {
        participants = resolveParticipants(ctx.cwd);
      } catch (err: any) {
        ctx.ui.notify(
          `pi-brainstorm config error: ${err.message}`,
          "error"
        );
        return;
      }

      const agentsReady = await ensureAgentsFromConfig(ctx, participants, {
        allowGlobalWrites: !hasProjectConfig(ctx.cwd),
      });
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
      assertDirectoryNoSymlink(
        path.join(absDir, "entries"),
        "entries directory"
      );

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
        `🧠 Multi-model brainstorm: ${meetingName}\n` +
          `  Folder: .pi-meetings/${meetingName}/\n` +
          `  Watcher active — entries will appear as cards`,
        "info"
      );

      // Send orchestration prompt to main agent
      const promptText = buildBrainstormPrompt(topic, absDir, participants);
      pi.sendUserMessage([
        {
          type: "text" as const,
          text: promptText,
        },
      ]);
    },
  });

  // ── Command: /debate ─────────────────────────────────

  pi.registerCommand("debate", {
    description:
      "Start a multi-agent debate battle — runs until convergence",
    handler: async (args, ctx) => {
      if (!args || !args.trim()) {
        ctx.ui.notify("Usage: /debate <topic>", "warning");
        return;
      }

      // Resolve participants from config
      let participants: ParticipantConfig[];
      try {
        participants = resolveParticipants(ctx.cwd);
      } catch (err: any) {
        ctx.ui.notify(
          `pi-brainstorm config error: ${err.message}`,
          "error"
        );
        return;
      }

      const agentsReady = await ensureAgentsFromConfig(ctx, participants, {
        allowGlobalWrites: !hasProjectConfig(ctx.cwd),
      });
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
      assertDirectoryNoSymlink(
        path.join(absDir, "entries"),
        "entries directory"
      );

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
        `⚔️ Multi-agent debate: ${meetingName}\n` +
          `  Folder: .pi-meetings/${meetingName}/\n` +
          `  Watcher active — entries will appear as cards\n` +
          `  Open-ended — runs until convergence or you intervene`,
        "info"
      );

      // Send orchestration prompt to main agent
      const promptText = buildDebatePrompt(topic, absDir, participants);
      pi.sendUserMessage([
        {
          type: "text" as const,
          text: promptText,
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
