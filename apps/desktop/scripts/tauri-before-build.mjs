import { spawnSync } from "node:child_process";

const pnpmCmd = process.platform === "win32" ? "corepack.cmd" : "pnpm";
const pnpmArgs = process.platform === "win32" ? ["pnpm"] : [];

const runPnpm = (args) => {
  const result = spawnSync(pnpmCmd, [...pnpmArgs, ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

runPnpm(["-C", "../..", "--filter", "@openwork/desktop", "run", "prepare:sidecar"]);
// BEGIN-PANTHEON-OVERRIDE — pass build mode to select .env.development or .env.production
const buildMode = process.env.BUILD_MODE || "production";
const viteResult = spawnSync(
  pnpmCmd,
  [...pnpmArgs, "--filter", "@openwork/app", "exec", "vite", "build", "--mode", buildMode],
  { stdio: "inherit", shell: process.platform === "win32" },
);
if (viteResult.status !== 0) {
  process.exit(viteResult.status ?? 1);
}
// END-PANTHEON-OVERRIDE
