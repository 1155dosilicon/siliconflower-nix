import { describe, expect, test } from "bun:test";
import { runHook, loadHooksConfig } from "../src/core/hooks.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile, rm } from "node:fs/promises";
import { getWorkspaceDataDir, ensureDir } from "../src/fs-util.js";

describe("hooks system", () => {
  test("returns executed=false when no hook command configured", async () => {
    const res = await runHook("preTool", {});
    expect(res.executed).toBe(false);
  });

  test("executes hook command with environment variables", async () => {
    const isWin = process.platform === "win32";
    const echoCmd = isWin
      ? "Write-Output \"$env:SILICONFLOWER_TOOL_NAME|$env:SILICONFLOWER_FILE_PATH\""
      : "echo \"$SILICONFLOWER_TOOL_NAME|$SILICONFLOWER_FILE_PATH\"";
    const filePath = isWin ? "C:\\workspace\\test.txt" : "/workspace/test.txt";

    const res = await runHook(
      "preTool",
      { preTool: echoCmd },
      { toolName: "read_file", toolArgs: { path: "test.txt" }, filePath }
    );

    expect(res.executed).toBe(true);
    expect(res.output).toContain("read_file");
    expect(res.output).toContain(filePath);
  });

  test("loads hooks from centralized workspace directory", async () => {
    const dummyCwd = join(tmpdir(), `dummy_hook_ws_${Date.now()}`);
    const wsDir = getWorkspaceDataDir(dummyCwd);
    await ensureDir(wsDir);

    const hookFile = join(wsDir, "hooks.json");
    await writeFile(hookFile, JSON.stringify({ preTool: "echo workspace_hook" }), "utf8");

    const loaded = await loadHooksConfig(dummyCwd);
    expect(loaded).toBeDefined();
    expect(loaded?.preTool).toBe("echo workspace_hook");

    await rm(wsDir, { recursive: true, force: true });
  });
});
