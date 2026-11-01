import { select, input, password, editor, confirm } from "@inquirer/prompts";
import { saveConfig, defaultPreset, loadConfig, loadStoredConfig, isValid, configFile, configDir } from "./config.js";
import type { AppConfig, McpServerConfig, ReasoningLevel } from "./types.js";
import { isXiaomiMimoEndpoint, reasoningOptions } from "./reasoning.js";

const LABELS: Record<ReasoningLevel, string> = {
  none: "None (no reasoning)",
  low: "Low (fast)",
  medium: "Medium (balanced)",
  high: "High (deep)",
};

function validateUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function runSetup(existing: AppConfig | null): Promise<AppConfig> {
  console.clear();
  console.log("\n\x1b[35m✦ Setup Wizard\x1b[0m\n");

  const preset = defaultPreset();

  const baseURL = await input({
    message: "API base URL:",
    default: existing?.baseURL || preset.baseURL,
    validate: (v) => validateUrl(v) || "URL inválida. Use https://...",
  });

  let apiKey = "";
  if (existing?.apiKey) {
    const keep = await confirm({
      message: `Keep the existing API key (${existing.apiKey.slice(-4).padStart(existing.apiKey.length, "*")})?`,
      default: true,
    });
    if (keep) {
      apiKey = existing.apiKey;
    } else {
      apiKey = await password({ message: "API key:", mask: "*" });
    }
  } else {
    apiKey = await password({ message: "API key:", mask: "*" });
  }

  const model = await input({
    message: "Model ID:",
    default: existing?.model || "",
    validate: (v) => (v.trim() ? true : "Provide a model ID"),
  });

  const availableReasoning = reasoningOptions(baseURL);
  const defaultReasoning = existing?.reasoning && availableReasoning.includes(existing.reasoning)
    ? existing.reasoning
    : availableReasoning.includes("high") ? "high" : availableReasoning[0];
  const reasoning = (await select<ReasoningLevel>({
    message: "Default reasoning level:",
    default: defaultReasoning,
    choices: availableReasoning.map((l) => ({
      name: isXiaomiMimoEndpoint(baseURL)
        ? (l === "none" ? "off - thinking disabled" : "on - thinking enabled")
        : `${l} - ${LABELS[l]}`,
      value: l,
    })),
  })) as ReasoningLevel;

  const useSystem = await confirm({
    message: "Define an optional custom system prompt?",
    default: Boolean(existing?.system),
  });
  let system: string | undefined = undefined;
  if (useSystem) {
    try {
      if (existing?.system) {
        const reuse = await confirm({ message: "Reuse the existing system prompt?", default: true });
        if (reuse) {
          system = existing.system;
        } else {
          system = await editor({ message: "System prompt:", default: existing.system });
        }
      } else {
        system = await editor({ message: "System prompt:" });
      }
    } catch {
      system = await input({
        message: "System prompt (single line):",
        default: existing?.system ?? "",
      });
    }
  }

  const mcpServers: Record<string, McpServerConfig> = { ...(existing?.mcpServers ?? {}) };
  let addMcp = await confirm({
    message: "Add an MCP server now? (you can edit later)",
    default: false,
  });
  while (addMcp) {
    const name = await input({ message: "MCP server name:", validate: (v) => (v.trim() ? true : "required") });
    const command = await input({ message: "Command:", default: "npx", validate: (v) => (v.trim() ? true : "required") });
    const defaultFsPath = process.platform === "win32" ? "C:/" : "/";
    const argsRaw = await input({ message: "Arguments (space-separated):", default: `-y @modelcontextprotocol/server-filesystem ${defaultFsPath}` });
    mcpServers[name.trim()] = {
      command: command.trim(),
      args: argsRaw.trim() ? argsRaw.trim().split(/\s+/) : [],
    };
    addMcp = await confirm({ message: "Add another MCP server?", default: false });
  }

  const finalKey = (apiKey || (existing?.apiKey ?? "")).trim();

  const config: AppConfig = {
    baseURL: baseURL.trim(),
    apiKey: finalKey.trim(),
    model: model.trim(),
    reasoning,
    mode: existing?.mode ?? "programação",
    system: system?.trim() || undefined,
    mcpServers,
    hooks: existing?.hooks,
  };

  await saveConfig(config);
  console.log(`\n[OK] Config saved at ${configFile()}`);
  console.log(`      Directory: ${configDir()}\n`);
  return config;
}

export async function ensureConfig(): Promise<AppConfig> {
  const effective = await loadConfig();
  if (effective && isValid(effective)) {
    return effective;
  }
  // Edit the stored file only, so environment overrides are never persisted.
  return runSetup(await loadStoredConfig());
}
