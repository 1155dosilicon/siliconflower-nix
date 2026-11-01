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
