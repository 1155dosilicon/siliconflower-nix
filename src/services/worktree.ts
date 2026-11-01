import { execFile } from "child_process";
import { promisify } from "util";
import { join, resolve, dirname } from "path";
import { readFile, appendFile, mkdir } from "fs/promises";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string;
}

/**
 * Lists all active git worktrees for the current repository.
 */
export async function listWorktrees(cwd: string = process.cwd()): Promise<WorktreeInfo[]> {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd, windowsHide: true });
    const lines = stdout.split("\n");
    const worktrees: WorktreeInfo[] = [];

    let currentPath = "";
    let currentHead = "";
    let currentBranch = "";

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        currentPath = line.substring(9).trim();
      } else if (line.startsWith("HEAD ")) {
        currentHead = line.substring(5).trim();
      } else if (line.startsWith("branch ")) {
        currentBranch = line.substring(7).trim().replace("refs/heads/", "");
      } else if (line.trim() === "") {
        if (currentPath) {
          worktrees.push({ path: currentPath, head: currentHead, branch: currentBranch });
          currentPath = "";
          currentHead = "";
          currentBranch = "";
        }
      }
    }

    if (currentPath) {
      worktrees.push({ path: currentPath, head: currentHead, branch: currentBranch });
    }

    return worktrees;
  } catch (e) {
    return [];
  }
}

/**
 * Creates and enters a new git worktree for isolated work.
 */
export async function enterWorktree(
  branchName: string,
  cwd: string = process.cwd()
): Promise<{ result: string; isError: boolean; worktreePath?: string }> {
  const safeBranch = branchName.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!safeBranch || !/[a-zA-Z0-9]/.test(safeBranch)) {
    return { result: "Nome de branch inválido para criação do worktree.", isError: true };
  }
  try {
    // Anchor at the repository root so a call from a subdirectory doesn't nest .worktrees there.
    const { stdout: top } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, windowsHide: true });
    const repoRoot = resolve(top.trim());
    const targetDir = join(repoRoot, ".worktrees", safeBranch);
    await execFileAsync("git", ["worktree", "add", "-b", safeBranch, targetDir], { cwd: repoRoot, windowsHide: true });
    await excludeWorktreesDir(repoRoot);
    await log("info", `enterWorktree: ${targetDir}`);

    return {
      result: `Worktree criado em: ${targetDir} na branch: ${safeBranch}. O diretório de trabalho NÃO mudou: use esse caminho nas ferramentas de arquivo e no 'cwd' de execute_command.`,
      isError: false,
      worktreePath: targetDir,
    };
  } catch (e: any) {
    return {
      result: `Erro ao criar worktree: ${e.message || String(e)}`,
      isError: true,
    };
  }
}

/**
 * Removes an active git worktree.
 */
/**
 * Adds `.worktrees/` to the repository-local exclude file (.git/info/exclude), so the
 * nested worktrees never show up as untracked files. Unlike .gitignore this file is not
 * versioned, so the user's tracked files are left untouched. Best effort.
 */
async function excludeWorktreesDir(repoRoot: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repoRoot, windowsHide: true });
    const excludePath = resolve(repoRoot, stdout.trim());
    const current = await readFile(excludePath, "utf8").catch(() => "");
    if (current.split(/\r?\n/).some((line) => line.trim() === ".worktrees/" || line.trim() === "/.worktrees/")) return;
    await mkdir(dirname(excludePath), { recursive: true });
    await appendFile(excludePath, `${current && !current.endsWith("\n") ? "\n" : ""}/.worktrees/\n`, "utf8");
  } catch {
    // Not fatal: the worktree itself was created successfully.
  }
}

export async function exitWorktree(
  worktreePath: string,
  force: boolean = false,
  cwd: string = process.cwd(),
  deleteBranch: boolean = false
): Promise<{ result: string; isError: boolean }> {
  try {
    const requestedPath = resolve(cwd, worktreePath);
    const worktrees = await listWorktrees(cwd);
    const registered = worktrees.find((tree) => resolve(tree.path).toLowerCase() === requestedPath.toLowerCase());
    if (!registered) {
      return { result: `Worktree não registrado neste repositório: ${requestedPath}`, isError: true };
    }
    const args = ["worktree", "remove", requestedPath];
    if (force) args.push("--force");
    await execFileAsync("git", args, { cwd, windowsHide: true });
    await log("info", `exitWorktree: ${requestedPath}`);

    let branchNote = "";
    if (deleteBranch && registered.branch) {
      try {
        await execFileAsync("git", ["branch", force ? "-D" : "-d", registered.branch], { cwd, windowsHide: true });
        branchNote = ` Branch '${registered.branch}' apagada.`;
      } catch (e: any) {
        branchNote = ` A branch '${registered.branch}' foi mantida: ${e.message || String(e)}`;
      }
    }

    return {
      result: `Worktree ${requestedPath} removido com sucesso.${branchNote}`,
      isError: false,
    };
  } catch (e: any) {
    return {
      result: `Erro ao remover worktree: ${e.message || String(e)}`,
      isError: true,
    };
  }
}
