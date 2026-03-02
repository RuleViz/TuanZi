# MyCoderAgent MVP

基于 `基础功能MVP实施计划.md` 落地的本地可执行 MVP，目标是打通闭环：

`找文件 -> 读代码 -> 局部修改 -> 运行命令验证`

## 已实现能力

### Phase 1: 读写抽象层
- `Tool` 统一接口 + JSON Schema 描述
- `list_dir`
- `view_file`（分页读取，行号前缀）
- `write_to_file`（自动创建父目录，覆盖写入）
- `delete_file`（文件或空目录）

### Phase 2: 搜索与探索
- `find_by_name`（glob 模式，条数限制）
- `grep_search`（行号 + 上下文）
- `search_web`（优先通过 MCP 工具）
- `fetch_url` / `read_url_content`（可通过 MCP 工具桥接）

### Phase 3: 智能修改引擎
- `diff_apply`（统一 diff 多 hunk 修改，支持模糊匹配）

### Phase 4: 命令执行与安全循环
- `run_command`（阻塞执行、超时、输出截断）
- 人类审批门禁（`manual/auto/deny`）
- 写入前临时备份（`.mycoderagent/backups`）
- 策略引擎（`allow/ask/deny`，支持命令黑白名单）

### Phase 5: PlanToDo 组装
- `Planner -> Searcher -> Coder` 三上下文隔离编排
- 支持 OpenAI-Compatible 接口并允许三个角色使用不同模型
- 防幻觉约束：不确定依赖/版本时要求先 `fetch_url` 再改代码
- 直答路由（`direct`）与工作流路由（`workflow`）配置化
- no-progress 断路器（重复工具调用自动终止）
- 联网搜索预算控制、TTL 缓存、来源评分排序

### Phase 6: 交互式 CLI（终端多轮会话）
- 默认进入交互模式（`tuanzi` / `npm start --`）
- 斜杠命令：`/help`、`/clear`、`/model`、`/checkpoint`、`/tools`、`/config`、`/cost`、`/exit`
- 会话记忆：自动携带最近 10 轮上下文
- Agent 阶段指示：Running
- 工具调用可视化：工具名、参数、状态、结果摘要
- 会话检查点：`/checkpoint save|load|list|drop`
- 终端直执行：`!<command>`
- 文件引用：在提问里使用 `@path/to/file`
- 流式回复：CLI 支持 OpenAI-Compatible SSE token 实时输出
- 项目上下文：每轮自动注入工作区 `TUANZI.md`（若存在）
- 多行输入：在行尾输入 `\` 继续下一行，支持 `Esc` 清空草稿、`Ctrl+L` 清屏

## 项目结构

```txt
src/
  agents/     # Planner/Searcher/Coder 与模型调用
  core/       # Tool 抽象、审批、备份、路径安全、diff 预览
  tools/      # 文件系统与命令执行工具
  tests/      # 单元测试
  cli.ts      # CLI 入口
```

## 使用方式

1) 安装依赖

```bash
npm install
```

2) 编译

```bash
npm run build
```

3) 运行交互式 CLI（推荐）

```bash
npm start --
# 或
npm start -- chat --approval manual
```

4) 运行单次 Agent 任务（批处理）

```bash
npm start -- agent run --task "按照需求修改并验证代码" --approval manual
```

5) 启动 Web 交互页面

```bash
npm start -- web start --host 127.0.0.1 --port 3000 --approval manual
```

浏览器打开 `http://127.0.0.1:3000`。
Web 端当前为非流式响应（一次性返回）。
页面会展示：
- 聊天历史（每轮 user/agent）
- Plan / Search / Coder 结构化输出
- 工具调用记录（tool name、args、result）

6) 调试单个工具

```bash
npm start -- tools list
npm start -- tools run view_file --args "{\"path\":\"E:\\\\project\\\\Nice\\\\MyCoderAgent\\\\README.md\",\"start_line\":1,\"end_line\":40}"
npm start -- tools run view_file --args-file .\\tool-args.json
```

7) 运行测试

```bash
npm test
```

## 模型配置（OpenAI-Compatible）

Qwen（默认优先）可直接使用：

```bash
set QWEN_API_KEY=sk-xxxx
```

默认会自动使用：
- `MYCODER_API_BASE_URL=https://coding.dashscope.aliyuncs.com/v1`
- `MYCODER_MODEL=qwen3.5-plus`

也可以通过 `MYCODER_*` 变量显式覆盖：

```bash
set MYCODER_API_BASE_URL=https://api.openai.com/v1
set MYCODER_API_KEY=sk-xxxx
set MYCODER_MODEL=gpt-4o-mini
set TAVILY_API_KEY=tvly-xxxx
```

DeepSeek 也可直接使用（不需要再手动映射）：

```bash
set DEEPSEEK_API_KEY=sk-xxxx
set MYCODER_MODEL=deepseek-chat
```

可选分角色配置：

- `MYCODER_PLANNER_MODEL`
- `MYCODER_SEARCH_MODEL`
- `MYCODER_CODER_MODEL`

交互模式支持临时会话切换：

```bash
npm start -- chat --model deepseek-chat
```

工作区可选上下文文件：

- `TUANZI.md`：存在时会在每轮任务自动注入为项目约束上下文（带长度截断保护）

如果未配置 `MYCODER_API_KEY`、`QWEN_API_KEY` 且未配置 `DEEPSEEK_API_KEY`，系统会进入降级模式（工具可用，Agent 不自动改代码）。

## MCP 联网能力配置

在 `agent.config.json` 中配置：

```json
{
  "webSearch": {
    "provider": "mcp"
  },
  "mcp": {
    "enabled": true,
    "command": "npx",
    "args": ["-y", "your-mcp-server"],
    "tools": {
      "webSearch": "web_search",
      "fetchUrl": "fetch_url"
    }
  }
}
```

说明：
- `search_web` 会调用 `mcp.tools.webSearch`
- `fetch_url/read_url_content` 在 `provider=mcp` 时会调用 `mcp.tools.fetchUrl`
- 如需兼容旧实现，可将 `webSearch.provider` 改为 `http`

## 安全说明

- 所有文件路径必须是绝对路径且位于工作区根目录内。
- 破坏性操作默认由 `agent.config.json` 策略控制（默认 `ask`）。
- 命令执行工具会对高风险命令提升风险等级并要求确认。

## agent.config.json

项目根目录可配置：
- `routing`：直答路由开关与意图关键词
- `policy`：工具级 allow/ask/deny，`run_command` 黑白名单
- `webSearch`：联网搜索开关、provider、预算、缓存 TTL、页面字符上限
- `toolLoop`：Searcher/Coder 最大回合与 no-progress 断路器阈值
