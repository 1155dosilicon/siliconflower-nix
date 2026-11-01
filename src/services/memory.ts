import { readFile, writeFile, unlink, readdir, access } from "fs/promises";
import { join, resolve, basename } from "path";
import { ensureDir, getWorkspaceDataDir, getGlobalDataDir } from "../fs-util.js";
import { findProject, readProjectInstructions, PROJECT_MARKERS, DEFAULT_MARKER, type ProjectInfo } from "../project.js";

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "project" | "global";

export interface MemoryEntry {
  name: string;
  type: MemoryType;
  description: string;
  scope: MemoryScope;
  content: string;
  updatedAt: string;
}

/** The system prompt carries only an index of memories; bounded so it stays cheap. */
const MAX_INDEX_ENTRIES = 60;
const MAX_INDEX_CHARS = 6_000;

export function getGlobalMemoryDir(): string {
  return join(getGlobalDataDir(), "memory");
}

export function getProjectMemoryDir(cwd: string = process.cwd()): string {
  return join(getWorkspaceDataDir(cwd), "memory");
}

export function getLegacyProjectMemoryDir(cwd: string = process.cwd()): string {
  return join(findProject(cwd)?.root ?? cwd, ".siliconflower", "memory");
}

/** Message returned when project memory is used in a folder that is not a project. */
export function noProjectMessage(cwd: string): string {
  return (
    `Memória de projeto desativada: "${cwd}" não é um projeto (nenhum ${PROJECT_MARKERS.join(" ou ")} ` +
    `nesta pasta ou acima). Use scope "global" para algo que valha em qualquer pasta, ou peça ao usuário ` +
    `para criar ${DEFAULT_MARKER} na raiz do projeto (comando: siliconflower init).`
  );
}

function fileNameFor(name: string): string {
  return `${name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()}.md`;
}

/** Frontmatter values must stay on one line, otherwise the file can't be parsed back. */
function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, " ").trim();
}

/**
 * Saves or updates a persistent memory entry.
 * Project memories go to ~/.siliconflower/workspaces/<workspace-id>/memory/ and require an
 * active project (marker file); global memories go to ~/.siliconflower/memory/.
 */
export async function saveMemory(
  entry: Omit<MemoryEntry, "updatedAt">,
  cwd: string = process.cwd()
): Promise<{ message: string; path: string }> {
  if (entry.scope !== "global" && !findProject(cwd)) {
    throw new Error(noProjectMessage(cwd));
  }
  const dir = entry.scope === "global" ? getGlobalMemoryDir() : getProjectMemoryDir(cwd);
  await ensureDir(dir);

  const filePath = join(dir, fileNameFor(entry.name));
  const now = new Date().toISOString().split("T")[0];

  const fileContent = `---
name: ${oneLine(entry.name)}
type: ${oneLine(entry.type)}
scope: ${entry.scope}
description: ${oneLine(entry.description)}
updatedAt: ${now}
---

${entry.content.trim()}
`;

  await writeFile(filePath, fileContent, "utf8");
  await updateMemoryIndex(dir);

  return {
    message: `Memória '${entry.name}' salva com sucesso em escopo [${entry.scope}].`,
    path: filePath,
  };
}

/**
 * Updates the MEMORY.md index file in the given memory directory.
 */
async function updateMemoryIndex(dir: string): Promise<void> {
  try {
    const files = await readdir(dir);
    const mdFiles = files.filter((f) => f.endsWith(".md") && f !== "MEMORY.md");

    let indexContent = `# Memórias Ativas\n\n`;
    for (const file of mdFiles) {
      const parsed = parseMemoryFile(await readFile(join(dir, file), "utf8"), file);
      indexContent += `- [${parsed.name}](${file}) [${parsed.type}] — ${parsed.description || "Sem descrição"}\n`;
    }

    await writeFile(join(dir, "MEMORY.md"), indexContent, "utf8");
  } catch {
    // Ignore index update error
  }
}

function parseMemoryFile(raw: string, file: string): Omit<MemoryEntry, "scope"> {
  // Only the leading frontmatter block holds metadata; body lines like "name: x" must not match.
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const header = fm ? fm[1] : "";
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(header)?.[1].trim();
  return {
    name: field("name") ?? file.replace(/\.md$/, ""),
    type: (field("type") ?? "feedback") as MemoryType,
    description: field("description") ?? "",
    content: (fm ? raw.slice(fm[0].length) : raw).trim(),
    updatedAt: field("updatedAt") ?? "",
  };
}

/**
 * Recalls memories (full content) matching an optional query. Project memories are only
 * included inside an active project; global memories are always included.
 */
export async function recallMemories(
  query?: string,
  cwd: string = process.cwd()
): Promise<MemoryEntry[]> {
  const memories: MemoryEntry[] = [];
  const seenNames = new Set<string>();

  const candidateDirs: { dir: string; scope: MemoryScope }[] = [{ dir: getGlobalMemoryDir(), scope: "global" }];

  if (findProject(cwd)) {
    const projectDir = getProjectMemoryDir(cwd);
    const legacyDir = getLegacyProjectMemoryDir(cwd);
    candidateDirs.push({ dir: projectDir, scope: "project" });
    try {
      await access(legacyDir);
      if (resolve(legacyDir) !== resolve(projectDir)) candidateDirs.push({ dir: legacyDir, scope: "project" });
    } catch {}
  }

  const q = query?.toLowerCase();
  for (const { dir, scope } of candidateDirs) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue; // Memory dir doesn't exist yet (reads never create it)
    }
    for (const file of files.filter((f) => f.endsWith(".md") && f !== "MEMORY.md")) {
      let raw: string;
      try {
        raw = await readFile(join(dir, file), "utf8");
      } catch {
        continue; // One unreadable file must not hide the rest of the directory
      }
      const parsed = parseMemoryFile(raw, file);

      // Avoid duplicates across legacy and new workspace directories
      const key = `${scope}:${parsed.name.toLowerCase()}`;
      if (seenNames.has(key)) continue;
      seenNames.add(key);

      const entry: MemoryEntry = { ...parsed, scope };
      if (
        !q ||
        entry.name.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q) ||
        entry.content.toLowerCase().includes(q)
      ) {
        memories.push(entry);
      }
    }
  }

  return memories;
}

/**
 * Forgets (deletes) a specific memory.
 */
export async function forgetMemory(
  name: string,
  cwd: string = process.cwd(),
  scope: MemoryScope | "all" = "project"
): Promise<{ message: string; isError: boolean }> {
  const fileName = fileNameFor(name);
  const inProject = Boolean(findProject(cwd));

  if (scope === "project" && !inProject) {
    return { message: noProjectMessage(cwd), isError: true };
  }

  let deleted = false;

  if ((scope === "project" || scope === "all") && inProject) {
    for (const dir of [getProjectMemoryDir(cwd), getLegacyProjectMemoryDir(cwd)]) {
      try {
        await unlink(join(dir, fileName));
        await updateMemoryIndex(dir);
        deleted = true;
      } catch {}
    }
  }

  if (scope === "global" || scope === "all") {
    try {
      await unlink(join(getGlobalMemoryDir(), fileName));
      await updateMemoryIndex(getGlobalMemoryDir());
      deleted = true;
    } catch {}
  }

  if (deleted) {
    return { message: `Memória '${name}' removida com sucesso do escopo [${scope}].`, isError: false };
  }
  return { message: `Memória '${name}' não encontrada.`, isError: true };
}

function projectSection(project: ProjectInfo | null, cwd: string): string {
  if (!project) {
    return (
      `## Projeto\nNenhum projeto ativo em ${cwd.replace(/\\/g, "/")} (sem ${PROJECT_MARKERS.join(" ou ")}). ` +
      `Memórias de projeto estão desativadas aqui: não tente salvá-las. Use memória "global" só para ` +
      `preferências que valham em qualquer pasta.`
    );
  }
  const instructions = readProjectInstructions(project);
  const where = `${project.root.replace(/\\/g, "/")} (${basename(project.markerPath)})`;
  return instructions
    ? `## Instruções do projeto — ${where}\n${instructions}`
    : `## Projeto ativo — ${where}\n(arquivo de instruções vazio)`;
}

/**
 * Builds the system prompt segment: the project instructions (marker file contents) plus
 * an *index* of saved memories (name/type/description only). Full memory contents are
 * loaded on demand with `recall_memory`, so old memories don't cost tokens every message.
 */
export async function buildMemorySystemPrompt(cwd: string = process.cwd()): Promise<string> {
  const project = findProject(cwd);
  const memories = await recallMemories(undefined, cwd);

  const parts = [`# Contexto Persistente`, projectSection(project, cwd)];

  if (memories.length > 0) {
    const lines: string[] = [];
    let size = 0;
    for (const m of memories) {
      const line = `- ${m.name} [${m.type}, ${m.scope}]${m.description ? ` — ${m.description}` : ""}`;
      if (lines.length >= MAX_INDEX_ENTRIES || size + line.length > MAX_INDEX_CHARS) break;
      lines.push(line);
      size += line.length + 1;
    }
    const omitted = memories.length - lines.length;
    parts.push(
      `## Memórias salvas (índice)\n` +
        `Só nome e descrição. Quando uma delas for relevante para a tarefa atual, leia o conteúdo com ` +
        `"recall_memory" (query = nome) antes de agir. Ignore as que não tiverem relação com o pedido.\n` +
        lines.join("\n") +
        (omitted > 0 ? `\n... (+${omitted} memórias não listadas; use recall_memory com um termo de busca)` : "")
    );
  }

  return parts.join("\n\n");
}
