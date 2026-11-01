import { readFile, writeFile } from "fs/promises";
import { log } from "../logger.js";

export interface EditOptions {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface EditResult {
  result: string;
  isError: boolean;
  matchType?: "exact" | "normalized_newlines" | "fuzzy_whitespace";
}

/**
 * Normalizes line endings to \n for consistent comparisons.
 */
function normalizeNewlines(str: string): string {
  return str.replace(/\r\n/g, "\n");
}

/**
 * Normalizes indentation and whitespace per line for fuzzy matching.
 */
function normalizeLineWhitespace(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/**
 * Smart file edit function that handles exact, newline-normalized, and fuzzy whitespace matches.
 */
export async function smartEditFile(options: EditOptions): Promise<EditResult> {
  const { path, oldText, newText, replaceAll = false } = options;

  if (!oldText) {
    return { result: "oldText não pode ser vazio", isError: true };
  }

  try {
    const originalRaw = await readFile(path, "utf8");
    const useCRLF = originalRaw.includes("\r\n");

    // Strategy 1: Exact match
    if (originalRaw.includes(oldText)) {
      // Keep the file's line-ending style: a single-line oldText can match exactly in a
      // CRLF file while newText arrives with bare LF, which would mix line endings.
      const replacement = useCRLF ? normalizeNewlines(newText).replace(/\n/g, "\r\n") : newText;
      let updated: string;
      if (replaceAll) {
        updated = originalRaw.split(oldText).join(replacement);
      } else {
        const idx = originalRaw.indexOf(oldText);
        updated = originalRaw.slice(0, idx) + replacement + originalRaw.slice(idx + oldText.length);
      }
      if (updated === originalRaw) {
        return { result: `Nenhuma alteração em ${path}`, isError: false };
      }
      await writeFile(path, updated, "utf8");
      await log("info", `smartEditFile (exact): ${path}`);
      return { result: `Editado (correspondência exata): ${path}`, isError: false, matchType: "exact" };
    }

    // Strategy 2: Normalized Newlines (\r\n vs \n)
    const normOriginal = normalizeNewlines(originalRaw);
    const normOld = normalizeNewlines(oldText);
    const normNew = normalizeNewlines(newText);

    if (normOriginal.includes(normOld)) {
      let updatedNorm: string;
      if (replaceAll) {
        updatedNorm = normOriginal.split(normOld).join(normNew);
      } else {
        const idx = normOriginal.indexOf(normOld);
        updatedNorm = normOriginal.slice(0, idx) + normNew + normOriginal.slice(idx + normOld.length);
      }
      // Re-apply CRLF if original used CRLF
      const finalContent = useCRLF ? updatedNorm.replace(/\r?\n/g, "\r\n") : updatedNorm;
      await writeFile(path, finalContent, "utf8");
      await log("info", `smartEditFile (normalized_newlines): ${path}`);
      return {
        result: `Editado (correspondência de quebras de linha ajustadas): ${path}`,
        isError: false,
        matchType: "normalized_newlines",
      };
    }

    // Strategy 3: Fuzzy Line-by-Line Whitespace Matching
    const origLines = normOriginal.split("\n");
    const oldLines = normOld.split("\n");

    if (oldLines.length > 0) {
      const targetLength = oldLines.length;
      const normOldLines = oldLines.map(normalizeLineWhitespace);

      const foundIndexes: number[] = [];
      for (let i = 0; i <= origLines.length - targetLength; i++) {
        let match = true;
        for (let j = 0; j < targetLength; j++) {
          if (normalizeLineWhitespace(origLines[i + j]) !== normOldLines[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          foundIndexes.push(i);
          if (!replaceAll) break;
          i += targetLength - 1; // skip past this block so matches don't overlap
        }
      }

      if (foundIndexes.length > 1 && !replaceAll) {
        return {
          result: `oldText corresponde a ${foundIndexes.length} trechos diferentes em ${path} (linhas: ${foundIndexes
            .map((i) => i + 1)
            .join(", ")}) apenas com espaçamento flexível — ambíguo. Forneça mais contexto em oldText para identificar um único trecho, ou use replaceAll: true se a intenção é editar todas as ocorrências.`,
          isError: true,
        };
      }

      if (foundIndexes.length > 0) {
        const newLines = normNew.split("\n");
        const updatedLines: string[] = [];
        let cursor = 0;
        for (const idx of foundIndexes) {
          updatedLines.push(...origLines.slice(cursor, idx));
          updatedLines.push(...newLines);
          cursor = idx + targetLength;
        }
        updatedLines.push(...origLines.slice(cursor));
        let finalContent = updatedLines.join("\n");
        if (useCRLF) finalContent = finalContent.replace(/\r?\n/g, "\r\n");

        await writeFile(path, finalContent, "utf8");
        await log("info", `smartEditFile (fuzzy_whitespace): ${path}`);
        return {
          result:
            foundIndexes.length > 1
              ? `Editado (correspondência flexível de espaçamento, ${foundIndexes.length} ocorrências): ${path}`
              : `Editado (correspondência flexível de espaçamento): ${path}`,
          isError: false,
          matchType: "fuzzy_whitespace",
        };
      }
    }

    // Diagnostics if not found
    const firstLineOld = oldLines[0] ? normalizeLineWhitespace(oldLines[0]) : "";
    const candidateLines = origLines
      .map((line, idx) => ({ line: normalizeLineWhitespace(line), index: idx + 1 }))
      .filter((item) => item.line.length > 3 && (item.line.includes(firstLineOld) || firstLineOld.includes(item.line)))
      .slice(0, 3);

    let diagMsg = `oldText não encontrado em ${path}.`;
    if (candidateLines.length > 0) {
      diagMsg += ` Linhas semelhantes encontradas próximas às linhas: ${candidateLines.map((c) => c.index).join(", ")}.`;
    }

    return { result: diagMsg, isError: true };
  } catch (e) {
    return { result: `Erro ao editar ${path}: ${String(e)}`, isError: true };
  }
}
