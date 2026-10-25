#!/usr/bin/env node
/**
 * Cross-platform install launcher.
 * Windows -> scripts/install.ps1; Unix -> scripts/install.sh
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

if (process.platform === "win32") {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "install.ps1")],
    { stdio: "inherit", shell: false }
  );
  process.exit(result.status ?? 1);
}

const result = spawnSync("bash", [join(here, "install.sh")], {
  stdio: "inherit",
  shell: false,
});
process.exit(result.status ?? 1);
