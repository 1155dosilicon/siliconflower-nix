# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Suporte a Linux/Unix (`src/platform.ts` e adaptadores):** O Siliconflower agora roda em Windows, Linux e macOS/Unix. Shell padrão: PowerShell no Windows; `$SHELL` (ou `/bin/bash`) em Unix. `execute_command`, hooks e background tasks usam a plataforma atual. Encerramento de processos usa `taskkill` no Windows e sinais de processo em Unix. Skills embutidas incluem `unix-backup.md` e `unix-system.md` (as skills `windows-*` só são sincronizadas no Windows).
- **Build e instalação multiplataforma (`build.ts`, `scripts/install.sh`, `scripts/install-bin.js`):** `bun run build` gera `dist/siliconflower` no Linux/macOS ou `dist/siliconflower.exe` no Windows conforme a plataforma. `npm run install:bin` roteia para `scripts/install.sh` (`~/.local/bin`) em Unix e `scripts/install.ps1` no Windows. `package.json` aceita `win32`, `darwin` e `linux`.

### Changed
- **Persona e prompts de modo (`src/modes.ts`):** Identificam o SO e o shell ativos em vez de assumir Windows/PowerShell. O modo `sistema` foca em systemd/pacotes/shell em Unix e mantém PowerShell/registro no Windows.
- **Testes e documentação:** Suíte de testes cross-platform; `README.md`, `LLMS.md` e `SECURITY.md` descrevem Windows, Linux e macOS/Unix.

## [0.2.6] - 2026-10-17

### Added
- **Controle de pensamento Xiaomi MiMo:** Endpoints oficiais `xiaomimimo.com` agora oferecem o pensamento como opção ligado/desligado no assistente e em `Ctrl+E`. As requisições enviam `thinking.type` e preservam `reasoning_content` na continuação de chamadas de ferramentas; os demais endpoints compatíveis com OpenAI mantêm os níveis de `reasoning_effort`.

## [0.2.5] - 2026-08-23

### Removed
- **Anthropic API Support (`src/llm.ts`, `src/config.ts`, `src/types.ts`, `src/wizard.ts`, `src/index.tsx`, `build.ts`):** Dropped the Anthropic provider branch entirely, along with the `@anthropic-ai/sdk` dependency, the `anthropic` preset, the `--provider` CLI flag and the wizard provider prompt. `src/llm.ts` now carries a single OpenAI-compatible streaming adapter.
- **`provider` Config Field (`src/types.ts`, `src/config.ts`, `src/wizard.ts`):** With a single supported API variant the field carried no information and was removed from `AppConfig`. A legacy `"provider"` key in `config.json` is ignored on load and dropped on the next save; `presets()` collapsed into `defaultPreset()`. Users previously on Anthropic must repoint `baseURL`/`model` at an OpenAI-compatible endpoint.

### Added
- **Terminal Viewport & Native Mouse Scroll (`src/terminal.ts`, `src/App.tsx`, `src/index.tsx`):** Added robust terminal viewport clearing (`\x1b[2J\x1b[3J\x1b[H`) and cursor lifecycle management in the primary buffer, matching Claude Code. Starts with a clean screen without initial prompt residue while preserving full native mouse-wheel scrollback throughout the session.

### Fixed
- **Web Fetch SSRF False Positives (`src/services/web.ts`):** Corrected `isPrivateAddress` range check that previously classified all `192.0.x.x` public IPs (e.g. Automattic/WordPress VIP CDN used by TechCrunch, MIT Tech Review) as private. Added exact RFC 6890 / RFC 5737 matching for `192.0.0.0/24` and `192.0.2.0/24` while allowing legitimate public IPs.
- **Web Search Parser & Anti-Bot Protection (`src/services/web.ts`, `src/tools.ts`):** Updated DuckDuckGo HTML parser to support arbitrary attribute ordering (e.g. `rel="nofollow" class="result__a"`), added fallback regex scanning for `uddg=` redirect links, HTTP 202 anti-bot challenge handling, and context cancellation support (`ctx.signal`).
- **Web Fetch HTML to Markdown Formatting (`src/services/web.ts`):** Upgraded `htmlToMarkdown` with cleaner tag stripping (`<noscript>`, `<svg>`, `<canvas>`, `<iframe>`), code blocks formatting (`<pre><code>`), blockquotes (`>`), bold/italics, and comprehensive HTML entity decoding.
- **MCP Command Binary Resolution (`src/mcp.ts`):** Added automatic command binary resolution for Bun on Windows, allowing `bunx` to seamlessly execute MCP packages even when configurations specify `npx`.
- **Context Compaction Protocol Safety (`src/context.ts`):** `compressHistory` could drop only the `assistant` half of a tool-call turn while discarding the oldest messages, leaving an orphan `tool` message at the front of the history and causing HTTP 400 errors from the OpenAI/Anthropic APIs on long tool-heavy sessions. Turns are now discarded as a whole unit.
- **Raw History Truncation Bypassing Compaction (`src/App.tsx`):** The TUI was slicing the last 60 messages before handing history to `streamChat`, silently discarding everything older regardless of token budget and defeating the token-aware compaction in `compressHistory`. The full history is now passed through.
- **`grep_content` Path-Based Include Filters (`src/grep.ts`):** The `include` glob only matched against a bare filename, so patterns with a path segment (e.g. `src/**/*.tsx`) never matched anything. Now reuses the real glob-to-regex engine from `src/glob-util.ts` (also exported for reuse) against the path relative to `basePath`.
- **MCP Connection Leaks and Hangs (`src/mcp.ts`):** A failed MCP server handshake left its child process running (the transport was never closed), and there was no connection timeout, so a hung MCP server blocked app startup indefinitely. Added a 20s connect timeout and transport cleanup on failure.
- **Permanent Logging Disable on Transient I/O Error (`src/logger.ts`):** A single failed attempt to create the log directory (e.g. a transient permission/AV lock) marked logging as "ensured" forever, silently disabling all future logs, including errors. Failures are no longer cached, so logging retries on the next call.
- **Silent Hooks Config Fallback (`src/core/hooks.ts`):** Invalid JSON in a `hooks.json` file was indistinguishable from a missing file and silently fell back to the next source (legacy/global) without any warning. Now logs a warning when a hooks file exists but fails to parse.
- **Overzealous Ctrl-Key Input Suppression (`src/App.tsx`):** The 250ms window that strips a trailing `o`/`e`/`c` character after `Ctrl+O`/`Ctrl+E` (to swallow terminal-echoed shortcut chars) was being armed by *any* Ctrl combination (e.g. `Ctrl+C`, `Ctrl+V`), which could silently eat a legitimately typed character right after an unrelated shortcut.
- **Unhandled CLI Startup Rejection (`src/index.tsx`):** `program.parseAsync()` had no `.catch()`, so a failure during config load/setup produced an unhandled promise rejection instead of a clean error message and exit code.
- **Unbounded Background Task / Subagent Session Growth (`src/services/background-tasks.ts`, `src/services/subagent.ts`):** Finished background tasks and subagent sessions (including full message history) were never removed from their in-memory maps, growing without bound over long-lived sessions. Both are now capped, pruning the oldest finished/least-recent entries.
- **Silent Wrong-Block Edits in Fuzzy Whitespace Matching (`src/services/smart-edit.ts`):** `edit_file`'s fuzzy whitespace-matching strategy applied the edit to the first matching block without checking for other identical blocks elsewhere in the file. It now detects multiple matches and reports an ambiguity error unless `replaceAll: true` is set (which now correctly replaces every occurrence instead of only the first).

### Removed
- **Dead Compatibility Shim (`src/task.ts`):** Removed the unused `runSubagentTask` re-export wrapper around `src/services/subagent.ts` — nothing in the codebase imported it anymore. Updated `LLMS.md` accordingly.

## [0.2.4] - 2026-08-18

### Fixed
- **Anthropic Streaming Tools:** Reconstructed tool arguments from `input_json_delta` events instead of invoking tools with the empty object from `content_block_start`.
- **Plan Mode Isolation:** Replaced the partial mutation blocklist with a closed read-only allowlist; MCP tools, hooks, subagents, persistence and background cancellation can no longer bypass plan mode.
- **Cancellation and Timeouts:** Propagated abort signals to LLM requests, commands, web fetches and subagents. Cancellable operations are actively aborted; filesystem operations without cancellation support are awaited instead of falsely reporting a timeout while continuing silently.
- **Background Task State:** Killing a subagent now aborts its execution, and late completion/error callbacks can no longer overwrite the `killed` state. Subagent failures are reported as failures.
- **MCP Tool Collisions:** Added deterministic qualified MCP tool names and preserved original transport names for dispatch.
- **Context Bounds:** Large single-line outputs and recent oversized messages are bounded by character/token budgets.
- **Scoped Deletion:** Memory and artifact deletion now defaults to project scope and requires explicit `global` or `all` scope for broader removal.
- **Hooks:** Standardized hook execution on PowerShell, added file path context, edit coverage and session lifecycle hooks.
- **Web Fetch:** Applied timeout to response bodies, bounded streaming reads, validated redirects and blocked private/reserved network targets.
- **Worktrees and Launcher:** Removed shell interpolation from Git/attrib operations and from the Node launcher; `tsx` is now a runtime dependency for the documented Node fallback.
- **Hermetic Tests:** Redirected persistent data to a temporary directory during tests and added regression coverage for LLM streaming, plan policy, MCP names, scopes, cancellation, SSRF and context truncation.

### Added
- **Centralized Workspace Data Storage (`~/.siliconflower/workspaces/<workspace-id>/`):** Replaced in-tree `.siliconflower` folder creation inside user project directories with deterministic, centralized workspace data storage located in `~/.siliconflower/workspaces/<workspace-id>/` (mirroring Antigravity and modern AI harness conventions). Project workspaces now remain 100% clean and free of visible config/cache directories.
- **Workspace ID Computation (`src/fs-util.ts`):** Added `getWorkspaceId(cwd)` and `getWorkspaceDataDir(cwd)` helpers generating consistent, filesystem-safe slugs with short SHA-256 hashes.
- **Backward-Compatible Legacy Data Discovery:** Maintained full backward compatibility across `recallMemories`, `forgetMemory`, `listArtifacts`, `readArtifact`, `deleteArtifact`, and `loadHooksConfig` so existing repositories with legacy `.siliconflower` folders continue to resolve seamlessly.

### Changed
- **Windows-Only Focus & Simplification:** Removed Linux and macOS compatibility layers, platform branching, and bash fallback logic across `src/modes.ts`, `src/tools.ts`, `src/fs-util.ts`, `src/services/background-tasks.ts`, and test suites. Siliconflower is now centered exclusively on Windows (PowerShell/Bun/Node).
- **Documentation & CLI:** Updated `README.md`, `LLMS.md`, and `siliconflower show` command to display the active workspace ID and data directory path.

## [0.2.3] - 2026-08-16

### Fixed
- **Anthropic Batch Tool Results Streaming (`src/llm.ts`):** Fixed Anthropic API HTTP 400 Bad Request error caused by parallel tool call results pushing multiple consecutive `{ role: "user" }` messages during streaming loops. Now all tool results are aggregated into a single user message with content blocks, strictly satisfying Anthropic's role alternation protocol.
- **Artifact Exact Matching & Deduplication (`src/services/artifact.ts`):** Fixed prefix collision bug where short artifact IDs matched longer IDs (e.g., `report` matching `report_analysis.md`). Added path deduplication when the workspace is located at user home root.
- **Memory Service Deduplication (`src/services/memory.ts`):** Added directory deduplication in `recallMemories` when project root matches user home.
- **Subagent Session Tracking & Unification (`src/task.ts` & `src/services/subagent.ts`):** Unified subagent invocation by delegating `runSubagentTask` in `src/task.ts` to the comprehensive `src/services/subagent.ts` pipeline, preserving session registration and background tracking. Replaced deprecated `.substr()` usage with `.slice()`.
- **Config & Wizard State Preservation (`src/config.ts` & `src/wizard.ts`):** Fixed `normalize()` dropping `hooks` settings, added normalization for unaccented mode variants (`"programacao"`, `"prog"`), and preserved existing `mode` and `hooks` settings during wizard re-configuration.
- **Plan Mode Modifying Tools Guard (`src/App.tsx`):** Expanded the modification guard in `plano` mode to encompass `move_path`, `create_directory`, `delete_artifact`, `forget_memory`, and `exit_worktree`.

### Added
- **Comprehensive Test Suites:** Added new test suites covering Smart Edit (`tests/smart-edit.test.ts`), RepoMap (`tests/repomap.test.ts`), Persistent Memory (`tests/memory.test.ts`), Subagents (`tests/subagent.test.ts`), and Config Normalization (`tests/config.test.ts`).
- **Complete Native Tools Documentation (`README.md` & `LLMS.md`):** Documented all 34 native tools, subagents architecture, memory scopes, Git worktrees, and lifecycle hooks.

## [0.2.2] - 2026-08-14

### Fixed
- **Artifact Type and Metadata Resolution (`src/services/artifact.ts`):** Fixed a bug in `listArtifacts` where non-markdown artifacts (like `.html`, `.json`, `.txt`) were incorrectly categorized as `"markdown"` because they lacked frontmatter headers. Resolved by dynamically inferring the correct type based on the file extension and parsing `updatedAt` from frontmatter metadata when present.

### Added
- **Artifact Type Verification Tests (`tests/artifact.test.ts`):** Added a new suite of integration tests to verify successful creation, type resolution, and list integration of HTML and JSON artifacts.
- **Git Worktree Testing (`tests/worktree.test.ts`):** Added a new test suite to cover the `listWorktrees` service in any active git repository environment, raising overall test coverage and reliability.

## [0.2.1] - 2026-08-12

### Fixed
- **OpenAI Tool Call History (`src/llm.ts`):** Preserved `toolCalls` metadata on assistant messages during OpenAI API payload conversion, fixing HTTP 400 `tool_call_id` mismatch errors in multi-turn history.
- **Anthropic Message Role Alternation (`src/llm.ts`):** Fixed message role sequence builder for Anthropic API by merging consecutive tool results into the preceding user message to satisfy role alternation requirements.
- **Grep Regex Syntax Error Fallback (`src/grep.ts`):** Added `SyntaxError` fallback to literal string matching when unescaped regex special characters are supplied to `grep_content`.
- **Config Enum Normalization (`src/config.ts`):** Added strict validation against `REASONING_LEVELS` and `MODES` in config normalization.
- **Anthropic Stream Connection Resolution (`src/llm.ts`):** Enhanced connection promise event listeners to prevent hanging on rapid stream completion or early aborts.
- **Event Listener Cleanup (`src/llm.ts`):** Fixed memory leak in `withConnectTimeout` by detaching `abort` signal listeners on Promise completion.
- **Tool Parameter Coercion (`src/tools.ts`):** Coerced stringified numeric arguments for `read_file`, `read_logs`, and `execute_command`.
- **Tool Timeout Alignment (`src/tools.ts`):** Dynamically scaled `runBuiltin` timeout when custom command timeouts are specified for `execute_command`.
- **Empty `oldText` Prevention (`src/tools.ts`):** Guarded `edit_file` and `apply_patch` against empty string replacements.
- **To-Do Status Normalization (`src/tools.ts`):** Added automatic mapping for LLM status/priority synonyms (`done`, `in-progress`, etc.) in `todowrite`.
- **Subagent Context Propagation (`src/task.ts`):** Passed `ToolContext` with app configuration to subagent tool executions.
- **Cross-Platform OS Prompts (`src/modes.ts`):** Dynamically generated system prompts matching the current host operating system (`process.platform`).
- **Log Rotation Concurrency Lock (`src/logger.ts`):** Added rotation lock to prevent file truncation race conditions.
- **MCP Env Type Safety (`src/mcp.ts`):** Sanitized environment variables passed to stdio transport processes.

## [0.2.0] - 2026-08-11

### Added
- **Live Token Counter (`Tokens:` in TUI):** Real-time session token counter in the TUI status bar and execution status (`🧠 pensando...`, `🔨 tool_name...`), combining live local token estimation with official API stream usage metadata (`stream_options: { include_usage: true }`).
- **Context & Token Management (`src/context.ts`):** Added token estimation (`estimateTokens`), message context compression (`compressHistory`), and large output persistence (`processToolOutput`), automatically writing large command/file outputs to `~/.siliconflower/outputs/` to protect LLM context windows.
- **Content Search Tool (`grep_content`):** Native recursive text and regex file content search tool with line numbers (`file:line: content`).
- **Read File Line Ranges (`read_file`):** Added `offset` (start line) and `limit` parameters to `read_file`, formatting lines with numbers (`1: content`).
- **Atomic Patch Applicator (`apply_patch`):** Added support for multi-block text replacement patches.
- **Subagent Task Runner (`run_task` & `src/task.ts`):** Allows delegating sub-tasks to an isolated sub-agent with its own prompt and context, returning a concise summary.
- **To-Do List Tracking (`todowrite` & `src/todo.ts`):** Native tool and interactive TUI panel displaying session task progress (`[✓]`, `[▶]`, `[ ]`).
- **Plan Mode (`plano`):** Added `plano` mode (cycling via `Ctrl+O`: `PROG` -> `SISTEMA` -> `PLANO`), blocking modifying tools until a plan is presented to the user.
- **User Question Tool (`ask_question`):** Tool for requesting decisions or clarifications directly from the user.
- **Markdown & Code Rendering (`src/MarkdownText.tsx`):** Clean Windows-compatible Markdown renderer for headers, code blocks, bold/italic, and bullet lists in the TUI.
- **Log Management & Inspection (`read_logs` & `src/logger.ts`):** Auto-rotation at 200 KB, CLI filtering (`siliconflower logs --level error --search keyword --clear`), and native `read_logs` tool for focused LLM error diagnostics.
- **LLM Agent Guide (`LLMS.md`):** Added a dedicated project architecture and context guide for future LLM agents, detailing what files to read and what directories to ignore.

### Fixed
- **Shortcut Input Handler:** Fixed `Ctrl+O` and `Ctrl+E` keyboard event handling in Windows Terminal / PowerShell to prevent trailing shortcut characters (`'o'`, `'e'`) from polluting the input field.
- **Tool Call Loop Limit:** Expanded step limit from 8 to 25 tool calls per user turn with infinite loop guard protection.

## [0.1.0] - 2026-07-15

### Added

- First public release.
- TUI (ink/React) with transcript, status bar, logo, and animated cursor.
- Native file-system tools: `read_file`, `write_file`, `edit_file`,
  `list_directory`, `create_directory`, `move_path`, `file_info`,
  `search_files`, `delete_path` (with `confirm=true` guard for recursive
  deletes).
- MCP stdio client manager; tools merged with natives, loop of up to 8
  tool-call steps per assistant turn.
- OpenAI-compatible and Anthropic streaming adapters with reasoning
  control (`reasoning_effort` / `thinking` + `budget_tokens`).
- Skills: bundled `.md` examples, `read_skill` tool, `skills sync` command.
- Modes (`programacao` / `sistema`) with system-prompt focus variants.
- Logging with automatic 1 MB rotation; `logs` command to tail history.
- Standalone Windows build via `bun build --compile` (shim for
  `react-devtools-core`, single-binary distribution).
- PowerShell installer (`scripts/install.ps1`) that adds the binary to the
  user PATH without admin.
- First-run wizard with provider presets for SiliconFlow, OpenRouter,
  OpenAI, and Anthropic.

[Unreleased]: https://github.com/siliconflower/siliconflower/compare/siliconflower-0.2.6...HEAD
[0.2.6]: https://github.com/siliconflower/siliconflower/compare/0.2.5...siliconflower-0.2.6
[0.2.5]: https://github.com/siliconflower/siliconflower/compare/0.2.4...0.2.5
[0.2.4]: https://github.com/siliconflower/siliconflower/compare/0.2.3...0.2.4
[0.2.3]: https://github.com/siliconflower/siliconflower/compare/0.2.2...0.2.3
[0.2.2]: https://github.com/siliconflower/siliconflower/compare/0.2.1...0.2.2
[0.2.1]: https://github.com/siliconflower/siliconflower/compare/0.1.0...0.2.1
[0.1.0]: https://github.com/siliconflower/siliconflower/releases/tag/0.1.0
