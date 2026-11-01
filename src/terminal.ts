/**
 * Terminal Screen and Viewport Manager for Siliconflower.
 *
 * Provides terminal clearing and cursor management in the primary screen buffer,
 * matching modern harnesses like Claude Code and Gemini CLI, which allows native
 * mouse-wheel scrolling throughout the chat and response history.
 */

export const ANSI_CLEAR_SCREEN = "\x1b[2J\x1b[3J\x1b[H";
export const ANSI_SHOW_CURSOR = "\x1b[?25h";
// DEC mode 2026 (synchronized output): the terminal holds the screen until the end marker,
// so a frame that is erased and rewritten is shown at once instead of flashing. Terminals
// without support ignore the unknown mode.
export const ANSI_SYNC_BEGIN = "\x1b[?2026h";
export const ANSI_SYNC_END = "\x1b[?2026l";

export interface TerminalOptions {
  force?: boolean;
  stream?: NodeJS.WriteStream;
}

let lifecycleRegistered = false;

/**
 * Clears the visible terminal viewport and homes the cursor,
 * while keeping the primary buffer active so mouse wheel scrolling works natively.
 */
export function clearScreen(options?: TerminalOptions): boolean {
  const stream = options?.stream ?? process.stdout;
  const isTty = Boolean(stream.isTTY || options?.force);

  if (!isTty) {
    return false;
  }

  stream.write(ANSI_CLEAR_SCREEN);
  registerLifecycleHooks(stream);
  return true;
}

/**
 * Ensures cursor visibility and terminal cleanup on exit.
 */
export function restoreTerminal(options?: TerminalOptions): boolean {
  const stream = options?.stream ?? process.stdout;
  const isTty = Boolean(stream.isTTY || options?.force);

  if (isTty) {
    stream.write(ANSI_SHOW_CURSOR);
    return true;
  }
  return false;
}

function registerLifecycleHooks(stream: NodeJS.WriteStream) {
  if (lifecycleRegistered) return;
  lifecycleRegistered = true;

  const restore = () => {
    restoreTerminal({ stream, force: true });
  };

  process.once("exit", restore);

  const handleSignal = () => {
    restore();
    process.exit(0);
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  if (process.platform === "win32") {
    process.once("SIGBREAK" as NodeJS.Signals, handleSignal);
  }
}

/**
 * Wraps every write to `stream` in synchronized-output markers, so each Ink frame (erase +
 * redraw, sent in a single write) is presented atomically. Returns a function that undoes
 * the wrapping. No-op when the stream is not a TTY or SILICONFLOWER_NO_SYNC_OUTPUT is set.
 */
export function enableSynchronizedOutput(options?: TerminalOptions): () => void {
  const stream = options?.stream ?? process.stdout;
  const isTty = Boolean(stream.isTTY || options?.force);
  if (!isTty || process.env.SILICONFLOWER_NO_SYNC_OUTPUT) return () => {};

  const original = stream.write;
  const wrapped = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) {
    if (typeof chunk === "string" && chunk.length > 0) {
      chunk = ANSI_SYNC_BEGIN + chunk + ANSI_SYNC_END;
    }
    return (original as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
  } as typeof stream.write;
  stream.write = wrapped;
  return () => {
    if (stream.write === wrapped) stream.write = original;
  };
}
