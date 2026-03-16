# TuanZi Backend + App

[简体中文](./README.zh-CN.md) | English

This repository is now focused on two parts:

- `src/`: TuanZi backend runtime (agent orchestration, tools, MCP, config)
- `app/`: TuanZi desktop app (Electron + renderer)

The legacy CLI surface has been removed.

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
