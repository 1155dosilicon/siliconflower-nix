import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import xterm from "@xterm/headless";
import { App } from "../src/App.js";

// Renders the real TUI into a headless terminal emulator. xterm.js reflows wrapped lines
// on resize like Windows Terminal does, which is what used to leave fragments of old
// frames (stacked logos, duplicated status lines) on screen.
function mountInTerminal(cols: number, rows: number) {
  const term = new xterm.Terminal({ cols, rows, scrollback: 1000, convertEol: true, allowProposedApi: true });
  const stdout = Object.assign(new EventEmitter(), {
    columns: cols,
    rows,
    isTTY: true,
    write(data: string) {
      term.write(data);
      return true;
    },
  });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const config = { baseURL: "http://localhost:1/v1", apiKey: "k", model: "teste", reasoning: "none" as const, mcpServers: {} };
  const app = render(React.createElement(App, { config, overrides: {} }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  const flush = () => new Promise<void>((resolve) => term.write("", resolve));
  const resize = (c: number) => {
    term.resize(c, rows);
    stdout.columns = c;
    stdout.emit("resize");
  };
  const screen = () => {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)!.translateToString(true));
    return lines;
  };
  return { app, flush, resize, screen };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SILICON_ROW = "███████╗██╗██╗"; // first row of the logo, in every block variant

describe("TUI resize", () => {
  test("repaints a single clean frame after repeated resizes", async () => {
    const t = mountInTerminal(120, 45);
    try {
      await sleep(600);
      for (const c of [70, 120, 45, 100, 60, 130, 80, 140]) {
        t.resize(c);
        await sleep(20);
      }
      await sleep(400); // resize settle + repaint
      await t.flush();

      const lines = t.screen();
      const logoRows = lines.filter((l) => l.startsWith(SILICON_ROW));
      expect(logoRows.length).toBe(1);
      expect(logoRows[0].length).toBeGreaterThan(90); // full one-line logo at 140 columns
      expect(lines.filter((l) => l.startsWith("> ")).length).toBe(1); // a single input prompt
    } finally {
      t.app.unmount();
    }
  }, 15000);

  test("settles on the stacked logo in a narrow window", async () => {
    const t = mountInTerminal(120, 45);
    try {
      await sleep(600);
      t.resize(56);
      await sleep(400);
      await t.flush();
      const lines = t.screen();
      expect(lines.filter((l) => l.startsWith(SILICON_ROW)).length).toBe(1);
      expect(lines.filter((l) => l.startsWith("███████╗██╗      ██████╗")).length).toBe(1); // FLOWER
      expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(56);
    } finally {
      t.app.unmount();
    }
  }, 15000);
});
