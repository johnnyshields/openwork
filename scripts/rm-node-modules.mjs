import { rmSync, existsSync } from "node:fs";
const roots = [
  "C:\\workspace\\openwork\\node_modules",
  "C:\\workspace\\openwork\\apps\\app\\node_modules",
  "C:\\workspace\\openwork\\apps\\desktop\\node_modules",
  "C:\\workspace\\openwork\\apps\\opencode-router\\node_modules",
  "C:\\workspace\\openwork\\apps\\orchestrator\\node_modules",
  "C:\\workspace\\openwork\\apps\\server\\node_modules",
  "C:\\workspace\\openwork\\apps\\server-v2\\node_modules",
  "C:\\workspace\\openwork\\apps\\share\\node_modules",
  "C:\\workspace\\openwork\\apps\\story-book\\node_modules",
  "C:\\workspace\\openwork\\apps\\ui-demo\\node_modules",
  "C:\\workspace\\openwork\\ee\\apps\\den-api\\node_modules",
  "C:\\workspace\\openwork\\ee\\apps\\den-controller\\node_modules",
  "C:\\workspace\\openwork\\ee\\apps\\den-web\\node_modules",
  "C:\\workspace\\openwork\\ee\\apps\\den-worker-proxy\\node_modules",
  "C:\\workspace\\openwork\\ee\\apps\\landing\\node_modules",
  "C:\\workspace\\openwork\\ee\\packages\\den-db\\node_modules",
  "C:\\workspace\\openwork\\ee\\packages\\utils\\node_modules",
  "C:\\workspace\\openwork\\packages\\openwork-server-sdk\\node_modules",
  "C:\\workspace\\openwork\\packages\\openwork-ui-mcp\\node_modules",
  "C:\\workspace\\openwork\\packages\\types\\node_modules",
  "C:\\workspace\\openwork\\packages\\ui\\node_modules",
];
for (const r of roots) {
  if (!existsSync(r)) {
    console.log(`skip (missing): ${r}`);
    continue;
  }
  process.stdout.write(`rm: ${r} ... `);
  const t0 = Date.now();
  rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
console.log("done");
