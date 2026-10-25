import { streamChat } from "../llm.js";
import { builtinToolsAsMcp, runBuiltin, isBuiltin } from "../tools.js";
import { SKILL_TOOL, readSkillContent } from "../skills.js";
import type { AppConfig, ChatMessage, StreamEvent } from "../types.js";
import { registerBackgroundTask, settleBackgroundTask } from "./background-tasks.js";
import { log } from "../logger.js";

export type SubagentRole = "general" | "research" | "verification" | "plan" | "coder" | "custom";

export interface SubagentOptions {
  config: AppConfig;
  description: string;
  prompt: string;
  role?: SubagentRole;
  customPrompt?: string;
  runInBackground?: boolean;
  signal?: AbortSignal;
}

export interface SubagentSession {
  id: string;
  description: string;
  role: SubagentRole;
  history: ChatMessage[];
  createdAt: string;
  customPrompt?: string;
}

const activeSubagentSessions = new Map<string, SubagentSession>();

// Sessions (with their full message history) are never removed otherwise, so a long-lived
// session spawning many subagents would grow this map's memory usage without bound.
const MAX_SUBAGENT_SESSIONS = 200;

function pruneOldSessions(): void {
  const excess = activeSubagentSessions.size - MAX_SUBAGENT_SESSIONS;
  if (excess <= 0) return;
  // Map preserves insertion order, so the oldest sessions are evicted first.
  for (const id of [...activeSubagentSessions.keys()].slice(0, excess)) {
    activeSubagentSessions.delete(id);
  }
}

function getRoleSystemPrompt(role: SubagentRole, description: string, customPrompt?: string): string {
  if (role === "custom" && customPrompt) {
    return `${customPrompt}\n\nDescrição da Tarefa Atual: ${description}`;
  }

  switch (role) {
    case "research":
      return `Você é um agente de pesquisa e exploração de código de alta velocidade.
Sua missão: investigar a estrutura do código, arquivos, funções e responder perguntas complexas sobre a arquitetura.
Descrição da Tarefa: ${description}
Foco: Forneça relatórios concisos e fundamentados com nomes de arquivos e números de linhas exatos.`;

    case "verification":
      return `Você é um agente de verificação e controle de qualidade rigoroso.
Sua missão: testar, compilar, rodar linters e verificar se as alterações de código satisfazem todos os requisitos sem introduzir regressões.
Descrição da Tarefa: ${description}
Resultado Esperado: Um veredito claro (PASS / FAIL / PARTIAL) acompanhado das evidências e saídas de testes.`;

    case "plan":
      return `Você é um arquiteto de software.
Sua missão: analisar requisitos, identificar arquivos críticos e elaborar um plano de implementação detalhado passo a passo.
Descrição da Tarefa: ${description}`;

    case "coder":
      return `Você é um especialista em refatoração e implementação de código limpo.
Sua missão: implementar funcionalidades e correções de bugs seguindo o padrão do repositório.
Descrição da Tarefa: ${description}`;

    case "general":
    default:
      return `Você é um subagente autônomo do Siliconflower.
Sua missão: executar a tarefa atribuída de forma independente e segura.
Descrição da Tarefa: ${description}
Instrução: Use as ferramentas necessárias e responda com um resumo completo dos resultados obtidos.`;
  }
}

/**
 * Executes or spawns a subagent task.
 */
export async function runSubagentTask(opts: SubagentOptions): Promise<string> {
  const role = opts.role || "general";
  const systemPrompt = getRoleSystemPrompt(role, opts.description, opts.customPrompt);
  const sessionId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const session: SubagentSession = {
    id: sessionId,
    description: opts.description,
    role,
    history: [{ role: "user", content: opts.prompt }],
    createdAt: new Date().toISOString(),
    customPrompt: opts.customPrompt,
  };

  activeSubagentSessions.set(sessionId, session);
  pruneOldSessions();

  if (opts.runInBackground) {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onParentAbort, { once: true });
    registerBackgroundTask({
      id: sessionId,
      type: "subagent",
      description: opts.description,
      role,
      status: "running",
      startedAt: new Date().toISOString(),
      cancel: () => controller.abort(),
    });

    // Execute asynchronously without blocking caller
    runSubagentExecution({ ...opts, signal: controller.signal }, systemPrompt, session)
      .then((res) => {
        settleBackgroundTask(sessionId, "completed", res);
      })
      .catch((err) => {
        settleBackgroundTask(sessionId, "failed", `Erro: ${err.message || String(err)}`);
      })
      .finally(() => opts.signal?.removeEventListener("abort", onParentAbort));

    return `Subagente iniciado em background! [ID do Subagente: ${sessionId}] — Descrição: ${opts.description}`;
  }

  return runSubagentExecution(opts, systemPrompt, session);
}

/**
 * Sends a follow-up message to an existing subagent session.
 */
export async function sendSubagentMessage(
  sessionId: string,
  message: string,
  config: AppConfig,
  signal?: AbortSignal
): Promise<{ result: string; isError: boolean }> {
  const session = activeSubagentSessions.get(sessionId);
  if (!session) {
    return { result: `Sessão de subagente '${sessionId}' não encontrada.`, isError: true };
  }

  session.history.push({ role: "user", content: message });
  const systemPrompt = getRoleSystemPrompt(session.role, session.description, session.customPrompt);

  try {
    const res = await runSubagentExecution(
      {
        config,
        description: session.description,
        prompt: message,
        role: session.role,
        customPrompt: session.customPrompt,
        signal,
      },
      systemPrompt,
      session
    );
    return { result: res, isError: false };
  } catch (err) {
    return { result: `Erro ao executar subagente: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function runSubagentExecution(opts: SubagentOptions, systemPrompt: string, session: SubagentSession): Promise<string> {
  // Tools available to subagent (exclude recursion on run_task)
  const tools = [
    ...builtinToolsAsMcp().filter((t) => t.name !== "run_task"),
    {
      server: "skill",
      name: SKILL_TOOL.name,
      description: SKILL_TOOL.description,
      inputSchema: SKILL_TOOL.inputSchema,
    },
  ];

  let accumulatedContent = "";

  try {
    await log("info", `[Subagente iniciado] [${opts.role || "general"}] ${opts.description}`);

    const gen = streamChat({
      config: { ...opts.config, system: systemPrompt },
      messages: session.history,
      tools,
      reasoning: "none",
      signal: opts.signal,
      executeTool: async (name, args) => {
        if (name === SKILL_TOOL.name) {
          try {
            const content = await readSkillContent(String(args.name ?? ""));
            return { result: content, isError: false };
          } catch (e) {
            return { result: String(e), isError: true };
          }
        }
        if (isBuiltin(name)) {
          return runBuiltin(name, args, { config: opts.config });
        }
        return { result: `Ferramenta ${name} não disponível no subagente`, isError: true };
      },
    });

    for await (const ev of gen as AsyncIterable<StreamEvent>) {
      if (ev.type === "text") {
        accumulatedContent += ev.text;
      } else if (ev.type === "done") {
        if (ev.content) accumulatedContent = ev.content;
      } else if (ev.type === "error") {
        throw new Error(ev.message);
      }
    }

    if (accumulatedContent) {
      session.history.push({ role: "assistant", content: accumulatedContent });
    }

    await log("ok", `[Subagente concluído] ${opts.description}`);
    return accumulatedContent || "(Subagente concluiu a tarefa sem retornar saída de texto)";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log("error", `[Subagente erro] ${msg}`);
    throw err;
  }
}

export function getSubagentSession(id: string): SubagentSession | undefined {
  return activeSubagentSessions.get(id);
}
