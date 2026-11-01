# Siliconflower — guia para agentes

Agente de IA em CLI/TUI para Windows, Linux e macOS/Unix: TypeScript + Bun + Ink/React, sobre APIs compatíveis com OpenAI.
Textos para o usuário, prompts e docs ficam em pt-BR. Logs e campos de protocolo ficam em ASCII.

## Comandos

```bash
bun install
bun run typecheck   # precisa passar limpo
bun test            # roda o shell real da plataforma; usa SILICONFLOWER_DATA_DIR temporário (tests/setup.ts)
bun run build       # gera dist/siliconflower (Linux/macOS) ou dist/siliconflower.exe (Windows)
npm run install:bin # Unix: copia para ~/.local/bin; Windows: %LOCALAPPDATA%\Programs\siliconflower + PATH
bun start           # roda a partir do código-fonte
```

Antes de dar uma tarefa por concluída: `bun run typecheck` e `bun test`.

## Mapa do código

- `src/index.tsx`: CLI (commander). `config.ts`/`wizard.ts`: configuração.
- `src/App.tsx`: TUI, histórico da API (`historyRef`), despacho de ferramentas e `ask_question`.
- `src/llm.ts`: loop de streaming e ferramentas (até 50 passos), compactação por passo, fallbacks de parâmetros. `context.ts`: compactação e truncamento de saídas.
- `src/tools.ts`: ferramentas nativas (schema + `run`). `read_skill` fica em `skills.ts`. `tool-policy.ts`: allowlist do modo `plano`.
- `src/shell.ts`: toda execução de shell (PowerShell no Windows, `$SHELL -c` em Unix). `platform.ts`: detecção de SO e shell padrão. `project.ts`: detecção de projeto (`SILICONFLOWER.md`/`AGENTS.md`).
- `src/services/`: memória, subagentes, tarefas em background, web, artefatos, worktrees, repomap, smart-edit.
- `src/core/hooks.ts`: hooks. `mcp.ts`: cliente MCP.

## Regras (cada uma já causou bug)

- **Shell só via `src/shell.ts`** (`runShell`/`startShell`). `exec`/`execFile` com PowerShell quebra acentos (CP850) e carrega o `$PROFILE`; em qualquer SO, matar só o processo pai deixa filhos órfãos (Windows usa `taskkill /T`, Unix mata o grupo de processos).
- **Código específico de SO** passa por `src/platform.ts` (`isWindows()`); testes que dependem do shell devem cobrir os dois lados.
- **Nada de `process.stdout`/`stderr.write` com a TUI aberta**: isso corrompe o Ink. Use `log()` de `logger.ts`, que nunca lança exceção.
- **Ferramenta nova**:
  - schema e `run` em `tools.ts`;
  - decida se entra na allowlist de `tool-policy.ts` (fora dela, fica bloqueada no modo `plano`);
  - honre `ctx.signal` se puder demorar;
  - só entra em `CANCELLABLE_BUILTINS`, que impõe timeout fixo, se nunca rodar por mais de ~1 min;
  - devolva `isError: true` em qualquer falha.
- **Histórico da API**: toda mensagem `assistant` com `toolCalls` vem seguida dos resultados `tool` correspondentes. Nunca guarde um turno incompleto (veja `done.messages` em `llm.ts`).
- **Config**: `loadConfig()` aplica as variáveis de ambiente e serve só para execução. Para editar ou salvar, use `loadStoredConfig()`.
- **Dados por projeto**: use `getWorkspaceDataDir(cwd)`, que resolve a raiz do projeto. Não grave arquivos na pasta do usuário sem ele pedir.
- **Argumentos do modelo não são confiáveis**: caminhos passam por `isPathBlockedSafe`, números por clamp.
- **`render(..., { exitOnCtrlC: false })` em `App.tsx` é intencional**: sem isso, `Ctrl+C` fecha o app em vez de cancelar.
- **A TUI desenha a conversa inteira no quadro dinâmico do Ink (escolha intencional)**: quando o quadro passa da altura do terminal, o Ink redesenha a tela toda a cada atualização. Em terminais com saída sincronizada (DEC 2026) isso não aparece; em terminais sem ela (ex.: VTE), pisca. Não troque por `<Static>`/corte da resposta sem o dono do projeto pedir.
- **Repaint após redimensionar (`App.tsx`) é intencional**: o Ink sozinho deixa restos de quadros antigos quando o terminal refaz a quebra das linhas. `tests/tui-resize.test.ts` reproduz isso num emulador (xterm headless); mudanças de layout da TUI devem passar nele.
- **Versão**: `package.json` e `src/version.ts` mudam juntos (`tests/version.test.ts` verifica).

## Ao mudar comportamento

- Teste em `tests/`. Regressões de bugs vão em `tests/regressions.test.ts`.
- `CHANGELOG.md`: uma linha por item em `[Unreleased]`.
- `README.md` se a mudança afeta quem usa; `docs/ARCHITECTURE.md` se afeta fluxo ou arquitetura; `SECURITY.md` se afeta garantias de segurança.
- Contagens (número de ferramentas etc.) aparecem só no README.

## Referência

`docs/ARCHITECTURE.md` cobre o fluxo de uma mensagem, provedores e raciocínio, projetos e memória, hooks, modo `plano`, MCP e a tabela de ferramentas. Para o detalhe de cada ferramenta, os schemas em `src/tools.ts` são a fonte.
