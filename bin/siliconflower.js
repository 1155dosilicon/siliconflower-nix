#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, "..", "src", "index.tsx");

function findRunner() {
  const bunProbe = spawnSync("bun", ["--version"], { shell: false, stdio: "ignore" });
  if (!bunProbe.error && bunProbe.status === 0) {
    return ["bun", ["run", entry]];
  }

  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");
  return [process.execPath, [tsxCli, entry]];
}

const [cmd, args] = findRunner();
const result = spawnSync(cmd, [...args, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: false,
  env: process.env,
});

if (result.error) {
  if ((result.error).code === "ENOENT") {
    process.stderr.write(
      "\nsiliconflower requires Bun or Node + tsx.\nInstall Bun: https://bun.sh  or run:  npm install\n"
    );
  } else {
    process.stderr.write(String(result.error));
  }
  process.exit(1);
}
process.exit(result.status ?? 0);
