# TuanZi (团子) CLI

<img src="./assets/logo.png" width="160" align="right" alt="TuanZi Mascot" />

简体中文 | [English](./README.md)

一个终端原生的编程 Agent，具备工具编排、安全执行控制与 OpenAI 兼容模型路由能力。

### 项目简介
TuanZi 是一个面向工程实践的 TypeScript CLI Agent。它通过“规划-执行”循环调用本地工具（读写文件、搜索、命令执行、网页读取等）来完成真实开发任务，并在交互模式中提供会话、检查点与模型切换能力。

### 核心能力
- 终端交互模式：支持多行输入、历史、会话检查点。
- 工具编排执行：内置文件、命令、检索、网页等工具。
- 安全策略控制：支持 `manual | auto | deny` 审批模式和策略规则。
- OpenAI 兼容模型接入：通过本地模型仓库统一管理。

### 环境要求
- Node.js >= 20
- npm

### 快速开始
```bash
npm install
npm run build
```

进入交互模式：
```bash
npm start -- chat --approval manual
```

执行一次性任务：
```bash
npm start -- agent run --task "实现一个新命令并补充测试" --approval manual
```

### 交互模式 Slash 命令
- `/help`
- `/model list | add | use | rm`
- `/checkpoint save|load|list|drop|git`
- `/tools` `/config` `/cost`
- `!<command>` 直接执行终端命令
- `@<path>` 在输入中引用文件内容

### 模型配置（重要）
运行时仅从模型仓库读取配置，不再回退到模型环境变量。

默认文件路径：
- `~/.tuanzi/models.json`

示例：
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

也可在交互模式中直接配置：
- `/model add <name> <baseUrl> <modelId> <apiKey>`
- `/model use <name>`

可选：通过 `TUANZI_MODELS_PATH` 指定自定义模型仓库路径。

### 项目结构
- `src/agents/`：Agent 编排与模型客户端
- `src/core/`：策略、审批、路径安全、上下文与基础类型
- `src/tools/`：工具实现
- `src/tui/`：交互式终端
- `src/tests/`：测试

### 开发与测试
```bash
npm run build
npm test
```

## License
MIT
