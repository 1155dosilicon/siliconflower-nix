import { readFile, writeFile, readdir, stat, rename, rm, access, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, isAbsolute, dirname, basename, parse, relative } from "node:path";
import { homedir } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ensureDir } from "./fs-util.js";
import { search } from "./glob-util.js";
import { searchContent } from "./grep.js";
import { setTodos } from "./todo.js";
import { runSubagentTask, sendSubagentMessage } from "./services/subagent.js";
import { startBackgroundCommand, listBackgroundTasks, getBackgroundTask, killBackgroundTask } from "./services/background-tasks.js";
import { createArtifact, readArtifact, listArtifacts, deleteArtifact } from "./services/artifact.js";
import { webFetch, webSearch } from "./services/web.js";
import { smartEditFile } from "./services/smart-edit.js";
import { generateRepoMap, findSymbolInRepo } from "./services/repomap.js";
import { saveMemory, recallMemories, forgetMemory } from "./services/memory.js";
import { enterWorktree, exitWorktree, listWorktrees } from "./services/worktree.js";
import { runHook, loadHooksConfig } from "./core/hooks.js";
import { processToolOutput } from "./context.js";
import { tailLogs } from "./logger.js";
import { getShellLabel, shellExecOptions, isWindows } from "./platform.js";
import type { AppConfig, McpTool, Mode, TodoItem } from "./types.js";
import { log } from "./logger.js";

const execAsync = promisify(exec);
const CANCELLABLE_BUILTINS = new Set(["execute_command", "run_task", "send_subagent_message", "web_fetch"]);

export interface ToolContext {
  config?: AppConfig;
  mode?: Mode;
  signal?: AbortSignal;
}

export interface BuiltinTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  destructive?: boolean;
  run: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<{ result: string; isError: boolean }>;
}

function toAbs(p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(process.cwd(), p);
}

const BLOCKED_PATHS = [
  "c:\\windows\\system32",
  "c:\\windows\\syswow64",
  "/etc",
  "/root",
  "/boot",
];

function isPathBlocked(p: string): boolean {
  const normalized = p.toLowerCase().replace(/\\/g, "/");
  for (const blocked of BLOCKED_PATHS) {
    const normalizedBlocked = blocked.toLowerCase().replace(/\\/g, "/").replace(/\/$/, "");
    if (normalized === normalizedBlocked || normalized.startsWith(`${normalizedBlocked}/`)) return true;
  }
  if (normalized.includes("/.ssh/") || normalized.endsWith("/.ssh")) return true;
  if (normalized.includes("/.aws/") || normalized.endsWith("/.aws")) return true;
  return false;
}

async function isPathBlockedSafe(p: string): Promise<boolean> {
  if (isPathBlocked(p)) return true;
  try {
    return isPathBlocked(await realpath(p));
  } catch {
    try {
      const parent = await realpath(dirname(p));
      return isPathBlocked(resolve(parent, basename(p)));
    } catch {
      return false;
    }
  }
}

function isDangerousDeleteTarget(path: string): boolean {
  const target = resolve(path);
  const root = parse(target).root;
  if (target.toLowerCase() === root.toLowerCase()) return true;
  const protectedDirs = [resolve(homedir()), resolve(process.cwd())];
  return protectedDirs.some((protectedDir) => {
    const rel = relative(target, protectedDir);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

async function readLineRange(path: string, offset: number, limit: number): Promise<string> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  let lineNumber = 0;
  try {
    for await (const line of reader) {
      lineNumber++;
      if (lineNumber < offset) continue;
      lines.push(`${lineNumber}: ${line}`);
      if (lines.length >= limit) break;
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return lines.join("\n");
}

export const BUILTIN_TOOLS: BuiltinTool[] = [
  {
    name: "read_file",
    description:
      "Lê o conteúdo de um arquivo de texto. Suporta os parâmetros opcionais 'offset' (linha inicial, base 1) e 'limit' (máximo de linhas a ler, padrão 2000). Retorna as linhas numeradas.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Caminho do arquivo" },
        offset: { type: "number", description: "Linha inicial (base 1)" },
        limit: { type: "number", description: "Quantidade máxima de linhas" },
      },
      required: ["path"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      if (await isPathBlockedSafe(path)) return { result: `Acesso bloqueado: ${path}`, isError: true };
      try {
        const rawOffset = Number(a.offset);
        const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 1;
        const rawLimit = Number(a.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 10000) : 2000;
        const formatted = await readLineRange(path, offset, limit);
        const processed = await processToolOutput(formatted);
        return { result: processed, isError: false };
      } catch (e) {
        return { result: `Erro ao ler ${path}: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "grep_content",
    description:
      "Busca por conteúdo textual/regex dentro de arquivos de um diretório recursivamente. Retorna arquivo, número da linha e conteúdo da linha correspondente.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Diretório base (padrão: diretório atual)" },
        pattern: { type: "string", description: "Padrão de busca (texto ou regex)" },
        include: { type: "string", description: "Filtro de arquivos por extensão/glob (ex: '*.ts' ou 'src/**/*.tsx')" },
      },
      required: ["pattern"],
    },
    run: async (a) => {
      const basePath = toAbs(String(a.path ?? "."));
      const pattern = String(a.pattern);
      const include = a.include ? String(a.include) : undefined;

      if (await isPathBlockedSafe(basePath)) return { result: `Acesso bloqueado: ${basePath}`, isError: true };
      try {
        const matches = await searchContent({ basePath, pattern, includePattern: include });
        if (matches.length === 0) {
          return { result: "Nenhuma ocorrência encontrada.", isError: false };
        }
        const output = matches.map((m) => `${m.file}:${m.line}: ${m.content}`).join("\n");
        const processed = await processToolOutput(output);
        return { result: processed, isError: false };
      } catch (e) {
        return { result: `Erro na busca por conteúdo: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "write_file",
    description:
      "Cria ou sobrescreve um arquivo de texto. Cria diretórios pai se necessário. CUIDADO: sobrescreve arquivos existentes sem aviso.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "Conteúdo completo do arquivo" },
      },
      required: ["path", "content"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      if (await isPathBlockedSafe(path)) return { result: `Acesso bloqueado: ${path}`, isError: true };
      try {
        await ensureDir(dirname(path));
        await writeFile(path, String(a.content ?? ""), "utf8");
        await log("info", `write_file: ${path} (${String(a.content ?? "").length} bytes)`);
        return { result: `Arquivo escrito: ${path} (${String(a.content ?? "").length} bytes)`, isError: false };
      } catch (e) {
        return { result: `Erro ao escrever ${path}: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "edit_file",
    description:
      "Edita um arquivo substituindo a primeira ocorrência de oldText por newText. Use replaceAll=true para substituir todas.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string", description: "Texto exato a localizar" },
        newText: { type: "string", description: "Texto substituto" },
        replaceAll: { type: "boolean", default: false },
      },
      required: ["path", "oldText", "newText"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      if (await isPathBlockedSafe(path)) return { result: `Acesso bloqueado: ${path}`, isError: true };
      const res = await smartEditFile({
        path,
        oldText: String(a.oldText ?? ""),
        newText: String(a.newText ?? ""),
        replaceAll: Boolean(a.replaceAll),
      });
      return { result: res.result, isError: res.isError };
    },
  },
  {
    name: "apply_patch",
    description:
      "Aplica múltiplos blocos de substituição de texto (oldText/newText) em um arquivo de forma atômica.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string" },
              newText: { type: "string" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "changes"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      if (await isPathBlockedSafe(path)) return { result: `Acesso bloqueado: ${path}`, isError: true };
      const changes = (a.changes as { oldText: string; newText: string }[]) ?? [];
      if (!Array.isArray(changes) || changes.length === 0) {
        return { result: "Nenhuma alteração fornecida.", isError: true };
      }

      try {
        let content = await readFile(path, "utf8");
        for (let i = 0; i < changes.length; i++) {
          const { oldText, newText } = changes[i];
          const oldTextStr = String(oldText ?? "");
          if (!oldTextStr) {
            return { result: `Erro no bloco ${i + 1}: oldText não pode ser vazio`, isError: true };
          }
          if (!content.includes(oldTextStr)) {
            return { result: `Erro no bloco ${i + 1}: oldText não encontrado em ${path}`, isError: true };
          }
          const idx = content.indexOf(oldTextStr);
          const newTextStr = String(newText ?? "");
          content = content.slice(0, idx) + newTextStr + content.slice(idx + oldTextStr.length);
        }
        await writeFile(path, content, "utf8");
        await log("info", `apply_patch: ${path} (${changes.length} alterações)`);
        return { result: `Patch aplicado com sucesso em ${path} (${changes.length} alterações).`, isError: false };
      } catch (e) {
        return { result: `Erro ao aplicar patch em ${path}: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "todowrite",
    description:
      "Cria e atualiza a lista de tarefas da sessão atual. Use para planejar e acompanhar o progresso de tarefas complexas de múltiplos passos.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Descrição da tarefa" },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
              priority: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["content", "status", "priority"],
          },
        },
      },
      required: ["todos"],
    },
    run: async (a) => {
      const rawTodos = (a.todos as { content: string; status: any; priority: any }[]) ?? [];
      const formatted: TodoItem[] = rawTodos.map((t, i) => {
        let status: TodoItem["status"] = "pending";
        const st = String(t.status ?? "").toLowerCase();
        if (["completed", "done", "finished"].includes(st)) status = "completed";
        else if (["in_progress", "in-progress", "doing"].includes(st)) status = "in_progress";
        else if (["cancelled", "canceled"].includes(st)) status = "cancelled";
        else if (st === "pending" || st === "todo") status = "pending";

        let priority: TodoItem["priority"] = "medium";
        const pr = String(t.priority ?? "").toLowerCase();
        if (["high", "medium", "low"].includes(pr)) priority = pr as TodoItem["priority"];

        return {
          id: `todo_${i + 1}`,
          content: String(t.content ?? ""),
          status,
          priority,
        };
      });
      setTodos(formatted);
      return { result: `Lista de To-Dos atualizada (${formatted.length} itens).`, isError: false };
    },
  },
  {
    name: "run_task",
    description:
      "Lança um subagente autônomo para executar tarefas complexas, pesquisas, refatorações ou verificações em paralelo ou em background.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Resumo curto (3-5 palavras) da tarefa" },
        prompt: { type: "string", description: "Instruções completas para o subagente" },
        role: {
          type: "string",
          enum: ["general", "research", "verification", "plan", "coder", "custom"],
          description: "Especialidade do subagente: general | research | verification | plan | coder | custom",
        },
        customPrompt: { type: "string", description: "Instrução de persona personalizada quando role='custom'" },
        runInBackground: { type: "boolean", description: "Executar em background sem bloquear o agente principal" },
      },
      required: ["description", "prompt"],
    },
    run: async (a, ctx) => {
      if (!ctx?.config) {
        return { result: "Configuração indisponível para executar subagente.", isError: true };
      }
      const desc = String(a.description);
      const prompt = String(a.prompt);
      const role = (a.role as any) || "general";
      const customPrompt = a.customPrompt ? String(a.customPrompt) : undefined;
      const runInBackground = Boolean(a.runInBackground);
      const result = await runSubagentTask({
        config: ctx.config,
        description: desc,
        prompt,
        role,
        customPrompt,
        runInBackground,
        signal: ctx.signal,
      });
      return { result, isError: false };
    },
  },
  {
    name: "send_subagent_message",
    description: "Envia uma instrução de acompanhamento a uma sessão ativa de subagente criada anteriormente.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "ID da sessão do subagente (ex: sub_12345)" },
        message: { type: "string", description: "Nova mensagem ou instrução para o subagente" },
      },
      required: ["sessionId", "message"],
    },
    run: async (a, ctx) => {
      if (!ctx?.config) return { result: "Configuração indisponível.", isError: true };
      const sessionId = String(a.sessionId);
      const message = String(a.message);
      const res = await sendSubagentMessage(sessionId, message, ctx.config, ctx.signal);
      return { result: res.result, isError: res.isError };
    },
  },
  {
    name: "manage_background_task",
    description: "Gerencia tarefas rodando em background (subagentes ou comandos). Permite listar, verificar status e detalhes ou encerrar um processo.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "status", "kill"],
          description: "Ação a realizar: 'list' (todas as tarefas), 'status' (detalhes por ID) ou 'kill' (encerrar por ID)",
        },
        taskId: { type: "string", description: "ID da tarefa em background (necessário para 'status' e 'kill')" },
      },
      required: ["action"],
    },
    run: async (a) => {
      const action = String(a.action);
      const taskId = a.taskId ? String(a.taskId) : undefined;

      if (action === "list") {
        const tasks = listBackgroundTasks();
        if (tasks.length === 0) return { result: "Nenhuma tarefa em background registrada.", isError: false };
        return { result: JSON.stringify(tasks, null, 2), isError: false };
      }

      if (action === "status") {
        if (!taskId) return { result: "Parâmetro 'taskId' obrigatório para ação 'status'.", isError: true };
        const task = getBackgroundTask(taskId);
        if (!task) return { result: `Tarefa em background '${taskId}' não encontrada.`, isError: true };
        return { result: JSON.stringify(task, null, 2), isError: false };
      }

      if (action === "kill") {
        if (!taskId) return { result: "Parâmetro 'taskId' obrigatório para ação 'kill'.", isError: true };
        const res = killBackgroundTask(taskId);
        return { result: res.message, isError: !res.success };
      }

      return { result: `Ação '${action}' desconhecida.`, isError: true };
    },
  },
  {
    name: "repo_map",
    description:
      "Gera um mapa estrutural do repositório exibindo arquivos relevantes e suas assinaturas de funções, classes e tipos.",
    inputSchema: {
      type: "object",
      properties: {
        focusPath: { type: "string", description: "Subdiretório para focar a geração do mapa" },
        maxFiles: { type: "number", description: "Limite máximo de arquivos no mapa (padrão: 50)" },
      },
    },
    run: async (a) => {
      const focusPath = a.focusPath ? String(a.focusPath) : undefined;
      const maxFiles = a.maxFiles ? Number(a.maxFiles) : 50;
      const res = await generateRepoMap(process.cwd(), { focusPath, maxFiles });
      return { result: res.mapText, isError: false };
    },
  },
  {
    name: "find_symbol",
    description: "Busca um símbolo (função, classe, interface ou variável) através de todo o código do repositório.",
    inputSchema: {
      type: "object",
      properties: {
        symbolName: { type: "string", description: "Nome do símbolo a buscar" },
      },
      required: ["symbolName"],
    },
    run: async (a) => {
      const name = String(a.symbolName);
      const matches = await findSymbolInRepo(name, process.cwd());
      if (matches.length === 0) {
        return { result: `Nenhum símbolo encontrado para '${name}'.`, isError: false };
      }
      return { result: JSON.stringify(matches, null, 2), isError: false };
    },
  },
  {
    name: "save_memory",
    description:
      "Salva uma memória persistente (regra de projeto, preferência do usuário ou instrução) que será lembrada em sessões futuras.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Identificador curto da memória" },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description: "Tipo de memória",
        },
        description: { type: "string", description: "Descrição em uma linha do objetivo da memória" },
        content: { type: "string", description: "Conteúdo detalhado da regra ou aprendizado" },
        scope: {
          type: "string",
          enum: ["project", "global"],
          default: "project",
          description: "Escopo: 'project' (apenas neste repositório) ou 'global' (para todos os projetos)",
        },
      },
      required: ["name", "type", "description", "content"],
    },
    run: async (a) => {
      const res = await saveMemory({
        name: String(a.name),
        type: a.type as any,
        description: String(a.description),
        content: String(a.content),
        scope: (a.scope as any) || "project",
      });
      return { result: res.message, isError: false };
    },
  },
  {
    name: "recall_memory",
    description: "Consulta memórias persistentes salvas sobre o usuário ou sobre o projeto.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Termo de busca opcional para filtrar memórias" },
      },
    },
    run: async (a) => {
      const query = a.query ? String(a.query) : undefined;
      const mems = await recallMemories(query, process.cwd());
      if (mems.length === 0) {
        return { result: "Nenhuma memória encontrada.", isError: false };
      }
      return { result: JSON.stringify(mems, null, 2), isError: false };
    },
  },
  {
    name: "forget_memory",
    description: "Remove uma memória persistente antiga ou desatualizada.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nome da memória a remover" },
        scope: {
          type: "string",
          enum: ["project", "global", "all"],
          default: "project",
          description: "Escopo a remover; use 'all' somente quando explicitamente necessário",
        },
      },
      required: ["name"],
    },
    run: async (a) => {
      const scope = a.scope === "global" || a.scope === "all" ? a.scope : "project";
      const res = await forgetMemory(String(a.name), process.cwd(), scope);
      return { result: res.message, isError: res.isError };
    },
  },
  {
    name: "enter_worktree",
    description: "Cria e ativa um Git Worktree temporário e isolado para alterações e testes seguros.",
    inputSchema: {
      type: "object",
      properties: {
        branchName: { type: "string", description: "Nome da nova branch de trabalho isolado" },
      },
      required: ["branchName"],
    },
    run: async (a) => {
      const res = await enterWorktree(String(a.branchName), process.cwd());
      return { result: res.result, isError: res.isError };
    },
  },
  {
    name: "exit_worktree",
    description: "Remove um Git Worktree temporário.",
    inputSchema: {
      type: "object",
      properties: {
        worktreePath: { type: "string", description: "Caminho do worktree a remover" },
        force: { type: "boolean", description: "Forçar remoção mesmo se houver alterações não salvas" },
      },
      required: ["worktreePath"],
    },
    run: async (a) => {
      const res = await exitWorktree(String(a.worktreePath), Boolean(a.force), process.cwd());
      return { result: res.result, isError: res.isError };
    },
  },
  {
    name: "list_worktrees",
    description: "Lista todos os Git Worktrees ativos no repositório.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    run: async () => {
      const trees = await listWorktrees(process.cwd());
      if (trees.length === 0) {
        return { result: "Nenhum worktree ativo encontrado.", isError: false };
      }
      return { result: JSON.stringify(trees, null, 2), isError: false };
    },
  },
  {
    name: "ask_question",
    description:
      "Faz uma pergunta direta ao usuário com opções ou campo aberto para esclarecer dúvidas ou decisões durante a execução.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Pergunta para o usuário" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Opções de escolha sugeridas (opcional)",
        },
      },
      required: ["question"],
    },
    run: async (a) => {
      const q = String(a.question);
      const opts = Array.isArray(a.options) ? a.options.map(String) : undefined;
      const optsStr = opts && opts.length ? ` [Opções: ${opts.join(" | ")}]` : "";
      return { result: `[PERGUNTA AO USUÁRIO]: ${q}${optsStr}`, isError: false };
    },
  },
  {
    name: "read_logs",
    description:
      "Lê as últimas linhas do log do agente. Permite filtrar por nível de log ('error', 'warn', 'info', 'tool') ou termo de busca para diagnosticar problemas rapidamente.",
    inputSchema: {
      type: "object",
      properties: {
        lines: { type: "number", description: "Número de linhas a retornar (padrão: 50, máx: 200)" },
        level: { type: "string", description: "Filtro de nível: error | warn | info | tool" },
        search: { type: "string", description: "Termo de busca/filtro nos logs" },
      },
    },
    run: async (a) => {
      const rawLines = Number(a.lines);
      const lines = Number.isFinite(rawLines) && rawLines > 0 ? Math.min(Math.floor(rawLines), 200) : 50;
      const level = a.level ? String(a.level) : undefined;
      const search = a.search ? String(a.search) : undefined;

      const logs = await tailLogs({ lines, level, search });
      return { result: logs, isError: false };
    },
  },
  {
    name: "list_directory",
    description: "Lista arquivos e pastas de um diretório.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Diretório (padrão: cwd)" } },
      required: [],
    },
    run: async (a) => {
      const path = toAbs(String(a.path ?? "."));
      if (await isPathBlockedSafe(path)) return { result: `Acesso bloqueado: ${path}`, isError: true };
      try {
        const entries = await readdir(path, { withFileTypes: true });
        const lines = entries.map((e) => `${e.isDirectory() ? "[DIR] " : "[FILE] "}${e.name}`).sort();
        return { result: lines.length ? lines.join("\n") : "(diretório vazio)", isError: false };
      } catch (e) {
        return { result: `Erro ao listar ${path}: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "create_directory",
    description: "Cria um diretório (e subdiretórios) se não existir.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      if (await isPathBlockedSafe(path)) return { result: `Acesso bloqueado: ${path}`, isError: true };
      try {
        await ensureDir(path);
        return { result: `Diretório criado/confirmado: ${path}`, isError: false };
      } catch (e) {
        return { result: `Erro ao criar diretório ${path}: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "move_path",
    description: "Move ou renomeia um arquivo/diretório.",
    inputSchema: {
      type: "object",
      properties: { source: { type: "string" }, destination: { type: "string" } },
      required: ["source", "destination"],
    },
    run: async (a) => {
      const src = toAbs(String(a.source));
      const dst = toAbs(String(a.destination));
      if (await isPathBlockedSafe(src) || await isPathBlockedSafe(dst)) return { result: `Acesso bloqueado`, isError: true };
      try {
        await ensureDir(dirname(dst));
        await rename(src, dst);
        await log("info", `move_path: ${src} -> ${dst}`);
        return { result: `Movido: ${src} -> ${dst}`, isError: false };
      } catch (e) {
        return { result: `Erro ao mover: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "file_info",
    description: "Retorna metadados de um arquivo/diretório (tamanho, datas, tipo).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      if (await isPathBlockedSafe(path)) return { result: `Acesso bloqueado: ${path}`, isError: true };
      try {
        const s = await stat(path);
        return {
          result: JSON.stringify(
            {
              path,
              type: s.isDirectory() ? "directory" : "file",
              size: s.size,
              created: s.birthtime.toISOString(),
              modified: s.mtime.toISOString(),
            },
            null,
            2
          ),
          isError: false,
        };
      } catch (e) {
        return { result: `Erro: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "search_files",
    description: "Busca arquivos por padrão glob (ex: '**/*.ts', '**/*.{ts,tsx}'). Retorna caminhos absolutos.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Diretório base da busca" },
        pattern: { type: "string", description: "Padrão glob, ex: **/*.md" },
        includeHidden: { type: "boolean", default: false, description: "Incluir arquivos e diretórios ocultos (começados com .)" },
      },
      required: ["path", "pattern"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      const includeHidden = Boolean(a.includeHidden);
      if (await isPathBlockedSafe(path)) return { result: `Acesso bloqueado: ${path}`, isError: true };
      try {
        const matches = await search(path, String(a.pattern), includeHidden);
        return { result: matches.length ? matches.slice(0, 200).join("\n") : "(nenhum arquivo encontrado)", isError: false };
      } catch (e) {
        return { result: `Erro na busca: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "delete_path",
    description:
      "DESTRUTIVO: exclui um arquivo ou diretório. Use recursive=true para diretórios não vazios. Requer confirm=true para qualquer exclusão. Confirme a necessidade antes de usar.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean", default: false, description: "Necessário para diretórios não vazios" },
        confirm: { type: "boolean", default: false, description: "Obrigatório para confirmar exclusão" },
      },
      required: ["path"],
    },
    run: async (a) => {
      const path = toAbs(String(a.path));
      if (await isPathBlockedSafe(path)) return { result: `Acesso bloqueado: ${path}`, isError: true };
      if (isDangerousDeleteTarget(path)) {
        return { result: `Exclusão bloqueada para caminho crítico: ${path}`, isError: true };
      }
      const recursive = Boolean(a.recursive);
      const confirm = Boolean(a.confirm);
      if (!confirm) {
        return {
          result: "Operação destrutiva requer confirmação. Rechame com confirm=true após confirmar com o usuário.",
          isError: true,
        };
      }
      try {
        await access(path);
      } catch {
        return { result: `Caminho não existe: ${path}`, isError: true };
      }
      try {
        await log("warn", `delete_path: ${path} (recursive=${recursive})`);
        await rm(path, { recursive, force: false });
        return { result: `Excluído: ${path}`, isError: false };
      } catch (e) {
        return { result: `Erro ao excluir ${path}: ${String(e)}`, isError: true };
      }
    },
  },
  {
    name: "web_fetch",
    description:
      "Busca o conteúdo de uma página web via HTTP/HTTPS e o converte automaticamente em Markdown limpo e legível. Não requer servidores MCP externos.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL da página web a buscar (ex: https://exemplo.com)" },
        maxChars: { type: "number", description: "Limite máximo de caracteres no retorno (padrão: 15000)" },
        timeoutMs: { type: "number", description: "Tempo limite em milissegundos (padrão: 15000ms)" },
      },
      required: ["url"],
    },
    run: async (a, ctx) => {
      const url = String(a.url);
      const maxChars = a.maxChars ? Number(a.maxChars) : 15000;
      const timeoutMs = a.timeoutMs ? Number(a.timeoutMs) : 15000;
      const res = await webFetch(url, { maxChars, timeoutMs, signal: ctx?.signal });
      const processed = await processToolOutput(res.content);
      return { result: processed, isError: res.isError };
    },
  },
  {
    name: "web_search",
    description: "Pesquisa na web por um termo ou dúvida e retorna uma lista de resultados com títulos, URLs e trechos (snippets).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Termo de busca na web" },
        maxResults: { type: "number", description: "Número máximo de resultados (padrão: 8)" },
      },
      required: ["query"],
    },
    run: async (a, ctx) => {
      const query = String(a.query);
      const maxResults = a.maxResults ? Number(a.maxResults) : 8;
      const res = await webSearch(query, maxResults, ctx?.signal);
      if (res.isError) {
        return {
          result: `Erro ao realizar busca web para '${query}': ${res.error || "falha no motor de busca"}`,
          isError: true,
        };
      }
      if (res.results.length === 0) {
        return { result: `Nenhum resultado encontrado na web para '${query}'.`, isError: false };
      }
      return { result: JSON.stringify(res.results, null, 2), isError: false };
    },
  },
  {
    name: "create_artifact",
    description:
      "Cria ou atualiza um artefato estruturado persistente (relatório, diagrama Mermaid, documento HTML, especificação de arquitetura ou código). Salva o arquivo no diretório isolado do Siliconflower (~/.siliconflower/workspaces/<workspace-id>/artifacts/ ou ~/.siliconflower/artifacts/).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Identificador único do artefato (ex: plano_arquitetura)" },
        title: { type: "string", description: "Título legível do artefato" },
        type: {
          type: "string",
          enum: ["markdown", "code", "mermaid", "html", "json"],
          description: "Tipo de artefato: markdown | code | mermaid | html | json",
        },
        content: { type: "string", description: "Conteúdo completo do artefato" },
        summary: { type: "string", description: "Resumo explicativo do objetivo do artefato" },
        scope: {
          type: "string",
          enum: ["project", "global"],
          default: "project",
          description: "Escopo: 'project' (repositório atual) ou 'global' (pasta do usuário)",
        },
      },
      required: ["id", "title", "type", "content", "summary"],
    },
    run: async (a) => {
      const res = await createArtifact({
        id: String(a.id),
        title: String(a.title),
        type: a.type as any,
        content: String(a.content),
        summary: String(a.summary),
        scope: (a.scope as any) || "project",
      });
      return { result: res.message, isError: false };
    },
  },
  {
    name: "read_artifact",
    description: "Lê o conteúdo e os detalhes de um artefato salvo anteriormente pelo ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "ID do artefato a ler" },
      },
      required: ["id"],
    },
    run: async (a) => {
      const res = await readArtifact(String(a.id));
      if (!res) return { result: `Artefato '${a.id}' não encontrado.`, isError: true };
      const processed = await processToolOutput(res.content);
      return { result: processed, isError: false };
    },
  },
  {
    name: "list_artifacts",
    description: "Lista todos os artefatos salvos no repositório atual e no escopo global.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    run: async () => {
      const list = await listArtifacts();
      if (list.length === 0) return { result: "Nenhum artefato encontrado.", isError: false };
      return { result: JSON.stringify(list, null, 2), isError: false };
    },
  },
  {
    name: "delete_artifact",
    description: "Remove um artefato pelo ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "ID do artefato a remover" },
        scope: {
          type: "string",
          enum: ["project", "global", "all"],
          default: "project",
          description: "Escopo a remover; use 'all' somente quando explicitamente necessário",
        },
      },
      required: ["id"],
    },
    run: async (a) => {
      const scope = a.scope === "global" || a.scope === "all" ? a.scope : "project";
      const res = await deleteArtifact(String(a.id), process.cwd(), scope);
      return { result: res.message, isError: !res.success };
    },
  },
  {
    name: "manage_hooks",
    description: "Exibe a configuração atual de hooks ativados no workspace ou no ambiente global.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    run: async (_, ctx) => {
      const cfg = ctx?.config?.hooks || (await loadHooksConfig());
      if (!cfg || Object.keys(cfg).length === 0) {
        return { result: "Nenhum hook configurado em ~/.siliconflower/workspaces/<workspace-id>/hooks.json ou ~/.siliconflower/hooks.json.", isError: false };
      }
      return { result: JSON.stringify(cfg, null, 2), isError: false };
    },
  },
  {
    name: "execute_command",
    description: `Executa um comando de sistema no terminal (${getShellLabel()}). Retorna a saída padrão (stdout) e erros (stderr). Suporta 'runInBackground=true' para iniciar processos em segundo plano.`,
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: isWindows() ? "Comando PowerShell a ser executado" : "Comando de shell a ser executado",
        },
        cwd: { type: "string", description: "Diretório de execução (padrão: diretório atual)" },
        timeout: { type: "number", description: "Tempo limite em ms (padrão: 30000ms)" },
        runInBackground: { type: "boolean", description: "Executar em segundo plano sem aguardar término" },
      },
      required: ["command"],
    },
    run: async (a, ctx) => {
      const cmd = String(a.command ?? "").trim();
      if (!cmd) return { result: "Nenhum comando fornecido.", isError: true };
      const workDir = a.cwd ? toAbs(String(a.cwd)) : process.cwd();

      // Trigger onCommand hook if configured
      if (ctx?.config?.hooks) {
        await runHook("onCommand", ctx.config.hooks, { command: cmd, cwd: workDir });
      }

      if (a.runInBackground) {
        const taskId = startBackgroundCommand(cmd, workDir, a.timeout ? Number(a.timeout) : 300000);
        return {
          result: `Comando iniciado em background! [Task ID: ${taskId}]\nComando: ${cmd}\nUse 'manage_background_task' com action='status' e taskId='${taskId}' para verificar resultados.`,
          isError: false,
        };
      }

      const rawTimeout = Number(a.timeout);
      const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(rawTimeout, 120000) : 30000;
      const execOptions = shellExecOptions({
        cwd: workDir,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        signal: ctx?.signal,
      });
      try {
        await log("info", `execute_command: ${cmd} (cwd=${workDir})`);
        const { stdout, stderr } = await execAsync(cmd, execOptions);
        const outStr = String(stdout ?? "").trim();
        const errStr = String(stderr ?? "").trim();
        let output = "";
        if (outStr) output += outStr;
        if (errStr) output += (output ? "\n--- STDERR ---\n" : "") + errStr;
        if (!output) output = "(comando executado com sucesso sem saída de texto)";
        const processed = await processToolOutput(output);
        return { result: processed, isError: false };
      } catch (e: any) {
        const stdout = e.stdout ? String(e.stdout).trim() : "";
        const stderr = e.stderr ? String(e.stderr).trim() : "";
        let errMsg = `Erro ao executar comando (${e.code ?? e.signal ?? "erro"}): ${e.message || String(e)}`;
        if (stdout) errMsg += `\n--- STDOUT ---\n${stdout}`;
        if (stderr) errMsg += `\n--- STDERR ---\n${stderr}`;
        const processed = await processToolOutput(errMsg);
        return { result: processed, isError: true };
      }
    },
  },
];

export function builtinToolsAsMcp(): McpTool[] {
  return BUILTIN_TOOLS.map((t) => ({
    server: "builtin",
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function isBuiltin(name: string): boolean {
  return BUILTIN_TOOLS.some((t) => t.name === name);
}

export async function runBuiltin(
  name: string,
  args: Record<string, unknown>,
  ctx?: ToolContext
): Promise<{ result: string; isError: boolean }> {
  const tool = BUILTIN_TOOLS.find((t) => t.name === name);
  if (!tool) return { result: `ferramenta nativa desconhecida: ${name}`, isError: true };

  const filePath = typeof args.path === "string"
    ? toAbs(args.path)
    : typeof args.destination === "string"
      ? toAbs(args.destination)
      : undefined;
  const hookCtx = { toolName: name, toolArgs: args, cwd: process.cwd(), filePath };
  const hooksEnabled = Boolean(ctx?.config?.hooks && ctx.mode !== "plano");

  // Pre-tool hook
  if (hooksEnabled && ctx?.config?.hooks) {
    await runHook("preTool", ctx.config.hooks, hookCtx);
  }

  const rawTimeout = Number(args?.timeout);
  const toolTimeoutArg = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(rawTimeout + 5000, 125000) : 60000;
  const TOOL_TIMEOUT_MS = Math.max(60000, toolTimeoutArg);
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (ctx?.signal?.aborted) controller.abort();
  ctx?.signal?.addEventListener("abort", onParentAbort, { once: true });
  let timedOut = false;
  const cancellable = CANCELLABLE_BUILTINS.has(name);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ result: string; isError: boolean }>((resolve) => {
    if (!cancellable) return;
    timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
        resolve({ result: `Tempo limite excedido na execução da ferramenta: ${name}`, isError: true });
      },
      TOOL_TIMEOUT_MS
    );
  });
  try {
    const toolPromise = tool.run(args, { ...ctx, signal: controller.signal });
    const res = cancellable ? await Promise.race([toolPromise, timeoutPromise]) : await toolPromise;

    // On-edit and Post-tool hooks
    if (!timedOut && hooksEnabled && ctx?.config?.hooks) {
      if (!res.isError && ["edit_file", "write_file", "apply_patch", "move_path", "delete_path"].includes(name)) {
        await runHook("onEdit", ctx.config.hooks, hookCtx);
      }
      await runHook("postTool", ctx.config.hooks, hookCtx);
    }

    return res;
  } finally {
    if (timer) clearTimeout(timer);
    ctx?.signal?.removeEventListener("abort", onParentAbort);
  }
}
