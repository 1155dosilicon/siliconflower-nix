import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, modeLabel, nextMode } from "../src/modes.js";

describe("modes", () => {
  test("modeLabel returns shorthand mode names", () => {
    expect(modeLabel("programação")).toBe("PROG");
    expect(modeLabel("sistema")).toBe("SISTEMA");
    expect(modeLabel("plano")).toBe("PLANO");
  });

  test("nextMode cycles modes properly", () => {
    expect(nextMode("programação")).toBe("sistema");
    expect(nextMode("sistema")).toBe("plano");
    expect(nextMode("plano")).toBe("programação");
  });

  test("buildSystemPrompt builds detailed prompt with mode and cwd", () => {
    const prompt = buildSystemPrompt("programação", "Be concise", []);
    expect(prompt).toContain("siliconflower");
    expect(prompt).toContain("MODO PROGRAMAÇÃO");
    expect(prompt).toContain("Bun/Node");
    expect(prompt).toContain("Be concise");
    expect(prompt).toContain(process.cwd().replace(/\\/g, "/"));
  });

  test("buildSystemPrompt includes platform in sistema mode", () => {
    const prompt = buildSystemPrompt("sistema", undefined, []);
    expect(prompt).toContain("MODO SISTEMA");
    if (process.platform === "win32") {
      expect(prompt).toContain("Windows");
      expect(prompt).toContain("PowerShell");
    } else {
      expect(prompt).toContain("Linux/Unix");
    }
  });
});
