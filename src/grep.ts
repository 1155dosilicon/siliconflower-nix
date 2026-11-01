import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { globToRegex } from "./glob-util.js";
import { IGNORED_SOURCE_DIRS } from "./fs-util.js";

interface GrepOptions {
  basePath: string;
  pattern: string;
  includePattern?: string;
  maxMatches?: number;
}

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}


function matchesGlob(relPath: string, filename: string, pattern?: string): boolean {
  if (!pattern || pattern === "*") return true;
  const re = globToRegex(pattern);
  // Patterns without a path separator match the basename at any depth (like ripgrep --glob);
  // patterns with a separator (e.g. "src/**/*.tsx") match the full path relative to basePath.
  return pattern.includes("/") ? re.test(relPath) : re.test(filename);
}

export async function searchContent(opts: GrepOptions): Promise<GrepMatch[]> {
  const { basePath, pattern, includePattern, maxMatches = 200 } = opts;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped, "i");
  }
  const matches: GrepMatch[] = [];
  const root = resolve(basePath);

  async function walk(dir: string) {
    if (matches.length >= maxMatches) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= maxMatches) break;
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_SOURCE_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (includePattern) {
          const relPath = relative(root, fullPath).replace(/\\/g, "/");
          if (!matchesGlob(relPath, entry.name, includePattern)) continue;
        }

        // Avoid binary files / large files
        try {
          const st = await stat(fullPath);
          if (st.size > 2 * 1024 * 1024) continue; // Skip files > 2MB

          const content = await readFile(fullPath, "utf8");
          // NUL bytes in the first 8 KB: binary file, matches would be garbage.
          if (content.slice(0, 8192).includes("\0")) continue;
          const lines = content.split(/\r?\n/);

          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push({
                file: fullPath,
                line: i + 1,
                content: lines[i].trim().slice(0, 300),
              });
              if (matches.length >= maxMatches) break;
            }
          }
        } catch {
          // Ignore unreadable/binary files
        }
      }
    }
  }

  await walk(root);
  return matches;
}
