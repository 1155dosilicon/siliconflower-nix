import OpenAI from "openai";
import { log } from "./logger.js";
import { compressHistory } from "./context.js";
import type { AppConfig, ChatMessage, McpTool, ReasoningLevel, StreamEvent } from "./types.js";
import { isXiaomiMimoEndpoint } from "./reasoning.js";

export interface ChatOptions {
  config: AppConfig;
  messages: ChatMessage[];
  tools: McpTool[];
  reasoning: ReasoningLevel;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<{ result: string; isError: boolean }>;
  signal?: AbortSignal;
}

export async function* streamChat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
  try {
    yield* streamOpenAI(opts);
  } catch (err) {
    if (isAbortError(err)) throw err;
    void log("error", `streamChat: ${err instanceof Error ? err.message : String(err)}`);
    yield { type: "error", message: enrichError(err, opts.config) };
  }
}

function isAbortError(err: unknown): boolean {
  return (err instanceof Error && err.name === "AbortError") || /abort/i.test(String(err));
}

export function enrichError(err: unknown, config: AppConfig): string {
  const e = err as { message?: string; status?: number; status_code?: number; error?: { message?: string } };
  const status = e?.status ?? e?.status_code;
  const inner = e?.error?.message ?? e?.message ?? String(err);
  const hint =
    status === 404
      ? ` - 404: check the baseURL and the model ID. SiliconFlow and other OpenAI-compatible providers use a baseURL ending in "/v1".`
      : status === 401
        ? " - 401: API key is invalid."
        : "";
  return `[${config.model}] ${inner}${status ? ` (HTTP ${status})` : ""}${hint}`;
}

/* ----------------------------- OpenAI-compatible ----------------------------- */

export function buildOpenAIMessages(
  config: AppConfig,
  messages: ChatMessage[]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const preserveReasoningContent = isXiaomiMimoEndpoint(config.baseURL);
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (config.system) out.push({ role: "system", content: config.system });
  // compressHistory may drop the assistant(tool_calls) message that a tool result answers;
  // an orphan tool message makes the API reject the request, so skip those.
  const knownCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) for (const c of m.toolCalls) knownCallIds.add(c.id);
    if (m.role === "tool" && m.toolCallId && !knownCallIds.has(m.toolCallId)) continue;
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: m.content || "",
          tool_calls: m.toolCalls,
          ...(preserveReasoningContent && m.reasoning !== undefined ? { reasoning_content: m.reasoning } : {}),
        } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam);
      } else {
        out.push({
          role: "assistant",
          content: m.content,
          ...(preserveReasoningContent && m.reasoning !== undefined ? { reasoning_content: m.reasoning } : {}),
        } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam);
      }
    } else if (m.role === "tool") {
      out.push({
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId ?? m.toolName ?? "call",
      });
    }
  }
  return out;
}

export function buildOpenAITools(tools: McpTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? `MCP tool from "${t.server}"`,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

const STREAM_CONNECT_TIMEOUT_MS = 300_000;

async function withConnectTimeout<T>(promise: Promise<T>, signal?: AbortSignal, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      onTimeout?.();
      reject(new Error(`Sem resposta da API após ${STREAM_CONNECT_TIMEOUT_MS / 1000}s (timeout de conexão)`));
    }, STREAM_CONNECT_TIMEOUT_MS);

    const onAbort = () => {
      cleanup();
      reject(new DOMException("Abortado", "AbortError"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      cleanup();
      reject(new DOMException("Abortado", "AbortError"));
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (v) => { cleanup(); resolve(v); },
      (e) => { cleanup(); reject(e); }
    );
  });
}

/** Official OpenAI endpoints reject `max_tokens` for reasoning models (o-series, gpt-5). */
export function isOfficialOpenAIEndpoint(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

const MAX_OUTPUT_TOKENS = 16384;
export const MAX_STEPS = 50;

async function* streamOpenAI(opts: ChatOptions): AsyncGenerator<StreamEvent> {
  const { config, messages, tools, reasoning, executeTool, signal } = opts;
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
  const apiTools = buildOpenAITools(tools);
  const isXiaomiMimo = isXiaomiMimoEndpoint(config.baseURL);
  const effort = !isXiaomiMimo && reasoning !== "none" ? reasoning : undefined;
  let supportsEffort = true;
  let tokenParam: "max_tokens" | "max_completion_tokens" = isOfficialOpenAIEndpoint(config.baseURL)
    ? "max_completion_tokens"
    : "max_tokens";

  // `history` is the full conversation; `turn` collects only the messages produced in this
  // call (assistant tool calls, tool results, final answer) so the caller can persist them.
  // The history is re-compacted before every request: a long tool loop can otherwise grow
  // far beyond the context budget.
  const history: ChatMessage[] = [...messages];
  const turn: ChatMessage[] = [];
  let finalContent = "";
  let finalThinking = "";

  void log("info", `LLM request: model=${config.model}, tools=${apiTools.length}, reasoning=${reasoning}`);

  for (let step = 0; step < MAX_STEPS; step++) {
    const working = buildOpenAIMessages(config, compressHistory(history));
    let content = "";
    let thinking = "";
    const pendingCalls: {
      id: string;
      name: string;
      args: string;
    }[] = [];
    const argBuffers = new Map<number, { id?: string; name?: string; args: string }>();

    let requestController: AbortController | undefined;
    let detachRequestAbort = () => {};
    const makeRequest = (withEffort: boolean) => {
      detachRequestAbort();
      requestController = new AbortController();
      if (signal?.aborted) requestController.abort();
      const onExternalAbort = () => requestController?.abort();
      signal?.addEventListener("abort", onExternalAbort, { once: true });
      detachRequestAbort = () => signal?.removeEventListener("abort", onExternalAbort);
      return client.chat.completions.create(
        {
          model: config.model,
          messages: working,
          stream: true,
          [tokenParam]: MAX_OUTPUT_TOKENS,
          stream_options: { include_usage: true },
          ...(withEffort && effort ? { reasoning_effort: effort } : {}),
          ...(isXiaomiMimo ? { thinking: { type: reasoning === "none" ? "disabled" : "enabled" } } : {}),
          ...(apiTools.length ? { tools: apiTools, tool_choice: "auto" } : {}),
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        { signal: requestController.signal }
      );
    };

    let stream: Awaited<ReturnType<typeof client.chat.completions.create>> | undefined;
    void log("info", `LLM step ${step}: conectando (timeout=${STREAM_CONNECT_TIMEOUT_MS / 1000}s)`);
    // Providers differ in which optional parameters they accept. Each rejected parameter
    // is adjusted at most once and remembered for the following steps.
    for (let attempt = 0; !stream; attempt++) {
      try {
        stream = await withConnectTimeout(makeRequest(supportsEffort), signal, () => requestController?.abort());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < 3 && supportsEffort && effort && /reasoning/i.test(msg)) {
          supportsEffort = false;
          void log("warn", "Provedor rejeitou reasoning_effort; repetindo sem ele");
        } else if (attempt < 3 && tokenParam === "max_tokens" && /max_tokens/.test(msg) && /max_completion_tokens/.test(msg)) {
          tokenParam = "max_completion_tokens";
          void log("warn", "Provedor exige max_completion_tokens; repetindo");
        } else if (attempt < 3 && tokenParam === "max_completion_tokens" && /max_completion_tokens/.test(msg) && /unsupported|unknown|unrecognized|not supported|invalid/i.test(msg)) {
          tokenParam = "max_tokens";
          void log("warn", "Provedor não aceita max_completion_tokens; repetindo com max_tokens");
        } else {
          detachRequestAbort();
          throw err;
        }
      }
    }
    void log("info", `LLM step ${step}: stream conectado`);

    let finishReason: string | null = null;
    let stepHasText = false;
    let stepHasThinking = false;
    let toolCallChunkCount = 0;

    try {
      for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
      if (chunk.usage) {
        yield {
          type: "usage",
          totalTokens: chunk.usage.total_tokens,
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta as
        | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
            reasoning_content?: string;
            reasoning?: string;
          })
        | undefined;
      if (!delta) continue;
      if (delta.reasoning_content) {
        if (!stepHasThinking && finalThinking && !finalThinking.endsWith("\n") && !delta.reasoning_content.startsWith("\n")) {
          const sep = "\n\n";
          finalThinking += sep;
          yield { type: "thinking", text: sep };
        }
        stepHasThinking = true;
        thinking += delta.reasoning_content;
        yield { type: "thinking", text: delta.reasoning_content };
      } else if ((delta as { reasoning?: string }).reasoning) {
        const r = (delta as { reasoning?: string }).reasoning!;
        if (!stepHasThinking && finalThinking && !finalThinking.endsWith("\n") && !r.startsWith("\n")) {
          const sep = "\n\n";
          finalThinking += sep;
          yield { type: "thinking", text: sep };
        }
        stepHasThinking = true;
        thinking += r;
        yield { type: "thinking", text: r };
      }
      if (delta.content) {
        if (!stepHasText && finalContent && !finalContent.endsWith("\n") && !delta.content.startsWith("\n")) {
          const sep = "\n\n";
          finalContent += sep;
          yield { type: "text", text: sep };
        }
        stepHasText = true;
        content += delta.content;
        yield { type: "text", text: delta.content };
      }
      if (delta.tool_calls) {
        toolCallChunkCount += delta.tool_calls.length;
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const buf = argBuffers.get(idx) ?? { args: "" };
          if (tc.id) buf.id = tc.id;
          if (tc.function?.name) buf.name = tc.function.name;
          if (tc.function?.arguments) buf.args += tc.function.arguments;
          argBuffers.set(idx, buf);
        }
      }
      }
    } finally {
      detachRequestAbort();
    }

    void log("info", `LLM step ${step}: finish_reason=${finishReason}, argBuffers=${argBuffers.size}, toolCallChunks=${toolCallChunkCount}`);

    for (const [, buf] of argBuffers) {
      if (buf.name) pendingCalls.push({ id: buf.id ?? `call_${Math.random().toString(36).slice(2)}`, name: buf.name, args: buf.args });
    }

    finalContent += content;
    finalThinking += thinking;

    void log("info", `LLM step ${step}: pendingCalls=${pendingCalls.length}, content=${content.length}chars`);

    if (pendingCalls.length === 0) {
      if (finishReason === "tool_calls") {
        // O modelo sinalizou tool_calls mas nenhum foi parseado — log para diagnóstico
        void log("warn", `LLM step ${step}: finish_reason=tool_calls mas 0 calls parseados. argBuffers raw: ${JSON.stringify(Object.fromEntries(argBuffers))}`);
      }
      if (content || thinking) {
        turn.push({ role: "assistant", content, ...(thinking ? { reasoning: thinking } : {}) });
      }
      yield { type: "done", content: finalContent, reasoning: finalThinking, messages: turn };
      return;
    }

    // Record the assistant tool-call message and execute.
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: content || "",
      toolCalls: pendingCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.args },
      })),
      // MiMo requires reasoning_content on the assistant message preceding tool results.
      ...(isXiaomiMimo ? { reasoning: thinking } : {}),
    };
    history.push(assistantMsg);
    turn.push(assistantMsg);

    void log("info", `LLM step ${step}: executando ${pendingCalls.length} tool(s): ${pendingCalls.map(c => c.name).join(", ")}`);

    for (const call of pendingCalls) {
      void log("info", `LLM step ${step}: -> ${call.name}(${call.args.slice(0, 200)})`);
      yield { type: "tool_call", id: call.id, name: call.name, args: call.args };
      let parsed: Record<string, unknown> = {};
      try {
        parsed = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {};
      } catch {
        parsed = { _raw: call.args };
      }
      let result = "";
      let isError = false;
      try {
        const r = await executeTool(call.name, parsed);
        result = r.result;
        isError = r.isError;
      } catch (err) {
        result = String(err);
        isError = true;
      }
      void log(isError ? "warn" : "info", `LLM step ${step}: <- ${call.name} isError=${isError} result=${result.slice(0, 200)}`);
      yield { type: "tool_result", id: call.id, name: call.name, result, isError };
      const toolMsg: ChatMessage = { role: "tool", toolCallId: call.id, toolName: call.name, content: result };
      history.push(toolMsg);
      turn.push(toolMsg);
    }
    void log("info", `LLM step ${step}: histórico agora: ${history.length} mensagens`);
    // loop continues: model sees tool results and may respond or call again.
  }

  // Step budget exhausted: tell the user instead of ending silently.
  const notice = `[Limite de ${MAX_STEPS} passos de ferramentas atingido nesta mensagem. Envie "continue" para prosseguir.]`;
  finalContent += (finalContent ? "\n\n" : "") + notice;
  yield { type: "text", text: notice };
  yield { type: "done", content: finalContent, reasoning: finalThinking, messages: turn };
}
