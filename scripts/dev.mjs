import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const useShell = process.platform === "win32";

const api = spawn(npmCmd, ["start"], {
  cwd: resolve(root, "api"),
  stdio: "inherit",
  shell: useShell,
});

const frontend = spawn(npmCmd, ["run", "dev"], {
  cwd: resolve(root, "frontend"),
  stdio: "inherit",
  shell: useShell,
});

function shutdown(signal) {
  api.kill(signal);
  frontend.kill(signal);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

api.on("exit", (code) => {
  if (code && code !== 0) {
    frontend.kill();
    process.exit(code);
  }
});

frontend.on("exit", (code) => {
  api.kill();
  process.exit(code ?? 0);
});
