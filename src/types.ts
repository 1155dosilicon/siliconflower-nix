export type ReasoningLevel = "none" | "low" | "medium" | "high";
export type Mode = "programação" | "sistema" | "plano";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AppConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  reasoning: ReasoningLevel;
  mode?: Mode;
  system?: string;
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: {
    preTool?: string;
    postTool?: string;
    onEdit?: string;
    onCommand?: string;
    onSessionStart?: string;
    onSessionEnd?: string;
  };
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  toolName?: string;
  toolCallId?: string;
  toolCalls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
}

export type StreamEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: string }
  | { type: "tool_result"; id: string; name: string; result: string; isError: boolean }
  | { type: "usage"; totalTokens?: number; promptTokens?: number; completionTokens?: number }
  | { type: "error"; message: string }
  /** `messages` holds the messages produced in this turn (tool calls, tool results, final answer). */
  | { type: "done"; content: string; reasoning: string; messages?: ChatMessage[] };

export interface McpTool {
  server: string;
  name: string;
  originalName?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export const REASONING_LEVELS: ReasoningLevel[] = ["none", "low", "medium", "high"];
