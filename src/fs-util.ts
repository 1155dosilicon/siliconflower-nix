import { mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

/**
 * Returns the global siliconflower data and configuration directory (~/.siliconflower).
 */
export function getGlobalDataDir(): string {
  const override = process.env.SILICONFLOWER_DATA_DIR?.trim();
  return override ? resolve(override) : join(homedir(), ".siliconflower");
}

/**
 * Generates a unique, deterministic, filesystem-safe workspace ID for a given directory path.
 * Format: `<sanitized-folder-name>-<sha256-short-hash>` (e.g., `my-project-8f3a1b2c`)
 *
 * Path case is preserved on Unix (case-sensitive FS) and folded on Windows
 * (case-insensitive FS) so two distinct Unix dirs never collide.
 */
export function getWorkspaceId(cwd: string = process.cwd()): string {
  const resolved = resolve(cwd).replace(/\\/g, "/");
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const folderName = basename(normalized).replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase() || "workspace";
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `${folderName}-${hash}`;
}

/**
 * Returns the centralized, isolated data directory for a specific project/workspace.
 * Located at: `~/.siliconflower/workspaces/<workspace-id>/`
 * This ensures the user's project/repository remains completely clean without polluting it with `.siliconflower` folders.
 */
export function getWorkspaceDataDir(cwd: string = process.cwd()): string {
  return join(getGlobalDataDir(), "workspaces", getWorkspaceId(cwd));
}

/**
 * Applies the Windows 'Hidden' (+h) attribute to a target path.
 * Fails silently if the path does not exist or attrib command fails.
 */
export async function hidePathOnWindows(targetPath: string): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    await execFileAsync("attrib.exe", ["+h", resolve(targetPath)], { windowsHide: true });
  } catch {
    // Ignore errors (e.g., command unavailable or non-Windows)
  }
}

/**
 * Creates a directory recursively (like `mkdir -p`).
 * If the path involves a `.siliconflower` directory, automatically applies
 * the Windows hidden attribute (`attrib +h`) to the `.siliconflower` folder so it remains
 * hidden in Windows File Explorer.
 */
export async function ensureDir(dirPath: string): Promise<string | undefined> {
  const result = await mkdir(dirPath, { recursive: true });

  if (dirPath.includes(".siliconflower")) {
    const parts = dirPath.split(/[/\\]/);
    const idx = parts.findIndex((p) => p === ".siliconflower");
    if (idx !== -1) {
      const siliconflowerPath = parts.slice(0, idx + 1).join("\\");
      await hidePathOnWindows(siliconflowerPath);
    }
  }

  return result;
}
