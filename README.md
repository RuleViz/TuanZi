# TuanZi Backend + App

[简体中文](./README.zh-CN.md) | English

This repository is now focused on two parts:

- `src/`: TuanZi backend runtime (agent orchestration, tools, MCP, config)
- `app/`: TuanZi desktop app (Electron + renderer)

The legacy CLI surface has been removed.

---

## 📑 Table of Contents

- [System Architecture](#system-architecture)
  - [Overall Architecture](#overall-architecture)
  - [Context Pipeline](#context-pipeline)
  - [Agent System](#agent-system)
  - [Tools System](#tools-system)
  - [MCP System](#mcp-system)
  - [Core Modules](#core-modules)
- [Project Structure](#project-structure)
- [Requirements](#requirements)
- [Backend Development](#backend-root)
- [Desktop App Development](#desktop-app-app)

---

## 🏗️ System Architecture

### Overall Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TuanZi System Architecture                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      User Interface Layer                            │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │   │
│  │  │   Electron   │  │   Renderer   │  │     Main Process         │  │   │
│  │  │   Desktop UI │  │   Process    │  │  ┌────────────────────┐  │  │   │
│  │  │              │  │              │  │  │  Backend Runtime   │  │  │   │
│  │  └──────┬───────┘  └──────┬───────┘  │  │  ┌──────────────┐    │  │  │   │
│  │         │                 │          │  │  │  runtime.ts  │    │  │  │   │
│  │         └────────┬────────┘          │  │  └──────┬───────┘    │  │  │   │
│  │                  │                   │  └─────────┼────────────┘  │  │   │
│  └──────────────────┼───────────────────┘            │               │  │   │
│                     │                                ▼               │  │   │
│  ┌──────────────────┼───────────────────────────────────────────────┐│  │   │
│  │                  ▼                                               ││  │   │
│  │  ┌───────────────────────────────────────────────────────────┐  ││  │   │
│  │  │                    Backend Runtime (src/)                  │  ││  │   │
│  │  ├───────────────────────────────────────────────────────────┤  ││  │   │
│  │  │                                                            │  ││  │   │
│  │  │   ┌────────────┐    ┌────────────┐    ┌────────────┐      │  ││  │   │
│  │  │   │  Agents    │───▶│   Tools    │◀──▶│    MCP     │      │  ││  │   │
│  │  │   │            │    │            │    │  External  │      │  ││  │   │
│  │  │   └─────┬──────┘    └─────┬──────┘    └─────┬──────┘      │  ││  │   │
│  │  │         │                 │                 │             │  ││  │   │
│  │  │         └─────────────────┼─────────────────┘             │  ││  │   │
│  │  │                           ▼                               │  ││  │   │
│  │  │   ┌─────────────────────────────────────────────────────┐ │  ││  │   │
│  │  │   │                  Core Layer                       │ │  ││  │   │
│  │  │   │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │ │  ││  │   │
│  │  │   │  │ Context  │  │  Stores  │  │     Utils        │ │ │  ││  │   │
│  │  │   │  └──────────┘  └──────────┘  └──────────────────┘ │ │  ││  │   │
│  │  │   └─────────────────────────────────────────────────────┘ │  ││  │   │
│  │  └───────────────────────────────────────────────────────────┘  ││  │   │
│  └───────────────────────────────────────────────────────────────────┘│  │   │
│                                                                         │  │   │
└─────────────────────────────────────────────────────────────────────────┴──┴───┘
```

[🔝 Back to TOC](#-table-of-contents)

---

### Context Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Context Pipeline                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────┐   ┌──────────────┐   ┌─────────────┐                           │
│  │ Static   │   │  Dynamic     │   │  Runtime    │                           │
│  │ Context  │   │  Context     │   │  Context    │                           │
│  │          │   │              │   │             │                           │
│  │ • System │   │ • Skill      │   │ • Tool      │                           │
│  │   Prompt │   │   Injection  │   │   Results   │                           │
│  │ • Agent  │   │ • MCP Tool   │   │ • Error     │                           │
│  │   Persona│   │   Discovery  │   │   Context   │                           │
│  │ • Tool   │   │ • SubAgent   │   │ • Partial   │                           │
│  │   Defs   │   │   Delegation │   │   Messages  │                           │
│  └────┬─────┘   └──────┬───────┘   └──────┬──────┘                           │
│       │                │                   │                                 │
│       ▼                ▼                   ▼                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │                   Message Assembly                                  │     │
│  │                                                                     │     │
│  │  messages = [system, ...history, ...toolResults, user]             │     │
│  └──────────────────────────┬──────────────────────────────────────────┘     │
│                             │                                                │
│                             ▼                                                │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │                 Context Gate                                        │     │
│  │                                                                     │     │
│  │  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐           │     │
│  │  │ Token    │  │ Overflow     │  │ Compaction        │           │     │
│  │  │ Counter  │→ │ Detector     │→ │ Engine            │           │     │
│  │  │          │  │ (>85% limit) │  │ (summarize+prune) │           │     │
│  │  └──────────┘  └──────────────┘  └───────────────────┘           │     │
│  └──────────────────────────┬──────────────────────────────────────────┘     │
│                             │                                                │
│                             ▼                                                │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │              OpenAI Compatible Client                               │     │
│  │                                                                     │     │
│  │  fetch → fetchWithRetry (429/5xx backoff, max 2 retries)            │     │
│  │  stream → non-stream fallback → error as context                    │     │
│  └──────────────────────────┬──────────────────────────────────────────┘     │
│                             │                                                │
└─────────────────────────────┼────────────────────────────────────────────────┘
                              │
                              ▼
```

[🔝 Back to TOC](#-table-of-contents)

---

### Agent System

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Agent System Architecture                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      Orchestrator                                    │   │
│  │                   @src/agents/orchestrator.ts                        │   │
│  │                                                                     │   │
│  │   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │   │
│  │   │ Route &      │  │ Plan Mode    │  │ Direct Mode  │             │   │
│  │   │ Dispatch     │  │              │  │              │             │   │
│  │   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘             │   │
│  │          │                 │                 │                      │   │
│  │          └─────────────────┼─────────────────┘                    │   │
│  │                            ▼                                       │   │
│  └────────────────────────────┼───────────────────────────────────────┘   │
│                               │                                          │
│         ┌─────────────────────┼─────────────────────┐                    │
│         │                     │                     │                    │
│         ▼                     ▼                     ▼                    │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐       │
│  │ TuanZi Agent │    │ Planner      │    │   React Tool Agent   │       │
│  │              │    │              │    │                      │       │
│  │ @tuanzi.ts   │    │ @planner-    │    │  @react-tool-agent.ts│       │
│  │              │    │   agent.ts   │    │                      │       │
│  │ • Multi-turn │    │              │    │ • Tool Loop          │       │
│  │ • Skill Meta │    │ • Task Plan  │    │ • SubAgent Spawn     │       │
│  │ • Memory     │    │ • Step Exec  │    │ • Resume/Abort       │       │
│  └──────┬───────┘    └──────┬───────┘    └──────────┬───────────┘       │
│         │                   │                     │                    │
│         └───────────────────┼─────────────────────┘                    │
│                             │                                          │
│                             ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     Supporting Agents                            │   │
│  ├─────────────────────────────────────────────────────────────────┤   │
│  │                                                                 │   │
│  │   ┌────────────────┐    ┌────────────────┐                     │   │
│  │   │ Searcher Agent │    │ SubAgent       │                     │   │
│  │   │                │    │   Explorer     │                     │   │
│  │   │ @searcher-     │    │                │                     │   │
│  │   │   agent.ts     │    │ @subagent-     │                     │   │
│  │   │                │    │   explorer.ts  │                     │   │
│  │   │ • Code Search  │    │                │                     │   │
│  │   │ • Web Search   │    │ • Discovery    │                     │   │
│  │   │ • File Search  │    │ • Delegation   │                     │   │
│  │   └────────────────┘    └────────────────┘                     │   │
│  │                                                                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

[🔝 Back to TOC](#-table-of-contents)

---

### Tools System

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Tools System Architecture                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    Tool Registry                                     │   │
│  │                    @src/core/tool-registry.ts                        │   │
│  │                                                                     │   │
│  │   All tools are managed through a unified registry                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                       │
│         ┌──────────────────────────┼──────────────────────────┐              │
│         │                          │                          │              │
│         ▼                          ▼                          ▼              │
│  ┌──────────────┐        ┌──────────────┐        ┌──────────────┐           │
│  │   File Ops   │        │   Code Edit  │        │   System     │           │
│  ├──────────────┤        ├──────────────┤        ├──────────────┤           │
│  │ • read.ts    │        │ • edit.ts    │        │ • bash.ts    │           │
│  │ • write.ts   │        │ • delete_    │        │ • browser_   │           │
│  │ • ls.ts      │        │   file.ts    │        │   action.ts  │           │
│  │ • glob.ts    │        │ • diff_      │        │              │           │
│  │ • grep.ts    │        │   preview.ts │        │              │           │
│  └──────────────┘        └──────────────┘        └──────────────┘           │
│                                                                             │
│  ┌──────────────┐        ┌──────────────┐        ┌──────────────┐           │
│  │   Interactive│        │   Skill Tools│        │   SubAgent   │           │
│  ├──────────────┤        ├──────────────┤        ├──────────────┤           │
│  │ • ask_user_  │        │ • skill_list │        │ • spawn_     │           │
│  │   question   │        │ • skill_load │        │   subagent   │           │
│  │              │        │ • skill_read │        │ • wait_      │           │
│  │              │        │   _resource  │        │   subagents  │           │
│  │              │        │              │        │ • list_      │           │
│  │              │        │              │        │   subagents  │           │
│  └──────────────┘        └──────────────┘        └──────────────┘           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

[🔝 Back to TOC](#-table-of-contents)

---

### MCP System

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            MCP System Architecture                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                     MCP Manager                                    │   │
│  │                     @src/mcp/manager.ts                              │   │
│  │                                                                     │   │
│  │   Unified management and coordination of multiple MCP clients    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                       │
│                    ┌───────────────┴───────────────┐                       │
│                    │                               │                       │
│                    ▼                               ▼                       │
│  ┌──────────────────────────┐    ┌──────────────────────────┐               │
│  │   Stdio MCP Client       │    │   Remote MCP Client      │               │
│  ├──────────────────────────┤    ├──────────────────────────┤               │
│  │                          │    │                          │               │
│  │ @stdio-mcp-client.ts     │    │ @remote-mcp-client.ts    │               │
│  │                          │    │                          │               │
│  │ • Start local process    │    │ • Connect remote         │               │
│  │ • Stdio communication    │    │ • SSE/WebSocket          │               │
│  │ • Auto reconnect         │    │ • Auth & heartbeat       │               │
│  │ • JSON-RPC protocol      │    │ • Distributed support    │               │
│  │                          │    │                          │               │
│  └───────────┬──────────────┘    └───────────┬──────────────┘               │
│              │                               │                            │
│              ▼                               ▼                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        MCP Tools                                    │   │
│  │                                                                     │   │
│  │   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐         │   │
│  │   │   web_search │    │   fetch_url  │    │   Other MCP  │         │   │
│  │   └──────────────┘    └──────────────┘    └──────────────┘         │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

[🔝 Back to TOC](#-table-of-contents)

---

### Core Modules

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Core Modules Architecture                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         Store Layer                                  │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │                                                                     │   │
│  │   ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐   │   │
│  │   │ AgentStore   │  │ AgentRunStore│  │   CustomModelStore     │   │   │
│  │   └──────────────┘  └──────────────┘  └────────────────────────┘   │   │
│  │   ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐   │   │
│  │   │ SkillStore   │  │ ContextStore │  │   MCPConfigStore       │   │   │
│  │   └──────────────┘  └──────────────┘  └────────────────────────┘   │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        Manager Layer                                 │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │                                                                     │   │
│  │   ┌──────────────────┐  ┌──────────────────┐  ┌────────────────┐   │   │
│  │   │ SubAgentManager  │  │ CheckpointManager│  │ BackupManager  │   │   │
│  │   └──────────────────┘  └──────────────────┘  └────────────────┘   │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        Utils Layer                                   │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │                                                                     │   │
│  │   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │   │
│  │   │ PathUtils    │  │ FileUtils    │  │ JSONUtils    │             │   │
│  │   └──────────────┘  └──────────────┘  └──────────────┘             │   │
│  │   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │   │
│  │   │ SkillParser  │  │ PolicyEngine │  │ Logger       │             │   │
│  │   └──────────────┘  └──────────────┘  └──────────────┘             │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

[🔝 Back to TOC](#-table-of-contents)

---

## 📁 Project Structure

```
MyCoderAgent/
├── 📁 src/                           # Backend runtime source
│   ├── 📁 agents/                    # Agent implementations
│   │   ├── orchestrator.ts           # Orchestrator (routing/plan/direct modes)
│   │   ├── tuanzi.ts                 # Main agent
│   │   ├── react-tool-agent.ts       # Tool loop agent
│   │   ├── planner-agent.ts          # Planner agent
│   │   ├── searcher-agent.ts         # Search agent
│   │   ├── subagent-explorer.ts      # Sub-agent explorer
│   │   └── ...
│   ├── 📁 core/                      # Core modules
│   │   ├── agent-store.ts            # Agent storage
│   │   ├── skill-store.ts            # Skill storage
│   │   ├── subagent-manager.ts       # Sub-agent manager
│   │   ├── tool-registry.ts          # Tool registry
│   │   ├── policy-engine.ts          # Policy engine
│   │   └── ...
│   ├── 📁 tools/                     # Tool implementations
│   │   ├── read.ts, write.ts, edit.ts    # File operations
│   │   ├── bash.ts                   # Command execution
│   │   ├── grep.ts, glob.ts, ls.ts   # Search tools
│   │   ├── spawn-subagent.ts         # Sub-agent tools
│   │   └── ...
│   ├── 📁 mcp/                       # MCP protocol implementations
│   │   ├── manager.ts                # MCP manager
│   │   ├── stdio-mcp-client.ts       # Local process client
│   │   └── remote-mcp-client.ts      # Remote connection client
│   ├── 📁 tests/                     # Test files
│   ├── config.ts                     # Configuration management
│   └── runtime.ts                    # Runtime entry point
│
├── 📁 app/                           # Electron desktop app
│   ├── 📁 src/                       # Frontend source
│   ├── 📁 build/                     # Build configuration
│   └── package.json
│
├── 📁 docs/                          # Design documents
│   ├── context-system-refactor-plan.md   # Context refactoring plan
│   └── ...
│
├── 📄 README.md                      # This document
├── 📄 README.zh-CN.md                # Chinese documentation
├── 📄 package.json                   # Backend dependencies
├── 📄 agent.config.json              # Agent configuration
└── 📄 tsconfig.json                  # TypeScript configuration
```

## Requirements

- Node.js >= 20
- npm

## Backend (root)

Install dependencies:

```bash
npm install
```

Build backend:

```bash
npm run build
```

Run backend tests:

```bash
npm test
```

## Desktop App (`app/`)

Install app dependencies:

```bash
cd app
npm install
```

Run app in development:

```bash
npm run dev
```

Build app:

```bash
npm run build
```

## Notes

- App main process loads backend modules from root `dist/` output.
- Build backend first when validating app integration in a fresh environment.

## License

MIT
