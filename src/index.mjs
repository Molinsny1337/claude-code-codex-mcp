#!/usr/bin/env node
/**
 * Claude Code Codex MCP Server
 *
 * An official MCP (Model Context Protocol) bridge connecting Claude Code
 * with Codex CLI / Desktop sessions and models.
 *
 * Core Capabilities:
 * 1. Query and list Codex models (gemini, deepseek, gpt-6, grok, glm, claude, etc.)
 * 2. List, read, resume, and fork Codex sessions from Claude Code
 * 3. Run autonomous background coding tasks in Codex (persisting to Codex history)
 * 4. Ask Codex models directly for second opinions, reasoning, and code review
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

// Discover CODEX_HOME across Windows, macOS, and Linux
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CONFIG_FILE = path.join(CODEX_HOME, "config.toml");
const CATALOG_FILE = path.join(CODEX_HOME, "cc-switch-model-catalog.json");
const SESSION_INDEX_FILE = path.join(CODEX_HOME, "session_index.jsonl");
const SESSIONS_DIR = path.join(CODEX_HOME, "sessions");

// --------------------------------------------------------------------------
// Config & Model Helpers
// --------------------------------------------------------------------------

function readCodexConfig() {
  const result = {
    model: "default",
    model_provider: "custom",
    base_url: "",
    raw: "",
  };

  if (!fs.existsSync(CONFIG_FILE)) return result;

  try {
    const content = fs.readFileSync(CONFIG_FILE, "utf8");
    result.raw = content;

    const modelMatch = content.match(/^model\s*=\s*["']([^"']+)["']/m);
    if (modelMatch) result.model = modelMatch[1];

    const providerMatch = content.match(/^model_provider\s*=\s*["']([^"']+)["']/m);
    if (providerMatch) result.model_provider = providerMatch[1];

    const urlMatch = content.match(/base_url\s*=\s*["']([^"']+)["']/);
    if (urlMatch) result.base_url = urlMatch[1];
  } catch {}
  return result;
}

function getModelCatalog() {
  const config = readCodexConfig();
  const catalog = {
    default_model: config.model,
    default_provider: config.model_provider,
    base_url: config.base_url,
    models: [],
  };

  let foundCatalog = false;
  if (fs.existsSync(CATALOG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
      if (Array.isArray(data.models)) {
        catalog.models = data.models.map((m) => ({
          slug: m.slug || m.id,
          display_name: m.display_name || m.slug,
          description: m.description || "",
          context_window: m.context_window || 0,
          default_reasoning_level: m.default_reasoning_level || "high",
          supported_reasoning_levels: (m.supported_reasoning_levels || []).map((l) => l.effort || l),
          is_active: m.slug === config.model,
        }));
        foundCatalog = true;
      }
    } catch {}
  }

  if (!foundCatalog) {
    const defaults = [
      "gemini-3.8-flash-high",
      "deepseek-flash",
      "gpt-6.1-sol",
      "grok-4.7-build-fast",
      "kimi-k3-1",
      "grok-4.7",
      "glm-5.3",
      "claude-opus-5.5-thinking",
      "claude-sonnet-5.5-thinking",
      "gpt-6-astra",
      "gemini-4-argon-high",
      "glm-5.3-flash",
      "gemini-3-flash",
      "gpt-6.1-terra",
    ];
    catalog.models = defaults.map((slug) => ({
      slug,
      display_name: slug,
      description: slug,
      is_active: slug === config.model,
    }));
  }

  return catalog;
}

// --------------------------------------------------------------------------
// Session Inspection Helpers
// --------------------------------------------------------------------------

function listRecentSessions(limit = 15, query = "") {
  const indexMap = new Map();

  // 1. Read session_index.jsonl if available
  if (fs.existsSync(SESSION_INDEX_FILE)) {
    try {
      const lines = fs.readFileSync(SESSION_INDEX_FILE, "utf8").trim().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.id) {
            indexMap.set(entry.id, {
              id: entry.id,
              thread_name: entry.thread_name || "(Unnamed Session)",
              updated_at: entry.updated_at || "",
            });
          }
        } catch {}
      }
    } catch {}
  }

  // 2. Scan recent session rollout files in ~/.codex/sessions
  const sessionFiles = [];
  if (fs.existsSync(SESSIONS_DIR)) {
    function walk(dir, depth = 0) {
      if (depth > 3) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            walk(full, depth + 1);
          } else if (ent.isFile() && ent.name.startsWith("rollout-") && ent.name.endsWith(".jsonl")) {
            const stat = fs.statSync(full);
            sessionFiles.push({ path: full, mtime: stat.mtimeMs, filename: ent.name });
          }
        }
      } catch {}
    }
    walk(SESSIONS_DIR);
  }

  sessionFiles.sort((a, b) => b.mtime - a.mtime);

  const results = [];
  const seenIds = new Set();

  for (const sf of sessionFiles) {
    if (results.length >= limit * 2) break;
    try {
      const fd = fs.openSync(sf.path, "r");
      const buf = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);

      const text = buf.toString("utf8", 0, bytesRead);
      const lines = text.split("\n");
      let meta = null;
      let firstUserPrompt = "";

      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          const obj = JSON.parse(l);
          if (obj.type === "session_meta" && !meta) {
            meta = obj.payload;
          }
          if (obj.payload?.type === "message" && obj.payload?.role === "user" && !firstUserPrompt) {
            const part = obj.payload.content?.find((c) => c.type === "input_text" || c.type === "text");
            if (part?.text) {
              firstUserPrompt = part.text.slice(0, 120).replace(/\r?\n/g, " ").trim();
            }
          }
        } catch {}
      }

      const id = meta?.session_id || meta?.id || path.basename(sf.path, ".jsonl");
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const indexed = indexMap.get(id);
      const title = indexed?.thread_name || firstUserPrompt || "(No title)";
      const item = {
        id,
        title,
        cwd: meta?.cwd || "",
        model: meta?.base_instructions?.provenance?.model || meta?.model || "",
        updated_at: indexed?.updated_at || new Date(sf.mtime).toISOString(),
        file: sf.path,
      };

      if (query) {
        const q = query.toLowerCase();
        if (
          !item.title.toLowerCase().includes(q) &&
          !item.id.toLowerCase().includes(q) &&
          !item.cwd.toLowerCase().includes(q)
        ) {
          continue;
        }
      }

      results.push(item);
    } catch {}
  }

  return results.slice(0, limit);
}

function findSessionFile(sessionId) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  let matched = null;

  function walk(dir, depth = 0) {
    if (depth > 3 || matched) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (matched) return;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full, depth + 1);
        } else if (ent.isFile() && ent.name.includes(sessionId) && ent.name.endsWith(".jsonl")) {
          matched = full;
          return;
        }
      }
    } catch {}
  }

  walk(SESSIONS_DIR);
  return matched;
}

function readSessionDetails(sessionId, maxTurns = 10, includeToolCalls = true) {
  const filePath = findSessionFile(sessionId);
  if (!filePath) {
    return { error: `Session rollout file for ID "${sessionId}" not found in ~/.codex/sessions.` };
  }

  const rawLines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  let meta = null;
  const turns = [];
  let currentTurn = { user: "", assistant: "", toolCalls: [] };

  for (const line of rawLines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "session_meta" && !meta) {
        meta = obj.payload;
      } else if (obj.payload?.type === "message") {
        const role = obj.payload.role;
        const textParts = (obj.payload.content || [])
          .filter((c) => c.type === "text" || c.type === "input_text")
          .map((c) => c.text)
          .join("\n");

        if (role === "user") {
          if (currentTurn.user || currentTurn.assistant) {
            turns.push(currentTurn);
            currentTurn = { user: "", assistant: "", toolCalls: [] };
          }
          currentTurn.user = textParts;
        } else if (role === "assistant") {
          currentTurn.assistant = (currentTurn.assistant ? currentTurn.assistant + "\n" : "") + textParts;
        }
      } else if (obj.type === "response_item" && obj.payload?.type === "function_call" && includeToolCalls) {
        currentTurn.toolCalls.push({
          name: obj.payload.name,
          args: obj.payload.arguments,
        });
      }
    } catch {}
  }

  if (currentTurn.user || currentTurn.assistant) {
    turns.push(currentTurn);
  }

  const recentTurns = turns.slice(-maxTurns);
  return {
    id: sessionId,
    file: filePath,
    cwd: meta?.cwd || "",
    model: meta?.base_instructions?.provenance?.model || meta?.model || "",
    git: meta?.git || null,
    total_turns: turns.length,
    turns: recentTurns,
  };
}

// --------------------------------------------------------------------------
// Codex Command Execution Engine
// --------------------------------------------------------------------------

async function executeCodex({
  subcommand = "",
  targetId = "",
  prompt = "",
  model = "",
  cwd = "",
  sandbox = "danger-full-access",
  dangerouslyBypassApprovals = true,
  ephemeral = false,
  timeoutSeconds = 300,
}) {
  const tmpOutFile = path.join(
    os.tmpdir(),
    `codex_mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
  );

  const args = ["exec"];
  if (subcommand) {
    args.push(subcommand);
    if (targetId) {
      args.push(targetId);
    }
  }

  if (model) {
    args.push("-m", model);
  }
  if (cwd) {
    args.push("-C", cwd);
  }
  if (sandbox) {
    args.push("-s", sandbox);
  }
  if (dangerouslyBypassApprovals) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  if (ephemeral) {
    args.push("--ephemeral");
  }

  args.push("--skip-git-repo-check");
  args.push("--json");
  args.push("-o", tmpOutFile);
  args.push("-");

  return new Promise((resolve) => {
    let threadId = null;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let capturedAgentMessages = [];
    let toolCalls = [];
    let usage = null;
    let timedOut = false;

    const child = spawn("codex", args, {
      cwd: cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 3000);
    }, timeoutSeconds * 1000);

    child.stdin.write(prompt + "\n");
    child.stdin.end();

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "thread.started" && ev.thread_id) {
            threadId = ev.thread_id;
          }
          if (ev.type === "item.completed") {
            if (ev.item?.type === "agent_message" && ev.item.text) {
              capturedAgentMessages.push(ev.item.text);
            } else if (ev.item?.type === "function_call") {
              toolCalls.push({
                name: ev.item.name,
                call_id: ev.item.call_id,
              });
            }
          }
          if (ev.type === "turn.completed" && ev.usage) {
            usage = ev.usage;
          }
        } catch {}
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      let finalOutput = "";
      if (fs.existsSync(tmpOutFile)) {
        try {
          finalOutput = fs.readFileSync(tmpOutFile, "utf8");
          fs.unlinkSync(tmpOutFile);
        } catch {}
      }

      if (!finalOutput && capturedAgentMessages.length > 0) {
        finalOutput = capturedAgentMessages.join("\n\n");
      }

      resolve({
        code,
        timedOut,
        threadId,
        output: finalOutput.trim(),
        toolCalls,
        usage,
        stderr: stderrBuffer.trim(),
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        timedOut: false,
        threadId: null,
        output: "",
        toolCalls: [],
        usage: null,
        error: err.message,
        stderr: stderrBuffer.trim(),
      });
    });
  });
}

// --------------------------------------------------------------------------
// MCP Server Definition
// --------------------------------------------------------------------------

const server = new Server(
  {
    name: "claude-code-codex-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "codex_list_models",
        description:
          "List all AI models available in Codex configuration and catalog (e.g. gemini, deepseek, gpt-6, grok, glm, claude), showing the active model, context window, and supported reasoning levels.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "codex_list_sessions",
        description:
          "List recent Codex conversation sessions / threads (IDs, titles, workspace directories, models, and timestamps).",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of sessions to return (default: 15).",
            },
            query: {
              type: "string",
              description: "Optional keyword to filter sessions by title, ID, or workspace folder.",
            },
          },
        },
      },
      {
        name: "codex_read_session",
        description:
          "Read messages, turn history, and tool actions from a specific Codex session.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The Codex session ID (UUID) to inspect.",
            },
            max_turns: {
              type: "number",
              description: "Number of recent conversation turns to retrieve (default: 10).",
            },
            include_tool_calls: {
              type: "boolean",
              description: "Whether to include tool calls in the output (default: true).",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "codex_resume_session",
        description:
          "Resume and continue an existing Codex session with a new prompt. Keeps previous conversation history, workspace context, and tool capabilities. You can optionally switch models for this turn.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Session ID (UUID) to resume. If omitted, the most recent session is resumed (--last).",
            },
            prompt: {
              type: "string",
              description: "New instruction or message to send to the Codex session.",
            },
            model: {
              type: "string",
              description: "Optional model override (e.g. gemini-3.8-flash-high, deepseek-flash, gpt-6.1-sol, gpt-6-astra, etc.).",
            },
            working_dir: {
              type: "string",
              description: "Workspace directory root for execution.",
            },
            sandbox: {
              type: "string",
              enum: ["danger-full-access", "workspace-write", "read-only"],
              description: "Sandbox policy (default: danger-full-access).",
            },
            dangerously_bypass_approvals: {
              type: "boolean",
              description: "Skip all confirmation prompts (default: true).",
            },
            timeout_seconds: {
              type: "number",
              description: "Maximum runtime in seconds (default: 300 = 5 minutes).",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "codex_fork_session",
        description:
          "Fork an existing Codex session by ID into a brand new independent session and execute a prompt.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Session ID (UUID) to branch off.",
            },
            prompt: {
              type: "string",
              description: "Instructions for the newly forked session.",
            },
            model: {
              type: "string",
              description: "Optional model override.",
            },
            working_dir: {
              type: "string",
              description: "Workspace directory root for execution.",
            },
          },
          required: ["session_id", "prompt"],
        },
      },
      {
        name: "codex_run_task",
        description:
          "Start a new autonomous Codex coding task with a chosen model and directory. Persists the session in Codex so it can also be viewed, managed, or continued in the Codex Desktop App or CLI.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Detailed instructions for the Codex coding agent.",
            },
            model: {
              type: "string",
              description: "Codex model to use (e.g. gemini-3.8-flash-high, deepseek-flash, gpt-6.1-sol, gpt-6-astra, etc.).",
            },
            working_dir: {
              type: "string",
              description: "Workspace directory root for execution.",
            },
            sandbox: {
              type: "string",
              enum: ["danger-full-access", "workspace-write", "read-only"],
              description: "Sandbox mode (default: danger-full-access).",
            },
            dangerously_bypass_approvals: {
              type: "boolean",
              description: "Skip confirmation prompts (default: true).",
            },
            timeout_seconds: {
              type: "number",
              description: "Timeout in seconds (default: 300).",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "codex_ask_model",
        description:
          "Directly prompt any Codex model for code review, deep reasoning, translation, or problem solving in ephemeral, read-only mode without file mutations or saved sessions.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Prompt or question for the model.",
            },
            model: {
              type: "string",
              description: "Codex model to query (e.g. gemini-3.8-flash-high, deepseek-flash, gpt-6.1-sol, gpt-6-astra, grok-4.7, etc.).",
            },
            working_dir: {
              type: "string",
              description: "Context directory root (default: current directory).",
            },
            timeout_seconds: {
              type: "number",
              description: "Timeout in seconds (default: 180).",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "codex_status",
        description:
          "Get current Codex environment status, CLI version, configuration paths, active model, and model provider details.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    if (name === "codex_list_models") {
      const catalog = getModelCatalog();
      let md = `## Codex Available Models\n\n`;
      md += `**Default Model**: \`${catalog.default_model}\`\n`;
      md += `**Provider**: \`${catalog.default_provider}\`\n`;
      if (catalog.base_url) md += `**API Base**: \`${catalog.base_url}\`\n`;
      md += `\n| Model Slug | Display Name | Context Window | Reasoning Levels | Active |\n`;
      md += `| :--- | :--- | :--- | :--- | :---: |\n`;

      for (const m of catalog.models) {
        const active = m.is_active ? " **Yes**" : "";
        const ctx = m.context_window ? `${Math.round(m.context_window / 1024)}k` : "-";
        const levels = (m.supported_reasoning_levels || []).join(", ") || "-";
        md += `| \`${m.slug}\` | ${m.display_name} | ${ctx} | ${levels} | ${active} |\n`;
      }

      md += `\n> Tip: Use any of these model slugs in \`codex_ask_model\`, \`codex_run_task\`, or \`codex_resume_session\` via the \`model\` parameter.`;

      return { content: [{ type: "text", text: md }] };
    }

    if (name === "codex_list_sessions") {
      const limit = Number(args.limit) || 15;
      const query = String(args.query || "");
      const sessions = listRecentSessions(limit, query);

      if (sessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No Codex sessions found${query ? ` matching "${query}"` : ""}.`,
            },
          ],
        };
      }

      let md = `## Codex Sessions (${sessions.length} found)\n\n`;
      for (const s of sessions) {
        md += `### ${s.title}\n`;
        md += `- **Session ID**: \`${s.id}\`\n`;
        if (s.cwd) md += `- **Workspace**: \`${s.cwd}\`\n`;
        if (s.model) md += `- **Model**: \`${s.model}\`\n`;
        if (s.updated_at) md += `- **Updated**: ${s.updated_at}\n`;
        md += `\n`;
      }
      md += `> Tip: Pass \`session_id\` to \`codex_resume_session\` or \`codex_read_session\` to inspect or continue any session.`;

      return { content: [{ type: "text", text: md }] };
    }

    if (name === "codex_read_session") {
      const sessionId = String(args.session_id || "");
      const maxTurns = Number(args.max_turns) || 10;
      const includeToolCalls = args.include_tool_calls !== false;

      const details = readSessionDetails(sessionId, maxTurns, includeToolCalls);
      if (details.error) {
        return { content: [{ type: "text", text: `Error: ${details.error}` }] };
      }

      let md = `## Codex Session: \`${details.id}\`\n\n`;
      if (details.cwd) md += `**Workspace**: \`${details.cwd}\`\n`;
      if (details.model) md += `**Model**: \`${details.model}\`\n`;
      md += `**Total Turns**: ${details.total_turns} (showing latest ${details.turns.length})\n\n`;

      details.turns.forEach((turn, idx) => {
        md += `### Turn ${idx + 1}\n\n`;
        if (turn.user) {
          md += `**User**:\n${turn.user}\n\n`;
        }
        if (turn.toolCalls && turn.toolCalls.length > 0) {
          md += `**Tools Executed**:\n`;
          for (const tc of turn.toolCalls) {
            md += `- \`${tc.name}\`\n`;
          }
          md += `\n`;
        }
        if (turn.assistant) {
          md += `**Codex**:\n${turn.assistant}\n\n`;
        }
        md += `---\n\n`;
      });

      return { content: [{ type: "text", text: md }] };
    }

    if (name === "codex_resume_session") {
      const sessionId = args.session_id ? String(args.session_id) : "";
      const prompt = String(args.prompt || "");
      const model = args.model ? String(args.model) : "";
      const cwd = args.working_dir ? String(args.working_dir) : "";
      const sandbox = args.sandbox || "danger-full-access";
      const dangerouslyBypassApprovals = args.dangerously_bypass_approvals !== false;
      const timeoutSeconds = Number(args.timeout_seconds) || 300;

      const targetId = sessionId || "--last";

      const res = await executeCodex({
        subcommand: "resume",
        targetId,
        prompt,
        model,
        cwd,
        sandbox,
        dangerouslyBypassApprovals,
        timeoutSeconds,
      });

      if (res.timedOut) {
        return {
          content: [
            {
              type: "text",
              text: `Codex session resume timed out after ${timeoutSeconds} seconds.`,
            },
          ],
        };
      }

      let md = `### Codex Session Resumed (${res.threadId || targetId})\n\n`;
      if (model) md += `**Model Used**: \`${model}\`\n`;
      if (res.toolCalls?.length) {
        md += `**Actions Taken**:\n`;
        for (const tc of res.toolCalls) {
          md += `- \`${tc.name}\`\n`;
        }
        md += `\n`;
      }
      if (res.usage) {
        md += `**Tokens**: In: ${res.usage.input_tokens || 0}, Out: ${res.usage.output_tokens || 0}\n\n`;
      }
      md += `**Response**:\n\n${res.output || "(No output returned)"}`;

      return { content: [{ type: "text", text: md }] };
    }

    if (name === "codex_fork_session") {
      const sessionId = String(args.session_id || "");
      const prompt = String(args.prompt || "");
      const model = args.model ? String(args.model) : "";
      const cwd = args.working_dir ? String(args.working_dir) : "";

      const res = await executeCodex({
        subcommand: "fork",
        targetId: sessionId,
        prompt,
        model,
        cwd,
      });

      let md = `### Codex Session Forked\n\n`;
      md += `**Original Session**: \`${sessionId}\`\n`;
      if (res.threadId) md += `**New Forked Session ID**: \`${res.threadId}\`\n\n`;
      md += `**Response**:\n\n${res.output || "(No output returned)"}`;

      return { content: [{ type: "text", text: md }] };
    }

    if (name === "codex_run_task") {
      const prompt = String(args.prompt || "");
      const model = args.model ? String(args.model) : "";
      const cwd = args.working_dir ? String(args.working_dir) : "";
      const sandbox = args.sandbox || "danger-full-access";
      const dangerouslyBypassApprovals = args.dangerously_bypass_approvals !== false;
      const timeoutSeconds = Number(args.timeout_seconds) || 300;

      const res = await executeCodex({
        prompt,
        model,
        cwd,
        sandbox,
        dangerouslyBypassApprovals,
        ephemeral: false,
        timeoutSeconds,
      });

      let md = `### Codex Task Completed\n\n`;
      if (res.threadId) md += `**Session ID**: \`${res.threadId}\` (Saved in Codex)\n`;
      if (model) md += `**Model**: \`${model}\`\n`;
      if (res.toolCalls?.length) {
        md += `**Tools Invoked**:\n`;
        for (const tc of res.toolCalls) {
          md += `- \`${tc.name}\`\n`;
        }
        md += `\n`;
      }
      if (res.usage) {
        md += `**Token Usage**: Input: ${res.usage.input_tokens || 0}, Output: ${res.usage.output_tokens || 0}\n\n`;
      }
      md += `**Result**:\n\n${res.output || "(No output returned)"}`;

      return { content: [{ type: "text", text: md }] };
    }

    if (name === "codex_ask_model") {
      const prompt = String(args.prompt || "");
      const model = args.model ? String(args.model) : "";
      const cwd = args.working_dir ? String(args.working_dir) : "";
      const timeoutSeconds = Number(args.timeout_seconds) || 180;

      const res = await executeCodex({
        prompt,
        model,
        cwd,
        sandbox: "read-only",
        dangerouslyBypassApprovals: true,
        ephemeral: true,
        timeoutSeconds,
      });

      let md = res.output || (res.stderr ? `Error: ${res.stderr}` : "(Empty response)");
      return { content: [{ type: "text", text: md }] };
    }

    if (name === "codex_status") {
      const config = readCodexConfig();
      const sessions = listRecentSessions(5);

      let version = "unknown";
      try {
        const vChild = spawn("codex", ["--version"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        let vOut = "";
        vChild.stdout.on("data", (d) => (vOut += d.toString()));
        await new Promise((r) => vChild.on("close", r));
        version = vOut.trim();
      } catch {}

      let md = `## Codex Environment Status\n\n`;
      md += `- **CLI Version**: ${version}\n`;
      md += `- **CODEX_HOME**: \`${CODEX_HOME}\`\n`;
      md += `- **Config File**: \`${CONFIG_FILE}\` (Exists: ${fs.existsSync(CONFIG_FILE) ? "Yes" : "No"})\n`;
      md += `- **Active Default Model**: \`${config.model}\`\n`;
      md += `- **Model Provider**: \`${config.model_provider}\`\n`;
      if (config.base_url) md += `- **Base URL**: \`${config.base_url}\`\n`;
      md += `- **Recent Sessions Count**: ${sessions.length}\n`;

      return { content: [{ type: "text", text: md }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      content: [{ type: "text", text: `Codex MCP Error: ${err.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal error starting codex-mcp: ${err.message}\n`);
  process.exit(1);
});
