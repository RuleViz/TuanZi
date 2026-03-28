const { spawn } = require("node:child_process");
const { dirname, join } = require("node:path");

const mode = process.argv[2];
if (!mode) {
  console.error("Missing electron-vite mode.");
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const packageRoot = dirname(require.resolve("electron-vite/package.json"));
const cliPath = join(packageRoot, "bin", "electron-vite.js");

const child = spawn(
  process.execPath,
  [cliPath, mode],
  {
    stdio: "inherit",
    env
  }
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
