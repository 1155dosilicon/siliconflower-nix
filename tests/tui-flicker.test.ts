import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import xterm from "@xterm/headless";
import { App } from "../src/App.js";
import { estimateRenderedRows, tailMarkdown } from "../src/LiveResponse.js";

// Ink clears the whole screen (and repaints everything) on every frame that is at least as
// tall as the terminal. With the chat history inside the live frame, that happened on every
// streamed token once a conversation got long: the TUI flickered while generating.
const CLEAR_TERMINAL = "\x1b[2J";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeLlm(lines: string[]) {
  const server = Bun.serve({
    port: 0,
    fetch() {
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
          for (const line of lines) {
            send({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: line + "\n" }, finish_reason: null }] });
            await sleep(5);
          }
          send({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return server;
}

describe("TUI streaming", () => {
  test("never repaints the whole screen while streaming a long answer", async () => {
    const answer = Array.from({ length: 80 }, (_, i) => `linha ${i + 1} da resposta`);
    const server = fakeLlm(answer);
    const cols = 100;
    const rows = 24;
    const term = new xterm.Terminal({ cols, rows, scrollback: 5000, convertEol: true, allowProposedApi: true });
    const writes: string[] = [];
    const stdout = Object.assign(new EventEmitter(), {
      columns: cols,
      rows,
      isTTY: true,
      write(data: string) {
        writes.push(data);
        term.write(data);
        return true;
      },
    });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    const config = { baseURL: `http://localhost:${server.port}/v1`, apiKey: "k", model: "m", reasoning: "none" as const, mcpServers: {} };
    const app = render(React.createElement(App, { config, overrides: {} }), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      await sleep(600);
      const before = writes.length;
      stdin.write("oi");
      await sleep(50);
      stdin.write("\r");
      for (let i = 0; i < 100 && !writes.slice(before).join("").includes("linha 80 da resposta"); i++) await sleep(50);
      await sleep(300);

      const during = writes.slice(before).join("");
      expect(during).toContain("linha 80 da resposta");
      expect(during.includes(CLEAR_TERMINAL)).toBe(false);

      // The finished answer is in the scrollback in full, exactly once.
      await new Promise<void>((resolve) => term.write("", resolve));
      const buffer = term.buffer.active;
      const all: string[] = [];
      for (let i = 0; i < buffer.length; i++) all.push(buffer.getLine(i)!.translateToString(true));
      expect(all.filter((l) => l.trim() === "linha 1 da resposta").length).toBe(1);
      expect(all.filter((l) => l.trim() === "linha 80 da resposta").length).toBe(1);
    } finally {
      app.unmount();
      server.stop(true);
    }
  }, 20000);
});

describe("LiveResponse helpers", () => {
  test("estimateRenderedRows counts wrapped lines and code block chrome", () => {
    expect(estimateRenderedRows("a\nb\nc", 80)).toBe(3);
    expect(estimateRenderedRows("x".repeat(200), 80)).toBeGreaterThanOrEqual(3);
    expect(estimateRenderedRows("```ts\nconst a = 1;\n```", 80)).toBe(7);
  });

  test("tailMarkdown keeps the end and reopens a cut code fence", () => {
    const text = ["intro", "```", "c1", "c2", "c3", "```", "fim"].join("\n");
    expect(tailMarkdown(text, 10)).toBe(text);
    expect(tailMarkdown(text, 3)).toBe(["c3", "```", "fim"].join("\n").replace(/^/, "```\n"));
    expect(tailMarkdown(text, 1)).toBe("fim");
  });
});
