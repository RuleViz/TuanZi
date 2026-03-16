# TuanZi Backend + App

简体中文 | [English](./README.md)

当前仓库已转型为两部分：

- `src/`：TuanZi 后端运行时（Agent 编排、工具、MCP、配置等）
- `app/`：TuanZi 桌面端（Electron + renderer）

历史 CLI 端代码已移除。

## 环境要求

- Node.js >= 20
- npm

## 后端（根目录）

安装依赖：

```bash
npm install
```

构建后端：

```bash
npm run build
```

运行后端测试：

```bash
npm test
```

## 桌面端（`app/`）

安装依赖：

```bash
cd app
npm install
```

开发模式运行：

```bash
npm run dev
```

构建桌面端：

```bash
npm run build
```

## 说明

- App 主进程会从根目录 `dist/` 加载后端模块。
- 在全新环境验证联调时，建议先构建后端。

## License

MIT
