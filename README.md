# TuanZi (团子) CLI

<img src="./assets/logo.png" width="160" align="right" alt="TuanZi Mascot" />

[简体中文](./README.zh-CN.md) | English

A terminal-native coding agent with tool orchestration, safe execution controls, and OpenAI-compatible model routing.

### Overview
TuanZi is a pragmatic TypeScript CLI coding agent. It runs a plan-and-execute loop with local tools (file I/O, search, command execution, web fetch) to complete real engineering tasks, with interactive chat, checkpoints, and model switching.

### Highlights
- Terminal chat mode with multiline input and session checkpoints.
- Tool orchestration for files, commands, search, and web tasks.
- Safety controls via approval modes: `manual | auto | deny`.
- OpenAI-compatible model integration via a local model store.

### Requirements
- Node.js >= 20
- npm

### Quick Start
```bash
npm install
npm run build
```

Start interactive chat:
```bash
npm start -- chat --approval manual
```

Run a one-off task:
```bash
npm start -- agent run --task "Implement a new command and add tests" --approval manual
```

### Interactive Slash Commands
- `/help`
- `/model list | add | use | rm`
- `/checkpoint save|load|list|drop|git`
- `/tools` `/config` `/cost`
- `!<command>` run shell command directly
- `@<path>` attach a file into prompt context

### Model Configuration (Important)
Runtime reads models from the model store only; no fallback to model env vars.

Default path:
- `~/.tuanzi/models.json`

Example:
```json
{
  "defaultModel": "qwen3.5-plus",
  "models": [
    {
      "name": "qwen3.5-plus",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "modelId": "qwen3.5-plus",
      "apiKey": "<your-api-key>"
    }
  ]
}
```

You can also manage models in chat:
- `/model add <name> <baseUrl> <modelId> <apiKey>`
- `/model use <name>`

Optional: set `TUANZI_MODELS_PATH` to use a custom model store path.

### Thinking Mode (OpenAI-Compatible)
Configure request-level reasoning/thinking options in `agent.config.json`:

```json
{
  "modelRequest": {
    "reasoningEffort": "medium",
    "thinking": {
      "type": "enabled",
      "budgetTokens": 4096
    },
    "extraBody": {
      "enable_thinking": true
    }
  }
}
```

Notes:
- `reasoningEffort` maps to request field `reasoning_effort` (OpenAI-compatible).
- `thinking` maps to request field `thinking` (for providers like DeepSeek).
- `extraBody` passes through provider-specific extension fields.

### Project Layout
- `src/agents/`: orchestration and model clients
- `src/core/`: policy, approvals, safety, shared runtime types
- `src/tools/`: tool implementations
- `src/tui/`: interactive terminal UI
- `src/tests/`: tests

### Build & Test
```bash
npm run build
npm test
```

## License
MIT
