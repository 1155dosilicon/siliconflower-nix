import { describe, expect, test } from "bun:test";
import { builtinToolsAsMcp, isBuiltin, runBuiltin, BUILTIN_TOOLS } from "../src/tools.js";
import { parse } from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("tools", () => {
  test("isBuiltin recognizes builtin tools", () => {
    expect(isBuiltin("read_file")).toBe(true);
    expect(isBuiltin("write_file")).toBe(true);
    expect(isBuiltin("execute_command")).toBe(true);
    expect(isBuiltin("unknown_tool")).toBe(false);
  });

  test("builtinToolsAsMcp returns all tools in MCP schema format", () => {
    const list = builtinToolsAsMcp();
    expect(list.length).toBe(BUILTIN_TOOLS.length);
    expect(list.every((t) => t.server === "builtin")).toBe(true);
  });

  test("delete_path enforces confirm requirement", async () => {
    const res = await runBuiltin("delete_path", { path: "some_file.txt", confirm: false });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("confirmação");
  });

  test("delete_path refuses filesystem roots even with confirmation", async () => {
    const res = await runBuiltin("delete_path", { path: parse(process.cwd()).root, recursive: true, confirm: true });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("caminho crítico");
  });

  test("blocked paths prevent access to system directories", async () => {
    const blocked = process.platform === "win32"
      ? "C:\\Windows\\System32\\config\\SAM"
      : "/etc/passwd";
    const res = await runBuiltin("read_file", { path: blocked });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("bloqueado");
  });

  test("recursive search tools cannot bypass sensitive path guards", async () => {
    const sensitivePath = join(tmpdir(), ".ssh");
    const grepRes = await runBuiltin("grep_content", { path: sensitivePath, pattern: "secret" });
    const listRes = await runBuiltin("list_directory", { path: sensitivePath });
    expect(grepRes.isError).toBe(true);
    expect(listRes.isError).toBe(true);
  });

  test("execute_command runs shell commands and returns output", async () => {
    const cmd = process.platform === "win32"
      ? "Write-Output 'hello siliconflower'"
      : "echo 'hello siliconflower'";
    const res = await runBuiltin("execute_command", { command: cmd });
    expect(res.isError).toBe(false);
    expect(res.result).toContain("hello siliconflower");
  });

  test("edit_file rejects empty oldText", async () => {
    const res = await runBuiltin("edit_file", { path: "package.json", oldText: "", newText: "foo" });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("oldText não pode ser vazio");
  });

  test("apply_patch rejects empty oldText in changes", async () => {
    const res = await runBuiltin("apply_patch", { path: "package.json", changes: [{ oldText: "", newText: "foo" }] });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("oldText não pode ser vazio");
  });

  test("todowrite normalizes status and priority synonyms", async () => {
    const res = await runBuiltin("todowrite", {
      todos: [
        { content: "Task 1", status: "done", priority: "HIGH" },
        { content: "Task 2", status: "in-progress", priority: "LOW" },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.result).toContain("2 itens");
  });
});
