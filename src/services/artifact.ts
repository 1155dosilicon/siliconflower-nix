import { join, resolve } from "node:path";
import { writeFile, readFile, readdir, rm, access } from "node:fs/promises";
import { ensureDir, getWorkspaceDataDir, getGlobalDataDir } from "../fs-util.js";
import { log } from "../logger.js";
import { resolveWorkspaceRoot } from "../project.js";

export type ArtifactType = "markdown" | "code" | "mermaid" | "html" | "json";

export interface ArtifactMetadata {
  id: string;
  title: string;
  type: ArtifactType;
  summary: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

const CONTENT_EXTS = new Set(["md", "html", "json", "txt"]);
// Metadata for every artifact type lives in a `<id>.meta` sidecar, so html/json/code
// artifacts keep their title/summary without altering the content file itself.
const META_EXT = "meta";

export function getArtifactsDir(cwd: string = process.cwd(), scope: "project" | "global" = "project"): string {
  if (scope === "project") {
    return join(getWorkspaceDataDir(cwd), "artifacts");
  }
  return join(getGlobalDataDir(), "artifacts");
}

export function getLegacyArtifactsDir(cwd: string = process.cwd()): string {
  return join(resolveWorkspaceRoot(cwd), ".siliconflower", "artifacts");
}

function toSafeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-]/g, "_").toLowerCase();
}

function splitName(file: string): { id: string; ext: string } {
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return { id: file.toLowerCase(), ext: "" };
  return { id: file.slice(0, dot).toLowerCase(), ext: file.slice(dot + 1).toLowerCase() };
}

/** Content files (not sidecars) in `dir` whose id matches. */
async function findContentFiles(dir: string, safeId: string): Promise<string[]> {
  const files = await readdir(dir);
  return files.filter((f) => {
    const { id, ext } = splitName(f);
    return id === safeId && CONTENT_EXTS.has(ext);
  });
}

function extensionFor(type: ArtifactType): string {
  if (type === "markdown" || type === "mermaid") return "md";
  if (type === "html") return "html";
  if (type === "json") return "json";
  return "txt";
}

function readFrontmatterField(raw: string, field: string): string | undefined {
  // Values are written with JSON.stringify, so escaped quotes round-trip correctly.
  const m = new RegExp(`^${field}:\\s*("(?:[^"\\\\]|\\\\.)*")`, "m").exec(raw);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return m[1].slice(1, -1);
  }
}

export async function createArtifact(opts: {
  id: string;
  title: string;
  type: ArtifactType;
  content: string;
  summary: string;
  scope?: "project" | "global";
  cwd?: string;
}): Promise<{ artifact: ArtifactMetadata; message: string }> {
  const scope = opts.scope || "project";
  const dir = getArtifactsDir(opts.cwd, scope);
  await ensureDir(dir);

  const safeId = toSafeId(opts.id);
  const ext = extensionFor(opts.type);
  const fileName = `${safeId}.${ext}`;
  const filePath = join(dir, fileName);
  const metaPath = join(dir, `${safeId}.${META_EXT}`);

  const now = new Date().toISOString();
  let createdAt = now;
  try {
    const previous = JSON.parse(await readFile(metaPath, "utf8"));
    if (typeof previous.createdAt === "string") createdAt = previous.createdAt;
  } catch {
    // New artifact (or legacy one without sidecar).
  }

  // Updating an artifact with a different type changes its extension; remove the stale
  // file so the id resolves to a single artifact.
  for (const stale of await findContentFiles(dir, safeId)) {
    if (stale !== fileName) await rm(join(dir, stale), { force: true });
  }

  // Markdown artifacts keep a readable frontmatter header (values JSON-escaped).
  const header = `---
title: ${JSON.stringify(opts.title)}
type: ${JSON.stringify(opts.type)}
summary: ${JSON.stringify(opts.summary)}
updatedAt: ${JSON.stringify(now)}
---

`;

  const fullContent = ext === "md" ? header + opts.content : opts.content;
  await writeFile(filePath, fullContent, "utf8");

  const meta: ArtifactMetadata = {
    id: safeId,
    title: opts.title,
    type: opts.type,
    summary: opts.summary,
    path: filePath,
    createdAt,
    updatedAt: now,
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");

  await log("ok", `[Artefato criado] ID: ${safeId} (${opts.title})`);
  return { artifact: meta, message: `Artefato '${safeId}' salvo com sucesso em: ${filePath}` };
}

async function candidateDirs(cwd: string, scope: "project" | "global" | "all"): Promise<string[]> {
  const dirs: string[] = [];
  if (scope === "project" || scope === "all") {
    dirs.push(getArtifactsDir(cwd, "project"));
    const legacyDir = getLegacyArtifactsDir(cwd);
    try {
      await access(legacyDir);
      dirs.push(legacyDir);
    } catch {}
  }
  if (scope === "global" || scope === "all") dirs.push(getArtifactsDir(cwd, "global"));
  return Array.from(new Set(dirs.map((d) => resolve(d))));
}

async function readMetadata(dir: string, file: string): Promise<ArtifactMetadata> {
  const { id, ext } = splitName(file);
  const filePath = join(dir, file);
  try {
    const meta = JSON.parse(await readFile(join(dir, `${id}.${META_EXT}`), "utf8")) as ArtifactMetadata;
    return { ...meta, id, path: filePath };
  } catch {
    // Legacy artifact without sidecar: fall back to frontmatter / extension.
  }
  const raw = await readFile(filePath, "utf8");
  let type: ArtifactType = "markdown";
  if (ext === "json") type = "json";
  else if (ext === "html") type = "html";
  else if (ext === "txt") type = "code";
  else type = (readFrontmatterField(raw, "type") as ArtifactType) ?? "markdown";
  const updatedAt = readFrontmatterField(raw, "updatedAt") ?? "";
  return {
    id,
    title: readFrontmatterField(raw, "title") ?? id,
    type,
    summary: readFrontmatterField(raw, "summary") ?? "Artefato do Siliconflower",
    path: filePath,
    createdAt: updatedAt,
    updatedAt,
  };
}

export async function listArtifacts(cwd: string = process.cwd()): Promise<ArtifactMetadata[]> {
  const results: ArtifactMetadata[] = [];
  const seenIds = new Set<string>();

  for (const dir of await candidateDirs(cwd, "all")) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue; // Directory doesn't exist yet
    }
    for (const f of files) {
      const { id, ext } = splitName(f);
      if (!CONTENT_EXTS.has(ext) || seenIds.has(id)) continue;
      try {
        results.push(await readMetadata(dir, f));
        seenIds.add(id);
      } catch {
        // Ignore unreadable artifact files
      }
    }
  }

  return results;
}

export async function readArtifact(id: string, cwd: string = process.cwd()): Promise<{ content: string; path: string } | null> {
  const safeId = toSafeId(id);
  for (const dir of await candidateDirs(cwd, "all")) {
    try {
      const [match] = await findContentFiles(dir, safeId);
      if (match) {
        const filePath = join(dir, match);
        const content = await readFile(filePath, "utf8");
        return { content, path: filePath };
      }
    } catch {
      // Skip missing dir
    }
  }

  return null;
}

export async function deleteArtifact(
  id: string,
  cwd: string = process.cwd(),
  scope: "project" | "global" | "all" = "project"
): Promise<{ success: boolean; message: string }> {
  const safeId = toSafeId(id);
  let deleted = false;

  for (const dir of await candidateDirs(cwd, scope)) {
    try {
      for (const match of await findContentFiles(dir, safeId)) {
        await rm(join(dir, match));
        deleted = true;
      }
      await rm(join(dir, `${safeId}.${META_EXT}`), { force: true });
    } catch {
      // Skip missing dir
    }
  }

  if (deleted) {
    return { success: true, message: `Artefato '${safeId}' removido com sucesso do escopo [${scope}].` };
  }

  return { success: false, message: `Artefato '${id}' não foi encontrado.` };
}
