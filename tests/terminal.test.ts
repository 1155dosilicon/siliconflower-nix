import { describe, expect, test, beforeEach } from "bun:test";
import {
  ANSI_CLEAR_SCREEN,
  ANSI_SHOW_CURSOR,
  ANSI_SYNC_BEGIN,
  ANSI_SYNC_END,
  enableSynchronizedOutput,
  clearScreen,
  restoreTerminal,
} from "../src/terminal.js";
import { Writable } from "node:stream";

describe("terminal screen manager", () => {
  let mockOutput: string[] = [];
  let mockStream: NodeJS.WriteStream;

  beforeEach(() => {
    mockOutput = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        mockOutput.push(chunk.toString());
        callback();
      },
    }) as unknown as NodeJS.WriteStream;
    (stream as any).isTTY = true;
    mockStream = stream;
  });

  test("clears screen and homes cursor on TTY", () => {
    const cleared = clearScreen({ stream: mockStream });
    expect(cleared).toBe(true);
    expect(mockOutput.join("")).toContain(ANSI_CLEAR_SCREEN);
  });

  test("restores cursor visibility on terminal restore", () => {
    const restored = restoreTerminal({ stream: mockStream });
    expect(restored).toBe(true);
    expect(mockOutput.join("")).toContain(ANSI_SHOW_CURSOR);
  });

  test("does not clear screen when isTTY is false and not forced", () => {
    (mockStream as any).isTTY = false;
    const cleared = clearScreen({ stream: mockStream });
    expect(cleared).toBe(false);
    expect(mockOutput.length).toBe(0);
  });

  test("forces clear screen when forced flag is true even if isTTY is false", () => {
    (mockStream as any).isTTY = false;
    const cleared = clearScreen({ stream: mockStream, force: true });
    expect(cleared).toBe(true);
    expect(mockOutput.join("")).toContain(ANSI_CLEAR_SCREEN);
  });
});

describe("enableSynchronizedOutput", () => {
  const fakeStream = (isTTY: boolean) => {
    const out: string[] = [];
    const stream = { isTTY, write(d: string) { out.push(d); return true; } } as unknown as NodeJS.WriteStream;
    return { stream, out };
  };

  test("wraps each write in DEC 2026 markers and can be undone", () => {
    const { stream, out } = fakeStream(true);
    const original = stream.write;
    const disable = enableSynchronizedOutput({ stream });
    stream.write("frame");
    disable();
    stream.write("plain");
    expect(out).toEqual([`${ANSI_SYNC_BEGIN}frame${ANSI_SYNC_END}`, "plain"]);
    expect(stream.write).toBe(original);
  });

  test("does nothing when the stream is not a TTY", () => {
    const { stream, out } = fakeStream(false);
    enableSynchronizedOutput({ stream })();
    stream.write("x");
    expect(out).toEqual(["x"]);
  });
});
