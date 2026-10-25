import { execFile, type ExecOptions } from "node:child_process";

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function isUnix(): boolean {
  return !isWindows();
}

/** Default shell used to run commands and hooks. */
export function getDefaultShell(): string {
  if (isWindows()) return "powershell.exe";
  return process.env.SHELL || "/bin/bash";
}

/** Human-readable shell label for prompts and tool descriptions. */
export function getShellLabel(): string {
  return isWindows() ? "PowerShell" : "o shell do sistema (bash/sh)";
}

/** OS label for the agent persona. */
export function getOsLabel(): string {
  if (isWindows()) return "Windows (PowerShell/Bun/Node)";
  return `Linux/Unix (${process.platform}, shell do usuário, Bun/Node)`;
}

/**
 * Kills a process and its children (best effort).
 * Windows uses taskkill /T; Unix signals the process group when possible.
 */
export function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (isWindows()) {
      execFile("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      return;
    }
    // Negative PID signals the process group (works when the child is a group leader).
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Best effort kill
  }
}

/** Platform-aware options for child_process.exec/execFile. */
export function shellExecOptions(extra?: ExecOptions): ExecOptions {
  return {
    encoding: "utf8",
    shell: getDefaultShell(),
    windowsHide: true,
    ...extra,
  };
}
