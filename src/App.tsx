import React, { useState, useCallback, useEffect, useRef } from "react";
import { render, Box, Static, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { renderLogo } from "./ascii.js";
import { streamChat } from "./llm.js";
import { McpManager } from "./mcp.js";
import { builtinToolsAsMcp, isBuiltin, runBuiltin } from "./tools.js";
import { loadSkills, readSkillContent, SKILL_TOOL, type Skill } from "./skills.js";
import { buildSystemPrompt, modeLabel, nextMode, type Mode } from "./modes.js";
import { buildMemorySystemPrompt } from "./services/memory.js";
import { onTodosChange } from "./todo.js";
import { estimateTokens, estimateMessagesTokens, formatTokenCount } from "./context.js";
import { MarkdownText } from "./MarkdownText.js";
import { LiveResponse } from "./LiveResponse.js";
import { log, logFile } from "./logger.js";
import type { AppConfig, ChatMessage, McpTool, ReasoningLevel, StreamEvent, TodoItem } from "./types.js";
import { isToolAllowedInMode } from "./tool-policy.js";
import { runHook } from "./core/hooks.js";
import { clearScreen, restoreTerminal, enableSynchronizedOutput, ANSI_CLEAR_SCREEN } from "./terminal.js";
import { reasoningLabel, reasoningOptions } from "./reasoning.js";
import { findProject } from "./project.js";
import { basename } from "node:path";

interface AppProps {
  config: AppConfig;
  overrides: { model?: string; reasoning?: ReasoningLevel; mode?: Mode };
}

interface UIMessage {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
}

interface PendingQuestion {
  question: string;
  options?: string[];
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
}

const RESIZE_SETTLE_MS = 150;
// Streamed text is pushed to the UI at most this often (the MarkdownText re-parse and the
// Ink frame diff are paid per update, not per token).
const LIVE_TEXT_FLUSH_MS = 60;
// Longer than Ink's 32 ms render throttle, so the frame at the new width is already on
// screen (and is Ink's lastOutput) when the screen is wiped.
const REPAINT_DELAY_MS = 50;

type StaticItem = { kind: "logo"; key: string } | { kind: "message"; key: string; message: UIMessage };

const MessageView: React.FC<{ message: UIMessage }> = ({ message: m }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Text bold color={m.role === "user" ? "cyan" : "green"}>
      {m.role === "user" ? "voce>" : "ia>"}
    </Text>
    {m.role === "assistant" ? <MarkdownText>{m.content}</MarkdownText> : <Text>{m.content}</Text>}
    {m.reasoning && (
      <Text dimColor italic>{"  thinking: " + m.reasoning.slice(0, 200) + (m.reasoning.length > 200 ? "..." : "")}</Text>
    )}
  </Box>
);

export const App: React.FC<AppProps> = ({ config, overrides }) => {
  const { exit } = useApp();
  const { stdout, write: writeToStdout } = useStdout();

  const [model] = useState(overrides.model ?? config.model);
  const [reasoning, setReasoning] = useState<ReasoningLevel>(overrides.reasoning ?? config.reasoning);
  const [mode, setMode] = useState<Mode>(overrides.mode ?? config.mode ?? "programação");
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [status, setStatus] = useState("pronto");
  const [mcpCount, setMcpCount] = useState(0);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [todos, setTodosState] = useState<TodoItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cols, setCols] = useState(stdout?.columns ?? 100);
  const [rows, setRows] = useState(stdout?.rows ?? 30);
  const [apiTokens, setApiTokens] = useState(0);
  // Last memory/project prompt segment, so the token counter reflects what is really sent.
  const [memoryPrompt, setMemoryPrompt] = useState("");
  const [project, setProject] = useState(() => findProject(process.cwd()));
  const [question, setQuestion] = useState<PendingQuestion | null>(null);
  const questionRef = useRef<PendingQuestion | null>(null);
  questionRef.current = question;
  // Full API conversation (including tool calls and tool results), separate from the
  // rendered UI messages, so the model keeps the context of what its tools did.
  const historyRef = useRef<ChatMessage[]>([]);
  const mcpRef = useRef<McpManager | null>(null);
  const skillsRef = useRef<Skill[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const lastCtrlRef = useRef<number>(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    return onTodosChange((updated) => setTodosState([...updated]));
  }, []);

  // Re-picked on every resize (cols state), so the logo never wraps in narrow windows.
  const { art, color } = renderLogo(cols);

  // Ink only erases "the N lines of the previous frame" on resize, but the terminal has
  // already reflowed those lines into a different number of rows, so fragments of old
  // frames pile up (e.g. a stacked logo under the full one). Once resizing settles:
  //  1. cols/rows update, so Ink draws the live frame at the new width;
  //  2. the screen and scrollback are wiped through Ink's write() (which then redraws that
  //     frame, keeping its line bookkeeping right);
  //  3. <Static> (logo + finished messages) is remounted, so Ink reprints the whole
  //     scrollback at the new width above the live frame.
  const [staticGen, setStaticGen] = useState(0);
  const [repaintTick, setRepaintTick] = useState(0);
  useEffect(() => {
    if (!stdout) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setCols(stdout.columns);
        setRows(stdout.rows);
        setRepaintTick((t) => t + 1);
      }, RESIZE_SETTLE_MS);
    };
    stdout.on("resize", handler);
    return () => {
      if (timer) clearTimeout(timer);
      stdout.off("resize", handler);
    };
  }, [stdout]);

  useEffect(() => {
    if (repaintTick === 0) return;
    const timer = setTimeout(() => {
      writeToStdout(ANSI_CLEAR_SCREEN);
      setStaticGen((g) => g + 1);
    }, REPAINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [repaintTick, writeToStdout]);

  useEffect(() => {
    const mcp = new McpManager();
    mcpRef.current = mcp;
    let cancelled = false;
    (async () => {
      const loaded = await loadSkills();
      if (cancelled) return;
      skillsRef.current = loaded;
      setSkills(loaded);
      setMemoryPrompt(await buildMemorySystemPrompt(process.cwd()).catch(() => ""));
      await log("info", `siliconflower iniciado - model=${model}`);
      if (config.hooks) {
        await runHook("onSessionStart", config.hooks, { cwd: process.cwd() });
      }
      setStatus("conectando MCP...");
      try {
        const tools = await mcp.connectAll(config.mcpServers);
        if (cancelled) return;
        setMcpCount(tools.length);
        await log("ok", `MCP conectado: ${mcp.serverCount()} servidores, ${tools.length} ferramentas`);
        const failures = mcp.connectFailures();
        if (failures.length) {
          setError(`MCP: falha ao conectar ${failures.map((f) => f.server).join(", ")} (detalhes em siliconflower logs)`);
          setStatus(`pronto (${failures.length} servidor(es) MCP com falha)`);
        } else {
          setStatus("pronto");
        }
      } catch (e) {
        await log("error", `MCP indisponivel: ${String(e)}`);
        setStatus("MCP indisponivel");
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      if (config.hooks) void runHook("onSessionEnd", config.hooks, { cwd: process.cwd() });
      void mcp.close();
    };
  }, []);

  const cycleReasoning = useCallback(() => {
    lastCtrlRef.current = Date.now();
    setInput((prev) => prev.replace(/[\x00-\x1F\x7F]/g, "").replace(/e$/i, ""));
    setReasoning((r) => {
      const levels = reasoningOptions(config.baseURL);
      const idx = levels.indexOf(r);
      const next = levels[(idx + 1) % levels.length];
      setStatus(`pensamento: ${reasoningLabel(next, config.baseURL)}`);
      setTimeout(() => setStatus("pronto"), 1200);
      return next;
    });
  }, [config.baseURL]);

  const cycleMode = useCallback(() => {
    lastCtrlRef.current = Date.now();
    setInput((prev) => prev.replace(/[\x00-\x1F\x7F]/g, "").replace(/o$/i, ""));
    setMode((m) => {
      const n = nextMode(m);
      setStatus(`mode: ${n}`);
      setTimeout(() => setStatus("pronto"), 1200);
      return n;
    });
  }, []);

  const handleCancel = useCallback(() => {
    if (streaming) {
      abortRef.current?.abort();
      setStatus("cancelado");
    } else {
      exit();
    }
  }, [streaming, exit]);

  const askUser = useCallback(
    (q: string, options: string[] | undefined, signal?: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error("operação cancelada"));
        const onAbort = () => {
          setQuestion(null);
          reject(new Error("operação cancelada"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        setInput("");
        setStatus("aguardando sua resposta...");
        setQuestion({
          question: q,
          options,
          resolve: (answer) => {
            signal?.removeEventListener("abort", onAbort);
            setQuestion(null);
            setStatus("processando...");
            resolve(answer);
          },
          reject,
        });
      }),
    []
  );

  const answerQuestion = useCallback((raw: string) => {
    const pending = questionRef.current;
    if (!pending) return;
    const text = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
    if (!text) return;
    // A bare number selects the corresponding option.
    const n = Number(text);
    const answer = pending.options && Number.isInteger(n) && n >= 1 && n <= pending.options.length
      ? pending.options[n - 1]
      : text;
    setInput("");
    pending.resolve(answer);
  }, []);

  const allTools = useCallback((): McpTool[] => {
    const list: McpTool[] = [...builtinToolsAsMcp()];
    list.push({ server: "skill", name: SKILL_TOOL.name, description: SKILL_TOOL.description, inputSchema: SKILL_TOOL.inputSchema });
    const mcp = mcpRef.current;
    if (mcp) list.push(...mcp.allTools());
    return list;
  }, []);

  const executeTool = useCallback(
    async (name: string, args: Record<string, unknown>): Promise<{ result: string; isError: boolean }> => {
      if (!isToolAllowedInMode(modeRef.current, name, args)) {
        return {
          result: `[MODO PLANO ATIVO] Execução de ${name} bloqueada. Apresente o plano ao usuário e peça para alternar para o modo 'programação' (Ctrl+O) para aplicar as alterações.`,
          isError: true,
        };
      }

      if (name === SKILL_TOOL.name) {
        try {
          const content = await readSkillContent(String(args.name ?? ""));
          return { result: content, isError: false };
        } catch (e) {
          return { result: String(e), isError: true };
        }
      }
      if (isBuiltin(name)) {
        return runBuiltin(name, args, {
          // Carry CLI overrides (e.g. --model) so subagents use the same model.
          config: { ...config, model },
          mode: modeRef.current,
          signal: abortRef.current?.signal,
          askUser,
        });
      }
      const mcp = mcpRef.current;
      if (mcp) {
        try {
          return await mcp.callTool(name, args, abortRef.current?.signal);
        } catch (e) {
          return { result: String(e), isError: true };
        }
      }
      return { result: `tool not found: ${name}`, isError: true };
    },
    [config, model, askUser]
  );

  const handleInputChange = useCallback((val: string) => {
    let clean = val.replace(/[\x00-\x1F\x7F]/g, "");
    if (Date.now() - lastCtrlRef.current < 250) {
      clean = clean.replace(/[oe]$/i, "");
    }
    setInput(clean);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const cleanText = text.replace(/[\x00-\x1F\x7F]/g, "").trim();
      if (!cleanText || streaming) return;
      setError(null);
      setMessages((m) => [...m, { role: "user", content: cleanText }]);
      setInput("");
      setStreaming(true);
      setLiveText("");
      setStatus("pensando...");

      // Pass the full API history (including tool calls/results from earlier turns) so the
      // model keeps that context; compressHistory in llm.ts applies the token budget.
      const userMsg: ChatMessage = { role: "user", content: cleanText };
      const history: ChatMessage[] = [...historyRef.current, userMsg];
      const controller = new AbortController();
      abortRef.current = controller;

      let accText = "";
      let accThinking = "";
      let liveTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleLiveText = () => {
        if (liveTimer) return;
        liveTimer = setTimeout(() => {
          liveTimer = undefined;
          setLiveText(accText);
        }, LIVE_TEXT_FLUSH_MS);
      };
      let hadError = false;
      let assistantMsgAdded = false;
      // Commits this turn to the API history exactly once.
      const commitTurn = (turnMessages: ChatMessage[]) => {
        historyRef.current = [...historyRef.current, userMsg, ...turnMessages];
      };

      try {
        const turnMemoryPrompt = await buildMemorySystemPrompt(process.cwd());
        setMemoryPrompt(turnMemoryPrompt);
        // The marker file may have been created mid-session (e.g. by the agent itself).
        setProject(findProject(process.cwd()));
        const systemPrompt = buildSystemPrompt(modeRef.current, config.system, skillsRef.current, turnMemoryPrompt);
        const gen = streamChat({
          config: { ...config, system: systemPrompt, model },
          messages: history,
          tools: allTools(),
          reasoning,
          signal: controller.signal,
          executeTool,
        });

        for await (const ev of gen as AsyncIterable<StreamEvent>) {
          switch (ev.type) {
            case "thinking":
              accThinking += ev.text;
              setStatus("🧠 pensando...");
              break;
            case "text":
              accText += ev.text;
              scheduleLiveText();
              break;
            case "tool_call":
              setStatus(`🔨 ${ev.name}...`);
              break;
            case "tool_result":
              setStatus("processando...");
              break;
            case "usage":
              if (ev.totalTokens) setApiTokens(ev.totalTokens);
              break;
            case "error":
              hadError = true;
              setError(ev.message);
              await log("error", `Stream error: ${ev.message}`);
              if (!assistantMsgAdded) {
                assistantMsgAdded = true;
                const partial = accText.trim();
                const shown = partial ? `${partial}\n\n[Erro: ${ev.message}]` : `[Erro: ${ev.message}]`;
                setMessages((m) => [...m, { role: "assistant", content: shown }]);
                commitTurn([{ role: "assistant", content: shown }]);
              }
              break;
            case "done":
              {
                const final = ev.content?.trim() || accText.trim();
                const finalThinking = ev.reasoning?.trim() || accThinking.trim();
                if (final) {
                  setMessages((m) => [...m, { role: "assistant", content: final, reasoning: finalThinking || undefined }]);
                }
                assistantMsgAdded = true;
                commitTurn(ev.messages ?? (final ? [{ role: "assistant", content: final }] : []));
              }
              break;
          }
        }
        setStatus(hadError ? "erro" : "pronto");
      } catch (e) {
        hadError = true;
        const isAbort = (e instanceof Error && e.name === "AbortError") || /abort/i.test(String(e));
        const errMsg = isAbort ? "Operação cancelada pelo usuário" : (e instanceof Error ? e.message : String(e));
        if (!isAbort) {
          setError(errMsg);
          await log("error", `Stream failed: ${errMsg}`);
          setStatus("erro");
        } else {
          setStatus("cancelado");
        }
        if (!assistantMsgAdded) {
          assistantMsgAdded = true;
          const shown = accText || `[${errMsg}]`;
          setMessages((m) => [
            ...m,
            {
              role: "assistant",
              content: shown,
              reasoning: accThinking || undefined,
            },
          ]);
          // Partial tool calls of an interrupted turn are not kept (they could be left
          // without their results); the visible text is enough context for the next turn.
          commitTurn([{ role: "assistant", content: isAbort && accText ? `${accText}\n\n[interrompido pelo usuário]` : shown }]);
        }
      } finally {
        if (liveTimer) clearTimeout(liveTimer);
        questionRef.current?.reject(new Error("operação encerrada"));
        setQuestion(null);
        setStreaming(false);
        setLiveText("");
        abortRef.current = null;
      }
    },
    [config, model, reasoning, streaming, allTools, executeTool]
  );

  useInput((input, key) => {
    // Note: lastCtrlRef is set specifically by cycleReasoning/cycleMode (Ctrl+E/Ctrl+O) below,
    // not here for every Ctrl combo — otherwise Ctrl+C/Ctrl+V/etc. would also arm the 250ms
    // window in handleInputChange and silently eat a legitimately typed trailing o/e/c.
    if (streaming) {
      if (key.ctrl && (input.toLowerCase() === "c" || input === "\x03")) handleCancel();
      return;
    }
    if (key.ctrl && (input.toLowerCase() === "e" || input === "\x05")) { cycleReasoning(); return; }
    if (key.ctrl && (input.toLowerCase() === "o" || input === "\x0f")) { cycleMode(); return; }
    if (key.ctrl && (input.toLowerCase() === "c" || input === "\x03")) { handleCancel(); return; }
  });

  const totalTools = builtinToolsAsMcp().length + 1 + mcpCount;
  const systemTokens = estimateTokens(buildSystemPrompt(mode, config.system, skills, memoryPrompt));
  const historyTokens = estimateMessagesTokens(historyRef.current);
  const liveTokens = estimateTokens(input) + estimateTokens(liveText);
  const estimatedTotal = systemTokens + historyTokens + liveTokens;
  const totalTokens = Math.max(estimatedTotal, apiTokens);

  const sep = "-".repeat(Math.min(cols - 2, 80));
  // Logo and finished messages go to <Static>: Ink prints them once into the scrollback and
  // never redraws them. Keeping them in the live frame made it taller than the terminal,
  // and then Ink clears and repaints the whole screen on every streamed token (flicker).
  const staticItems: StaticItem[] = [
    { kind: "logo", key: "logo" },
    ...messages.map((m, i) => ({ kind: "message" as const, key: `m${i}`, message: m })),
  ];

  // Rows of the live frame other than the streamed text (separators, input, status bar,
  // log line, error, to-do list, question box), estimated on the high side.
  const statusBarRows = cols < 100 ? 3 : 2;
  const chromeRows =
    9 + statusBarRows +
    (error ? Math.ceil((error.length + 8) / Math.max(10, cols)) : 0) +
    (todos.length > 0 ? todos.length + 5 : 0) +
    (question ? 6 + (question.options?.length ?? 0) + Math.ceil(question.question.length / Math.max(10, cols - 4)) : 0);
  const liveMaxRows = Math.max(3, rows - chromeRows);

  return (
    <Box flexDirection="column">
      <Static key={staticGen} items={staticItems}>
        {(item) =>
          item.kind === "logo" ? (
            <Box key={item.key} flexDirection="column">
              <Text color={color} bold>{art}</Text>
              <Text dimColor>{sep}</Text>
            </Box>
          ) : (
            <MessageView key={item.key} message={item.message} />
          )
        }
      </Static>

      {messages.length === 0 && (
        <Text dimColor>Envie uma mensagem (Enter enviar | Ctrl+E pensamento | Ctrl+O modo | Ctrl+C sair)</Text>
      )}
      {streaming && liveText && (
        <Box flexDirection="column" marginBottom={1}>
          <LiveResponse text={liveText} cols={cols} maxRows={liveMaxRows} />
        </Box>
      )}

      {todos.length > 0 && (
        <Box flexDirection="column" marginY={1} borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">Tarefas (To-Do):</Text>
          {todos.map((t) => {
            const symbol =
              t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : t.status === "cancelled" ? "✗" : " ";
            const color =
              t.status === "completed" ? "green" : t.status === "in_progress" ? "cyan" : t.status === "cancelled" ? "gray" : "white";
            return (
              <Text key={t.id} color={color}>
                [{symbol}] {t.content}
              </Text>
            );
          })}
        </Box>
      )}

      {question && (
        <Box flexDirection="column" marginY={1} borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text bold color="magenta">Pergunta da IA:</Text>
          <MarkdownText>{question.question}</MarkdownText>
          {question.options?.map((opt, i) => (
            <Text key={i}>
              <Text color="yellow">{`  ${i + 1}. `}</Text>
              {opt}
            </Text>
          ))}
          <Text dimColor italic>
            {question.options?.length ? "Digite o número de uma opção ou uma resposta livre e tecle Enter." : "Digite sua resposta e tecle Enter."}
            {" (Ctrl+C cancela)"}
          </Text>
        </Box>
      )}

      <Text dimColor>{sep}</Text>
      <Box>
        <Text color="magenta" bold>{"> "}</Text>
        {!streaming || question ? (
          <TextInput
            value={input}
            onChange={handleInputChange}
            onSubmit={() => {
              if (question) answerQuestion(input);
              else if (input.trim()) send(input);
            }}
            placeholder={question ? "sua resposta..." : "digite para a LLM..."}
          />
        ) : (
          <Text dimColor italic>gerando resposta... (Ctrl+C cancela)</Text>
        )}
      </Box>

      <Text dimColor>{sep}</Text>
      <Box flexWrap="wrap">
        <Text><Text color="green" bold>Model:</Text> {model} </Text>
        <Text><Text color="magenta" bold>Reasoning:</Text> {reasoningLabel(reasoning, config.baseURL)} </Text>
        <Text><Text color="blue" bold>Mode:</Text> {modeLabel(mode)} </Text>
        <Text><Text color="yellow" bold>Tools:</Text> {totalTools} </Text>
        <Text><Text color="cyan" bold>Skills:</Text> {skills.length} </Text>
        <Text>
          <Text color="green" bold>Projeto:</Text>{" "}
          {project ? `${basename(project.root)} (${basename(project.markerPath)})` : "nenhum (memória de projeto off)"}{" "}
        </Text>
        <Text><Text color="red" bold>Tokens:</Text> {formatTokenCount(totalTokens)}</Text>
      </Box>
      <Text dimColor italic>{status} {totalTokens > 0 && `(${formatTokenCount(totalTokens)} tokens)`}</Text>
      {error && <Text color="red">[ERRO] {error}</Text>}
      <Text dimColor>log: {logFile().replace(/\\/g, "/")}</Text>
    </Box>
  );
};

export async function startApp(config: AppConfig, overrides: { model?: string; reasoning?: ReasoningLevel; mode?: Mode }) {
  clearScreen();
  const disableSync = enableSynchronizedOutput();
  try {
    // exitOnCtrlC must be off: with Ink's default, useInput never receives Ctrl+C, so the
    // app would exit instead of cancelling the current response.
    const app = render(<App config={config} overrides={overrides} />, { exitOnCtrlC: false });
    await app.waitUntilExit();
  } finally {
    disableSync();
    restoreTerminal();
  }
}
