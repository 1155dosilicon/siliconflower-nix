import { readdir, readFile } from "fs/promises";
import { join, relative, extname, resolve, isAbsolute } from "path";
import { IGNORED_SOURCE_DIRS } from "../fs-util.js";

export interface SymbolInfo {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "enum" | "export" | "variable" | "route";
  line: number;
  signature: string;
}

export interface FileSymbolMap {
  filePath: string;
  relPath: string;
  symbols: SymbolInfo[];
}

// Only extensions that extractSymbols actually understands; anything else would occupy
// repo_map's maxFiles slots without producing symbols.
const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"]);

/**
 * Extracts symbols from source code text using language-aware regex patterns.
 */
export function extractSymbols(content: string, fileOrExt: string): SymbolInfo[] {
  const ext = fileOrExt.startsWith(".") ? fileOrExt.toLowerCase() : extname(fileOrExt).toLowerCase();
  const symbols: SymbolInfo[] = [];
  const lines = content.split("\n");

  lines.forEach((line, index) => {
    const lineNum = index + 1;
    const trimmed = line.trim();

    // Skip empty lines or pure comments
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      return;
    }

    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      // Exported functions, classes, interfaces, types
      const exportFunc = trimmed.match(/^export\s+(?:default\s+)?(async\s+)?function\s*\*?\s*([a-zA-Z0-9_$]+)\s*\(([^)]*)\)/);
      if (exportFunc) {
        symbols.push({ name: exportFunc[2], kind: "function", line: lineNum, signature: `export function ${exportFunc[2]}(${exportFunc[3]})` });
        return;
      }

      const exportClass = trimmed.match(/^export\s+(abstract\s+)?class\s+([a-zA-Z0-9_$]+)/);
      if (exportClass) {
        symbols.push({ name: exportClass[2], kind: "class", line: lineNum, signature: `export class ${exportClass[2]}` });
        return;
      }

      const exportInterface = trimmed.match(/^export\s+interface\s+([a-zA-Z0-9_$]+)/);
      if (exportInterface) {
        symbols.push({ name: exportInterface[1], kind: "interface", line: lineNum, signature: `export interface ${exportInterface[1]}` });
        return;
      }

      const exportType = trimmed.match(/^export\s+type\s+([a-zA-Z0-9_$]+)/);
      if (exportType) {
        symbols.push({ name: exportType[1], kind: "type", line: lineNum, signature: `export type ${exportType[1]}` });
        return;
      }

      const exportEnum = trimmed.match(/^export\s+(?:const\s+)?enum\s+([a-zA-Z0-9_$]+)/);
      if (exportEnum) {
        symbols.push({ name: exportEnum[1], kind: "enum", line: lineNum, signature: `export enum ${exportEnum[1]}` });
        return;
      }

      const exportConstFunc = trimmed.match(/^export\s+const\s+([a-zA-Z0-9_$]+)\s*(?::[^=]+)?=\s*(async\s*)?\(([^)]*)\)\s*(?::[^=]+)?=>/);
      if (exportConstFunc) {
        symbols.push({ name: exportConstFunc[1], kind: "function", line: lineNum, signature: `export const ${exportConstFunc[1]} = (${exportConstFunc[3]}) =>` });
        return;
      }

      // Non-exported top level functions and classes
      const plainFunc = trimmed.match(/^(async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)/);
      if (plainFunc) {
        symbols.push({ name: plainFunc[2], kind: "function", line: lineNum, signature: `function ${plainFunc[2]}(${plainFunc[3]})` });
        return;
      }

      const plainClass = trimmed.match(/^class\s+([a-zA-Z0-9_$]+)/);
      if (plainClass) {
        symbols.push({ name: plainClass[1], kind: "class", line: lineNum, signature: `class ${plainClass[1]}` });
        return;
      }
    } else if (ext === ".py") {
      const pyClass = trimmed.match(/^class\s+([a-zA-Z0-9_]+)\b/);
      if (pyClass) {
        symbols.push({ name: pyClass[1], kind: "class", line: lineNum, signature: `class ${pyClass[1]}` });
        return;
      }
      const pyDef = trimmed.match(/^(async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\):/);
      if (pyDef) {
        symbols.push({ name: pyDef[2], kind: "function", line: lineNum, signature: `def ${pyDef[2]}(${pyDef[3]})` });
        return;
      }
    } else if (ext === ".go") {
      const goFunc = trimmed.match(/^func\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
      if (goFunc) {
        symbols.push({ name: goFunc[1], kind: "function", line: lineNum, signature: `func ${goFunc[1]}(${goFunc[2]})` });
        return;
      }
      const goType = trimmed.match(/^type\s+([a-zA-Z0-9_]+)\s+(struct|interface)/);
      if (goType) {
        symbols.push({
          name: goType[1],
          kind: goType[2] === "struct" ? "class" : "interface",
          line: lineNum,
          signature: `type ${goType[1]} ${goType[2]}`,
        });
        return;
      }
    } else if (ext === ".rs") {
      const rsFn = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([a-zA-Z0-9_]+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/);
      if (rsFn) {
        symbols.push({ name: rsFn[1], kind: "function", line: lineNum, signature: `fn ${rsFn[1]}(${rsFn[2]})` });
        return;
      }
      const rsType = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait)\s+([a-zA-Z0-9_]+)/);
      if (rsType) {
        const kind = rsType[1] === "struct" ? "class" : rsType[1] === "enum" ? "enum" : "interface";
        symbols.push({ name: rsType[2], kind, line: lineNum, signature: `${rsType[1]} ${rsType[2]}` });
        return;
      }
    }
  });

  return symbols;
}

/**
 * Recursively scans directory for source files.
 */
async function scanDirectoryFiles(dir: string, baseDir: string, fileList: string[] = []): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_SOURCE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDirectoryFiles(fullPath, baseDir, fileList);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) {
          fileList.push(fullPath);
        }
      }
    }
  } catch (e) {
    // Ignore inaccessible dirs
  }
  return fileList;
}

/**
 * Generates a RepoMap summary of the project structure and key symbols.
 */
export async function generateRepoMap(
  rootDir: string = process.cwd(),
  options: { maxFiles?: number; focusPath?: string } = {}
): Promise<{ mapText: string; fileCount: number; symbolCount: number }> {
  const maxFilesRaw = Number(options.maxFiles);
  const maxFiles = Number.isFinite(maxFilesRaw) ? Math.min(500, Math.max(1, Math.floor(maxFilesRaw))) : 50;
  const resolvedRoot = resolve(rootDir);
  const targetDir = options.focusPath ? resolve(resolvedRoot, options.focusPath) : resolvedRoot;
  const focusRelative = relative(resolvedRoot, targetDir);
  if (focusRelative.startsWith("..") || isAbsolute(focusRelative)) {
    return { mapText: "Caminho de foco fora do repositório não é permitido.", fileCount: 0, symbolCount: 0 };
  }

  const files = await scanDirectoryFiles(targetDir, rootDir);

  const resultMap: FileSymbolMap[] = [];
  let totalSymbols = 0;

  // maxFiles counts files that actually contribute symbols, not files merely scanned.
  for (const filePath of files) {
    if (resultMap.length >= maxFiles) break;
    try {
      const content = await readFile(filePath, "utf8");
      const ext = extname(filePath).toLowerCase();
      const symbols = extractSymbols(content, ext);
      const relPath = relative(resolvedRoot, filePath).replace(/\\/g, "/");

      if (symbols.length > 0) {
        resultMap.push({ filePath, relPath, symbols });
        totalSymbols += symbols.length;
      }
    } catch (e) {
      // Ignore read errors
    }
  }

  // Format RepoMap text
  let mapText = `=== RepoMap: ${resultMap.length} arquivos, ${totalSymbols} símbolos ===\n\n`;

  for (const item of resultMap) {
    mapText += `📁 ${item.relPath}\n`;
    for (const sym of item.symbols) {
      mapText += `  ├─ [L${sym.line}] ${sym.signature}\n`;
    }
    mapText += `\n`;
  }

  return {
    mapText: mapText.trim(),
    fileCount: resultMap.length,
    symbolCount: totalSymbols,
  };
}

/**
 * Search for a specific symbol across the codebase.
 */
export async function findSymbolInRepo(
  symbolName: string,
  rootDir: string = process.cwd()
): Promise<FileSymbolMap[]> {
  const files = await scanDirectoryFiles(rootDir, rootDir);
  const matches: FileSymbolMap[] = [];

  const lowerTarget = symbolName.toLowerCase();

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, "utf8");
      const ext = extname(filePath).toLowerCase();
      const symbols = extractSymbols(content, ext);

      const matchedSymbols = symbols.filter((s) => s.name.toLowerCase().includes(lowerTarget));

      if (matchedSymbols.length > 0) {
        matches.push({
          filePath,
          relPath: relative(rootDir, filePath).replace(/\\/g, "/"),
          symbols: matchedSymbols,
        });
      }
    } catch (e) {
      // Ignore read errors
    }
  }

  return matches;
}
