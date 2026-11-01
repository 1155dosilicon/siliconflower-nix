import { statSync, readFileSync } from "node:fs";
import { dirname, join, resolve, parse } from "node:path";
import { homedir } from "node:os";

/**
 * Files that mark a folder as a project, in priority order. Creating one of them is what
 * activates project memory: folders without a marker (e.g. a scratch "ia" folder) start
 * clean every session and never accumulate project memories.
 */
export const PROJECT_MARKERS = ["SILICONFLOWER.md", "AGENTS.md"] as const;

/** Marker created by `siliconflower init`. */
export const DEFAULT_MARKER = PROJECT_MARKERS[0];

/** Project instructions larger than this are truncated in the system prompt. */
export const MAX_INSTRUCTIONS_CHARS = 20_000;

export interface ProjectInfo {
  /** Folder containing the marker: identifies the project, also from its subfolders. */
  root: string;
  /** Absolute path of the marker file that activated the project. */
  markerPath: string;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Walks up from `cwd` looking for a project marker. The user's home folder is never
 * considered: a stray ~/AGENTS.md would otherwise turn every folder under home into the
 * same "project".
 */
export function findProject(cwd: string = process.cwd()): ProjectInfo | null {
  const home = resolve(homedir()).toLowerCase();
  let dir = resolve(cwd);
  const { root } = parse(dir);
  while (true) {
    if (dir.toLowerCase() === home) return null;
    for (const marker of PROJECT_MARKERS) {
      const markerPath = join(dir, marker);
      if (isFile(markerPath)) return { root: dir, markerPath };
    }
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Folder that identifies the workspace: the project root when there is one, else `cwd`. */
export function resolveWorkspaceRoot(cwd: string = process.cwd()): string {
  return findProject(cwd)?.root ?? resolve(cwd);
}

/** Reads the marker file contents (the user's project instructions), bounded in size. */
export function readProjectInstructions(project: ProjectInfo): string {
  try {
    const raw = readFileSync(project.markerPath, "utf8").replace(/^﻿/, "").trim();
    if (raw.length <= MAX_INSTRUCTIONS_CHARS) return raw;
    return `${raw.slice(0, MAX_INSTRUCTIONS_CHARS)}\n\n... [instruções truncadas: arquivo com ${raw.length} caracteres; leia ${project.markerPath} se precisar do restante]`;
  } catch {
    return "";
  }
}

export const PROJECT_TEMPLATE = `# Instruções do projeto

<!--
Este arquivo ativa a memória de projeto do Siliconflower nesta pasta (e nas subpastas).
Tudo o que estiver aqui é enviado ao modelo em todas as mensagens: seja breve.
As memórias que o agente salva sozinho ficam em ~/.siliconflower/workspaces/, não aqui.
-->

## Sobre o projeto
- (o que é, objetivo, stack)

## Convenções
- (estilo de código, comandos de build/teste, o que evitar)
`;

/** Marker file present directly in `dir` (not in its ancestors), if any. */
export function markerIn(dir: string): string | undefined {
  for (const marker of PROJECT_MARKERS) {
    const p = join(dir, marker);
    if (isFile(p)) return p;
  }
  return undefined;
}
