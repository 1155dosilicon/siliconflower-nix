import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import type { McpServerConfig, McpTool } from "./types.js";
import { APP_VERSION } from "./version.js";
import { log } from "./logger.js";

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: McpTool[];
}

const MCP_CONNECT_TIMEOUT_MS = 20_000;
const MCP_CALL_TIMEOUT_MS = 120_000;

export interface McpConnectFailure {
  server: string;
  error: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number, serverName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout de ${ms / 1000}s ao conectar ao servidor MCP "${serverName}"`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export class McpManager {
  private servers = new Map<string, ConnectedServer>();
  private failures: McpConnectFailure[] = [];

  /**
   * Connects every configured server. Failures never throw: they are logged to the log
   * file and exposed via connectFailures() (writing to stderr would corrupt the Ink TUI).
   */
  async connectAll(config: Record<string, McpServerConfig> | undefined): Promise<McpTool[]> {
    this.failures = [];
    if (!config) return [];
    const entries = Object.entries(config);
    const results = await Promise.allSettled(
      entries.map(async ([name, cfg]) => this.connect(name, cfg))
    );
    for (const [i, r] of results.entries()) {
      if (r.status === "rejected") {
        const server = entries[i]?.[0] ?? "?";
        const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
        this.failures.push({ server, error });
        await log("error", `[MCP] falha ao conectar "${server}": ${error}`);
      }
    }
    return this.allTools();
  }

  connectFailures(): McpConnectFailure[] {
    return [...this.failures];
  }

  private async connect(name: string, cfg: McpServerConfig): Promise<void> {
    const rawEnv = { ...process.env, ...(cfg.env ?? {}) };
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawEnv)) {
      if (v !== undefined && v !== null) {
        cleanEnv[k] = String(v);
      }
    }

    let resolvedCommand = cfg.command;
    if (typeof Bun !== "undefined" && typeof (Bun as any).which === "function") {
      const found = (Bun as any).which(resolvedCommand);
      if (found) {
        resolvedCommand = found;
      } else if (resolvedCommand === "npx" && (Bun as any).which("bunx")) {
        resolvedCommand = (Bun as any).which("bunx")!;
      }
    }

    const transport = new StdioClientTransport({
      command: resolvedCommand,
      args: cfg.args ?? [],
      env: cleanEnv,
    });
    const client = new Client(
      { name: "siliconflower", version: APP_VERSION },
      { capabilities: {} }
    );
    try {
      await withTimeout(client.connect(transport), MCP_CONNECT_TIMEOUT_MS, name);
    } catch (err) {
      // client.connect() already spawned the child process; if the handshake fails
      // or times out, close the transport so we don't leak an orphan process.
      await transport.close().catch(() => {});
      throw err;
    }
    let toolList: McpTool[] = [];
    try {
      const res = await client.listTools();
      toolList = (res.tools ?? []).map((t) => ({
        server: name,
        name: qualifyMcpToolName(name, t.name),
        originalName: t.name,
        description: t.description,
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      }));
    } catch {
      toolList = [];
    }
    this.servers.set(name, { name, client, transport, tools: toolList });
  }

  allTools(): McpTool[] {
    const out: McpTool[] = [];
    const seen = new Set<string>();
    for (const s of this.servers.values()) {
      for (const tool of s.tools) {
        if (seen.has(tool.name)) {
          void log("warn", `[MCP] ferramenta qualificada duplicada ignorada: "${tool.name}"`);
          continue;
        }
        seen.add(tool.name);
        out.push(tool);
      }
    }
    return out;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ result: string; isError: boolean }> {
    for (const s of this.servers.values()) {
      const tool = s.tools.find((t) => t.name === name);
      if (!tool) continue;
      const res = await s.client.callTool(
        { name: tool.originalName ?? tool.name, arguments: args },
        undefined,
        { signal, timeout: MCP_CALL_TIMEOUT_MS }
      );
      const content = (res.content as unknown[]) ?? [];
      const text = content
        .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : JSON.stringify(c)))
        .join("\n");
      // MCP servers report tool failures in-band via `isError`, not by rejecting the call.
      return { result: text || "(empty content)", isError: res.isError === true };
    }
    throw new Error(`tool not found: ${name}`);
  }

  serverCount(): number {
    return this.servers.size;
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.servers.values()].map(async (s) => {
        try {
          await s.transport.close();
        } catch {
          /* ignore */
        }
      })
    );
    this.servers.clear();
  }
}

export function qualifyMcpToolName(server: string, tool: string): string {
  const slug = (value: string, max: number) =>
    value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "").slice(0, max) || "unnamed";
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return `mcp_${slug(server, 14)}_${slug(tool, 30)}_${hash}`;
}
