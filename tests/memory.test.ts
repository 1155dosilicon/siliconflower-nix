import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { saveMemory, recallMemories, forgetMemory, buildMemorySystemPrompt } from "../src/services/memory.js";
import { rm, access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getWorkspaceDataDir } from "../src/fs-util.js";
import { findProject } from "../src/project.js";

describe("memory service", () => {
  let testWorkspace = "";

  beforeEach(async () => {
    testWorkspace = join(tmpdir(), `memory_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    await mkdir(testWorkspace, { recursive: true });
    // The marker file is what activates project memory.
    await writeFile(join(testWorkspace, "SILICONFLOWER.md"), "Use tabs. Rode bun test antes de concluir.", "utf8");
  });

  afterEach(async () => {
    try {
      await rm(getWorkspaceDataDir(testWorkspace), { recursive: true, force: true });
    } catch {}
    try {
      await rm(testWorkspace, { recursive: true, force: true });
    } catch {}
  });

  test("saves and recalls project memory without creating .siliconflower in the workspace", async () => {
    const saveRes = await saveMemory(
      {
        name: "test_rule",
        type: "feedback",
        description: "Always write clean code with comments",
        scope: "project",
        content: "Rule details: Always add concise docstrings to public exports.",
      },
      testWorkspace
    );

    expect(saveRes.message).toContain("salva com sucesso");

    let localDirExists = false;
    try {
      await access(join(testWorkspace, ".siliconflower"));
      localDirExists = true;
    } catch {
      localDirExists = false;
    }
    expect(localDirExists).toBe(false);

    expect(saveRes.path).toContain("workspaces");

    const memories = await recallMemories("clean code", testWorkspace);
    const found = memories.find((m) => m.name === "test_rule");
    expect(found?.content).toContain("Rule details");
  });

  test("system prompt carries project instructions and only an index of memories", async () => {
    await saveMemory(
      {
        name: "deploy_steps",
        type: "project",
        description: "Como fazer deploy",
        scope: "project",
        content: "CONTEUDO_LONGO_SECRETO_DO_DEPLOY",
      },
      testWorkspace
    );

    const prompt = await buildMemorySystemPrompt(testWorkspace);
    expect(prompt).toContain("Use tabs. Rode bun test antes de concluir.");
    expect(prompt).toContain("deploy_steps");
    expect(prompt).toContain("Como fazer deploy");
    expect(prompt).toContain("recall_memory");
    // Full content is loaded on demand only.
    expect(prompt).not.toContain("CONTEUDO_LONGO_SECRETO_DO_DEPLOY");
  });

  test("subfolders share the project memory", async () => {
    const sub = join(testWorkspace, "src", "deep");
    await mkdir(sub, { recursive: true });
    expect(findProject(sub)?.root).toBe(testWorkspace);
    expect(getWorkspaceDataDir(sub)).toBe(getWorkspaceDataDir(testWorkspace));

    await saveMemory(
      { name: "shared", type: "project", description: "d", scope: "project", content: "c" },
      sub
    );
    const fromRoot = await recallMemories("shared", testWorkspace);
    expect(fromRoot.some((m) => m.name === "shared")).toBe(true);
  });

  test("folders without a marker have project memory disabled", async () => {
    const plain = join(tmpdir(), `memory_plain_${Date.now()}`);
    await mkdir(plain, { recursive: true });
    try {
      expect(findProject(plain)).toBeNull();
      await expect(
        saveMemory({ name: "x", type: "project", description: "d", scope: "project", content: "c" }, plain)
      ).rejects.toThrow("Memória de projeto desativada");

      expect((await forgetMemory("x", plain, "project")).isError).toBe(true);
      const prompt = await buildMemorySystemPrompt(plain);
      expect(prompt).toContain("Nenhum projeto ativo");
      // Reads never create data directories for non-project folders.
      let created = true;
      try {
        await access(join(getWorkspaceDataDir(plain), "memory"));
      } catch {
        created = false;
      }
      expect(created).toBe(false);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  test("AGENTS.md also activates a project", async () => {
    const dir = join(tmpdir(), `memory_agents_${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "regras", "utf8");
    try {
      expect(findProject(dir)?.markerPath).toBe(join(dir, "AGENTS.md"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("forgets memory by name", async () => {
    await saveMemory(
      {
        name: "obsolete_rule",
        type: "project",
        description: "Temporary obsolete rule",
        scope: "project",
        content: "This rule will be forgotten.",
      },
      testWorkspace
    );

    const forgetRes = await forgetMemory("obsolete_rule", testWorkspace);
    expect(forgetRes.isError).toBe(false);
    expect(forgetRes.message).toContain("removida com sucesso");

    const memories = await recallMemories("obsolete_rule", testWorkspace);
    expect(memories.find((m) => m.name === "obsolete_rule")).toBeUndefined();
  });

  test("forgets only the requested memory scope", async () => {
    const name = `scoped_rule_${Date.now()}`;
    const base = {
      name,
      type: "project" as const,
      description: "Scoped memory",
      content: "Scope-specific content",
    };
    await saveMemory({ ...base, scope: "project" }, testWorkspace);
    await saveMemory({ ...base, scope: "global" }, testWorkspace);

    expect((await forgetMemory(name, testWorkspace, "project")).isError).toBe(false);
    const remaining = await recallMemories(name, testWorkspace);
    expect(remaining.some((entry) => entry.scope === "global")).toBe(true);
    expect(remaining.some((entry) => entry.scope === "project")).toBe(false);
    await forgetMemory(name, testWorkspace, "global");
  });

  test("multi-line descriptions don't break the frontmatter", async () => {
    await saveMemory(
      { name: "multi", type: "user", description: "linha 1\nlinha 2", scope: "project", content: "name: falso" },
      testWorkspace
    );
    const [m] = await recallMemories("multi", testWorkspace);
    expect(m.name).toBe("multi");
    expect(m.description).toBe("linha 1 linha 2");
    expect(m.content).toBe("name: falso");
  });
});
