# Claude Code Codex MCP (`claude-code-codex-mcp`)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![MCP Protocol](https://img.shields.io/badge/MCP-2024--11--05-green.svg)](https://modelcontextprotocol.io/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Supported-purple.svg)](https://docs.anthropic.com/en/docs/claude-code)

> **让 Claude Code 与 Codex 终极合体！**  
> 在 **Claude Code** 终端中直接调用 **Codex** 的历史会话（Sessions）、挂载后台任务，并自由使用 Codex 中配置的全部高性能大模型。

[English Documentation](#english-readme) | [中文说明文档](#中文说明文档)

---

<h2 id="中文说明文档">中文说明文档</h2>

### 💡 为什么需要这个项目？

在现代 AI 辅助研发中，很多开发者同时使用两款顶尖工具：
1. **Claude Code**：Anthropic 官方强大的终端代码自主 Agent。
2. **Codex (Desktop & CLI)**：支持多元模型底座（如 Gemini 3.8 Flash、DeepSeek Flash、GPT-6、Grok 等）并拥有独立的会话记忆体系与沙箱执行环境。

之前两者是相互割裂的。本 MCP 服务打破了这个壁垒，将 **Codex 的核心会话引擎与模型目录暴露为标准 MCP 工具**，让 Claude Code 可以：
- **模型任意借力**：随时调用 Codex 中的不同模型进行“双盲会诊”或专项复杂推理。
- **跨端会话缝合**：你在 Codex 桌面版（GUI）里推进了一半的工作，在 Claude Code 里可以直接接着干，无需反复复制 Prompt 与代码。
- **主从分工协作**：Claude Code 作为主脑负责整体架构与交互，把脏活累活丢给 Codex 作为后台 Worker 独立执行并保留历史痕迹。

---

### 架构流程图 (Architecture)

```text
┌────────────────────────────────────────────────────────┐
│                      User Terminal                     │
│                            │                           │
│                      Claude Code                       │
│             (Main Reasoning / Interaction)             │
└────────────────────────────┬───────────────────────────┘
                             │
                  Standard MCP (Stdio)
                             │
┌────────────────────────────▼───────────────────────────┐
│               claude-code-codex-mcp                    │
│   (Session Scanner | Model Catalog | Exec Engine)      │
└──────────────┬───────────────────────────┬─────────────┘
               │                           │
        Inspect / Read              Spawn & Stream
               │                           │
┌──────────────▼─────────────┐   ┌─────────▼─────────────┐
│  ~/.codex/session_index    │   │      codex exec       │
│  ~/.codex/sessions/*.jsonl │   │   -m <target_model>   │
│  ~/.codex/config.toml      │   │   resume / fork / run │
└────────────────────────────┘   └───────────────────────┘
```

---

### 🛠️ 提供的 8 大核心工具

| 工具名称 | 功能描述 | 核心参数 |
| :--- | :--- | :--- |
| `codex_list_models` | 查看 Codex 中配置的全部模型、上下文窗口、推理深度及当前激活模型 | 无 |
| `codex_list_sessions` | 列出本地所有的 Codex 会话（含标题、会话 ID、工作区路径、所用模型） | `limit`, `query` |
| `codex_read_session` | 深入读取指定会话的完整轮次记录，提取用户提问、工具调用及模型产出 | `session_id`, `max_turns`, `include_tool_calls` |
| `codex_resume_session` | **继续已有会话**（或 `--last`），完整保留上下文，支持动态换模型 | `session_id`, `prompt`, `model`, `working_dir` |
| `codex_fork_session` | 将已有会话分叉为全新的独立分支开展试探性工作 | `session_id`, `prompt`, `model` |
| `codex_run_task` | 发起持久化的自主 Coding 任务，落盘并可在 Codex 桌面端直接同步查看与接管 | `prompt`, `model`, `working_dir`, `sandbox` |
| `codex_ask_model` | 快速直连调用 Codex 模型（只读、无痕、不落盘、不污染会话列表） | `prompt`, `model`, `working_dir` |
| `codex_status` | 查看当前 Codex CLI 核心版本、配置文件、API 端点与运行健康状态 | 无 |

---

### 🚀 快速上手 (Quick Start)

#### 1. 安装与一键配置

克隆仓库后，运行对应的安装脚本即可自动安装依赖、执行自检并注册到 Claude Code：

**Windows (PowerShell)**:
```powershell
git clone https://github.com/your-username/claude-code-codex-mcp.git
cd claude-code-codex-mcp
.\install.ps1
```

**Linux / macOS (Bash)**:
```bash
git clone https://github.com/your-username/claude-code-codex-mcp.git
cd claude-code-codex-mcp
chmod +x install.sh
./install.sh
```

#### 2. 手动注册方式

如果你想手动注册到 Claude Code：
```bash
npm install
npm test
claude mcp add -s user codex node /path/to/claude-code-codex-mcp/src/index.mjs
```

检查注册状态：
```bash
claude mcp list
```
当看到 `codex: node ... - √ Connected` 即代表一切就绪！

---

### 💬 在 Claude Code 中的使用范例

在终端启动 `claude` 后，直接使用自然语言：

1. **多模型双盲评审**：
   > “请调用 `codex_ask_model`，使用 `gemini-3.8-flash-high` 模型审查当前目录下的认证逻辑是否存在漏洞。”

2. **跨端接力编程**：
   > “列出我刚才在 Codex 桌面端运行的会话，找到关于重构的那个会话 ID，并读取它的最新几轮对话。”
   > “调用 `codex_resume_session` 继续该会话，换成 `deepseek-flash` 模型，让它补充单元测试。”

3. **后台异步工兵**：
   > “调用 `codex_run_task` 启动一个任务，把项目中的旧版 SDK 替换为新规范，完成后把 Session ID 汇报给我。”

---

<h2 id="english-readme">English README</h2>

### 💡 Why this project?

Developers often switch between **Claude Code** (Anthropic's autonomous terminal coding agent) and **Codex** (an agent with flexible model support such as Gemini 3.8 Flash, DeepSeek Flash, GPT-6, Grok, etc.).

**`claude-code-codex-mcp`** acts as a unified Model Context Protocol (MCP) bridge, enabling Claude Code to:
- **Switch & Query Codex Models**: Access external reasoning models directly within Claude Code.
- **Unified Session Lifecycle**: Read, resume, and fork Codex Desktop & CLI sessions seamlessly.
- **Agent-to-Agent Delegation**: Delegate complex tasks from Claude Code to Codex as a persistent background worker.

### 🚀 Installation

```bash
git clone https://github.com/your-username/claude-code-codex-mcp.git
cd claude-code-codex-mcp
npm install
npm test
```

Register to Claude Code:
```bash
claude mcp add -s user codex node "$(pwd)/src/index.mjs"
```

Verify connection:
```bash
claude mcp list
# Output: codex: node ... - √ Connected
```

### 📄 License

MIT License. See [LICENSE](LICENSE) for details.
