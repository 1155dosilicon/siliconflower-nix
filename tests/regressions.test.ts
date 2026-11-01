import { describe, expect, test, afterAll } from "bun:test";
import { writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runShell, decodeClixml } from "../src/shell.js";
import { htmlToMarkdown, isPrivateAddress, webFetch } from "../src/services/web.js";
import { buildOpenAIMessages, isOfficialOpenAIEndpoint } from "../src/llm.js";
import { normalize } from "../src/config.js";
import { createArtifact, readArtifact, listArtifacts, deleteArtifact, getArtifactsDir } from "../src/services/artifact.js";
import { smartEditFile } from "../src/services/smart-edit.js";
import { runBuiltin } from "../src/tools.js";
import { extractSymbols, generateRepoMap } from "../src/services/repomap.js";
import { searchContent } from "../src/grep.js";
import { renderLogo } from "../src/ascii.js";
import type { AppConfig, ChatMessage } from "../src/types.js";

const tmp = join(tmpdir(), `sf_regressions_${Date.now()}`);

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

const isWin = process.platform === "win32";

describe("shell runner", () => {
  test("returns UTF-8 output (accents are not corrupted)", async () => {
    const res = await runShell(isWin ? `Write-Output 'ação ç "aspas"'` : `printf '%s\\n' 'ação ç "aspas"'`);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('ação ç "aspas"');
  });

  test("returns stderr as plain text and the real exit code", async () => {
    const res = await runShell(isWin ? `Write-Error 'falhou é'; exit 3` : `echo 'falhou é' >&2; exit 3`);
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain("falhou é");
    expect(res.stderr).not.toContain("CLIXML");
    expect(res.stderr).not.toContain("OutputEncoding");
  });

  test("timeout kills the command", async () => {
    const started = Date.now();
    const res = await runShell(isWin ? "Start-Sleep -Seconds 20" : "sleep 20", { timeout: 1000 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15000);
  });

  test.skipIf(isWin)("timeout kills child processes too (no orphans)", async () => {
    const marker = `29.${Date.now() % 100000}`; // unique sleep argument to find the child in ps
    // The subshell keeps the pipes open, so the runner only returns once the whole group dies.
    const started = Date.now();
    const res = await runShell(`sleep ${marker} & wait`, { timeout: 800 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10000);
    const ps = await runShell(`ps -eo args | grep -v grep | grep -c "sleep ${marker}" || true`);
    expect(ps.stdout.trim()).toBe("0");
  });

  test("decodes CLIXML error records", () => {
    const xml = `#< CLIXML\r\n<Objs><S S="Error">linha 1_x000D__x000A_</S><S S="Error">a &lt;b&gt; &amp; c</S></Objs>`;
    expect(decodeClixml(xml)).toBe("linha 1\r\na <b> & c");
  });
});

describe("web", () => {
  test("blocks IPv4-mapped IPv6 loopback in hex form (as serialized by URL)", () => {
    const host = new URL("http://[::ffff:127.0.0.1]/").hostname.replace(/^\[|\]$/g, "");
    expect(isPrivateAddress(host)).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("64:ff9b::7f00:1")).toBe(true);
    expect(isPrivateAddress("::ffff:808:808")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });

  test("decodes entities once and supports astral code points", () => {
    expect(htmlToMarkdown("<p>&amp;lt;tag&amp;gt;</p>")).toBe("&lt;tag&gt;");
    expect(htmlToMarkdown("<p>&#128512; &#x1F600;</p>")).toBe("😀 😀");
  });

  test("maxChars limits the converted text, not the raw HTML", async () => {
    const head = `<head>${"<script>var x = 1;</script>".repeat(2000)}</head>`;
    const html = `<html>${head}<body><h1>Conteúdo real</h1><p>Texto do artigo.</p></body></html>`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as unknown as typeof fetch;
    try {
      // A public IP literal skips DNS; fetch itself is mocked.
      const res = await webFetch("http://93.184.216.34/", { maxChars: 1000 });
      expect(res.isError).toBe(false);
      expect(res.content).toContain("# Conteúdo real");
      expect(res.content).toContain("Texto do artigo.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("llm adapter", () => {
  const config: AppConfig = { baseURL: "https://api.siliconflow.com/v1", apiKey: "k", model: "m", reasoning: "none" };

  test("detects the official OpenAI endpoint", () => {
    expect(isOfficialOpenAIEndpoint("https://api.openai.com/v1")).toBe(true);
    expect(isOfficialOpenAIEndpoint("https://openrouter.ai/api/v1")).toBe(false);
  });

  test("skips tool results whose assistant tool call was compacted away", () => {
    const messages: ChatMessage[] = [
      { role: "tool", toolCallId: "gone", content: "orphan" },
      { role: "user", content: "oi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] },
      { role: "tool", toolCallId: "c1", content: "ok" },
    ];
    const out = buildOpenAIMessages(config, messages);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });
});

describe("config", () => {
  test("stored config ignores environment overrides", () => {
    const previous = process.env.SILICONFLOWER_API_KEY;
    process.env.SILICONFLOWER_API_KEY = "from-env";
    try {
      expect(normalize({ apiKey: "from-file" }).apiKey).toBe("from-env");
      expect(normalize({ apiKey: "from-file" }, { applyEnv: false }).apiKey).toBe("from-file");
    } finally {
      if (previous === undefined) delete process.env.SILICONFLOWER_API_KEY;
      else process.env.SILICONFLOWER_API_KEY = previous;
    }
  });
});

describe("artifacts", () => {
  const cwd = join(tmp, "art_ws");

  test("titles and summaries with quotes round-trip", async () => {
    const id = `quotes_${Date.now()}`;
    await createArtifact({ id, title: 'Plano "A"', type: "markdown", content: "x", summary: 'Diz "oi"', cwd });
    const item = (await listArtifacts(cwd)).find((a) => a.id === id);
    expect(item?.title).toBe('Plano "A"');
    expect(item?.summary).toBe('Diz "oi"');
    await deleteArtifact(id, cwd);
  });

  test("changing the type replaces the previous file and keeps metadata for html", async () => {
    const id = `retype_${Date.now()}`;
    await createArtifact({ id, title: "Doc", type: "markdown", content: "# md", summary: "s", cwd });
    await createArtifact({ id, title: "Página", type: "html", content: "<p>html</p>", summary: "resumo html", cwd });
    const files = (await readdir(getArtifactsDir(cwd))).filter((f) => f.startsWith(id));
    expect(files.sort()).toEqual([`${id}.html`, `${id}.meta`]);
    expect((await readArtifact(id, cwd))?.content).toBe("<p>html</p>");
    const item = (await listArtifacts(cwd)).find((a) => a.id === id);
    expect(item?.title).toBe("Página");
    expect(item?.summary).toBe("resumo html");
    expect((await deleteArtifact(id, cwd)).success).toBe(true);
    expect((await readdir(getArtifactsDir(cwd))).filter((f) => f.startsWith(id))).toEqual([]);
  });
});

describe("file edits keep CRLF line endings", () => {
  test("edit_file exact match converts newText to CRLF", async () => {
    const file = join(tmpdir(), `crlf_edit_${Date.now()}.txt`);
    await writeFile(file, "a\r\nb\r\nc\r\n", "utf8");
    const res = await smartEditFile({ path: file, oldText: "b", newText: "b1\nb2" });
    expect(res.isError).toBe(false);
    expect(await readFile(file, "utf8")).toBe("a\r\nb1\r\nb2\r\nc\r\n");
    await rm(file, { force: true });
  });

  test("apply_patch matches LF oldText in a CRLF file", async () => {
    const file = join(tmpdir(), `crlf_patch_${Date.now()}.txt`);
    await writeFile(file, "x\r\ny\r\nz\r\n", "utf8");
    const res = await runBuiltin("apply_patch", { path: file, changes: [{ oldText: "x\ny", newText: "x\nnovo\ny" }] });
    expect(res.isError).toBe(false);
    expect(await readFile(file, "utf8")).toBe("x\r\nnovo\r\ny\r\nz\r\n");
    await rm(file, { force: true });
  });
});

describe("ask_question", () => {
  test("waits for the interactive answer when the TUI provides askUser", async () => {
    const res = await runBuiltin(
      "ask_question",
      { question: "Qual?", options: ["A", "B"] },
      { askUser: async (_q, opts) => opts![1] }
    );
    expect(res.isError).toBe(false);
    expect(res.result).toBe("Resposta do usuário: B");
  });

  test("tells the model to relay the question when there is no UI", async () => {
    const res = await runBuiltin("ask_question", { question: "Qual?" });
    expect(res.result).toContain("SEM INTERFACE INTERATIVA");
  });
});

describe("logo", () => {
  test("never wider than the terminal (wrapping breaks the block art)", () => {
    for (const cols of [200, 101, 100, 80, 60, 52, 51, 40, 20]) {
      const { art } = renderLogo(cols);
      const widest = Math.max(...art.split("\n").map((l) => [...l].length));
      expect(widest).toBeLessThan(cols);
    }
  });

  test("uses the full logo, then SILICON/FLOWER stacked, then plain text", () => {
    expect(renderLogo(120).art.split("\n").length).toBe(6);
    expect(renderLogo(80).art.split("\n").length).toBe(12);
    expect(renderLogo(30).art).toBe("SILICONFLOWER");
  });
});

describe("repo map and grep", () => {
  test("extracts Rust symbols and TS enums", () => {
    const rs = extractSymbols("pub fn run(x: i32) {}\npub struct Cfg {}\nenum Mode {}\n", ".rs");
    expect(rs.map((s) => s.name)).toEqual(["run", "Cfg", "Mode"]);
    const ts = extractSymbols("export enum Color { Red }\n", ".ts");
    expect(ts[0]).toMatchObject({ name: "Color", kind: "enum" });
  });

  test("maxFiles counts only files that contribute symbols", async () => {
    const dir = join(tmp, "repomap_max");
    await rm(dir, { recursive: true, force: true });
    await Bun.write(join(dir, "a_empty.ts"), "const x = 1;\n");
    await Bun.write(join(dir, "b_empty.ts"), "const y = 2;\n");
    await Bun.write(join(dir, "c_real.ts"), "export function real() {}\n");
    const res = await generateRepoMap(dir, { maxFiles: 1 });
    expect(res.fileCount).toBe(1);
    expect(res.mapText).toContain("real");
  });

  test("grep searches inside bin/ folders", async () => {
    const dir = join(tmp, "grep_bin");
    await Bun.write(join(dir, "bin", "tool.js"), "const marker = 'agulha';\n");
    const matches = await searchContent({ basePath: dir, pattern: "agulha" });
    expect(matches.length).toBe(1);
  });
});
