# LLMS.md — Siliconflower Architecture & Developer Guide

Este documento serve como mapa arquitetural e guia de desenvolvimento do **Siliconflower** para Modelos de Linguagem (LLMs) e desenvolvedores.

---

## 🏗️ Visão Geral da Arquitetura

O Siliconflower é um harness CLI/TUI autônomo para desenvolvimento de software, projetado para Windows, Linux e macOS/Unix (PowerShell/bash/sh + Bun/Node), operando sobre APIs compatíveis com OpenAI (SiliconFlow, OpenRouter, OpenAI, ...).

```text
src/
├── core/                  # Núcleo de Hooks e ciclo de vida
│   └── hooks.ts           # Hooks de eventos de ferramenta, edição, comando e sessão
│
├── services/              # Serviços de Especialização do Agente
│   ├── artifact.ts        # Gestão de entregáveis e artefatos (~/.siliconflower/workspaces/<id>/artifacts/)
│   ├── background-tasks.ts# Gerenciador de tarefas assíncronas e comandos em background
│   ├── memory.ts          # Memória persistente (~/.siliconflower/workspaces/<id>/memory/)
│   ├── repomap.ts         # Gerador de RepoMap e extração/busca de símbolos no código
│   ├── smart-edit.ts      # Edição inteligente de arquivos (fuzzy/newline/exact)
│   ├── subagent.ts        # Orquestrador de subagentes especializados e sessões
│   ├── web.ts             # Busca web nativa e conversão de HTML para Markdown
│   └── worktree.ts        # Gerenciador de Git Worktrees isolados
│
├── App.tsx                # Componente TUI principal da aplicação (Ink/React)
├── MarkdownText.tsx       # Renderizador de Markdown adaptado para terminal
├── ascii.ts               # Arte ASCII e logotipo
├── config.ts              # Gerenciamento de configurações em ~/.siliconflower/config.json
├── context.ts             # Janela de contexto, histórico e compactação inteligente
├── fs-util.ts             # Utilitários de sistema de arquivos, workspace IDs e segurança de caminhos
├── glob-util.ts           # Busca por padrões globais de arquivos
├── grep.ts                # Mecanismo de busca textual e regex recursiva
├── index.tsx              # Ponto de entrada CLI (Commander)
├── llm.ts                 # Cliente de chamadas e streaming para APIs compatíveis com OpenAI
├── logger.ts              # Sistema de logs com limite de 200 KB e retenção das 500 linhas finais
├── mcp.ts                 # Cliente para servidores MCP (Model Context Protocol) via stdio
├── modes.ts               # Modos de operação (programação, sistema, plano)
├── reasoning.ts           # Detecção do endpoint Xiaomi MiMo e opções de raciocínio
├── tool-policy.ts         # Política fechada de ferramentas permitidas no modo plano
├── version.ts             # APP_VERSION usado pelo CLI e cliente MCP
├── skills.ts              # Carregador e executor de skills (.md)
├── terminal.ts            # Gerenciador de viewport, limpeza de tela e ciclo de vida do terminal
├── todo.ts                # Gerenciador de lista de tarefas na sessão
├── tools.ts               # Definição e registro de 33 ferramentas nativas
├── types.ts               # Interfaces e tipos globais do TypeScript
└── wizard.ts              # Assistente interativo de configuração inicial
```

## Fluxo de uma interação

1. `src/index.tsx` carrega a configuração, aplica as variáveis de ambiente e as opções da CLI e inicia a TUI.
2. `src/App.tsx` carrega as skills e tenta conectar os servidores MCP configurados. Falhas de conexão MCP geram avisos e não impedem o uso das ferramentas nativas.
3. A cada mensagem do usuário, a TUI monta o prompt de sistema com persona, foco do modo, memórias, prompt personalizado, nomes das skills disponíveis e diretório atual.
4. `src/llm.ts` compacta o histórico, abre o streaming compatível com OpenAI e executa chamadas de ferramentas. O ciclo aceita até 50 respostas do modelo por mensagem; cada resposta pode incluir múltiplas chamadas sequenciais.
5. O histórico da conversa fica em memória durante a sessão. Quando supera 90 mil tokens estimados ou 40 mensagens, `src/context.ts` reduz conteúdo antigo e mantém válida a ordem entre chamadas e resultados de ferramentas.

Saídas de ferramentas maiores que 32 mil caracteres são reduzidas para o contexto; o conteúdo completo é salvo em `~/.siliconflower/outputs/` quando possível. A resposta informa o caminho do arquivo.

## Onde fazer mudanças

- **Schemas e execução das ferramentas nativas:** `src/tools.ts`. A skill `read_skill` e seu schema ficam em `src/skills.ts`. Mantenha schemas e validação alinhados.
- **Política de ferramentas do modo `plano`:** `src/tool-policy.ts` e a checagem de despacho em `src/App.tsx`. Revise ambos ao adicionar uma ferramenta; ferramentas desconhecidas e MCP ficam bloqueadas nesse modo por padrão.
- **Formato da API, streaming e continuação de chamadas:** `src/llm.ts`; detecção de endpoint e opções específicas de raciocínio: `src/reasoning.ts`.
- **Configuração persistida e compatibilidade de valores antigos:** `src/config.ts`, `src/types.ts`, `src/wizard.ts` e `src/index.tsx`.
- **Versão do executável e cliente MCP:** `src/version.ts`. Mantenha também `package.json` na mesma versão ao preparar uma versão nova.
- **Comportamento alterado:** atualize os testes relacionados e registre a mudança em `CHANGELOG.md`; ajuste este guia e `README.md` quando a mudança afetar usuários ou a arquitetura.

Os schemas de argumentos em `src/tools.ts` são a referência mais precisa para cada ferramenta. A tabela abaixo resume responsabilidades, não substitui a leitura do schema e da implementação antes de mudar seu comportamento.

### Provedores e raciocínio

O adaptador `src/llm.ts` usa a API de Chat Completions compatível com OpenAI para todos os provedores. `src/reasoning.ts` identifica endpoints cujo hostname é `xiaomimimo.com` ou termina em `.xiaomimimo.com`; para eles, `none` significa pensamento desligado e `high` ligado. O payload recebe `thinking.type` (`disabled` ou `enabled`) e o conteúdo `reasoning_content` é preservado na mensagem de assistant que precede chamadas de ferramentas. Para outros endpoints, `low`, `medium` e `high` são enviados como `reasoning_effort` quando aplicável; se o provedor rejeitar esse campo, o adaptador tenta novamente sem ele.

O atalho `Ctrl+E` percorre os quatro níveis de raciocínio nos provedores gerais e alterna `none`/`high` nos endpoints Xiaomi MiMo. A configuração inicial aplica a mesma seleção conforme o `baseURL` informado.

### Referência rápida da CLI

| Comando/opção | Efeito |
| :--- | :--- |
| `siliconflower` | Inicia a TUI; abre o assistente se a configuração não existir. |
| `--version`, `--help` | Mostra versão ou ajuda da CLI. |
| `config` | Executa novamente o assistente de configuração. |
| `show` | Exibe o caminho da configuração, ID e pasta de dados do workspace e configuração com chave mascarada. |
| `ensure` | Cria a configuração se estiver ausente e encerra. |
| `skills list` / `skills` | Lista as habilidades disponíveis. |
| `skills sync` / `sync` | Copia habilidades de exemplo sem substituir as existentes. |
| `logs` | Mostra logs; suporta `-n/--lines`, `-l/--level`, `-s/--search` e `--clear`. |
| `-m/--model`, `-r/--reasoning`, `--mode` | Sobrescreve modelo, raciocínio e modo nesta execução. |
| `--base-url`, `--api-key` | Sobrescreve endpoint e chave somente nesta execução. |

Exemplo: `siliconflower --model gpt-5.5 --reasoning medium --mode programação`. Os valores de ambiente `SILICONFLOWER_API_KEY`, `SILICONFLOWER_BASE_URL` e `SILICONFLOWER_MODEL` substituem os valores correspondentes do `config.json`; flags de CLI têm precedência e não são persistidas.

---

## 🛠️ Tabela de Ferramentas Nativas (34 Ferramentas)

O registro em `src/tools.ts` contém 33 ferramentas; `read_skill` é definida separadamente em `src/skills.ts`. A tabela reúne as 34 ferramentas disponíveis ao modelo.

| Ferramenta | Descrição | Arquivo Fonte |
| :--- | :--- | :--- |
| `read_file` | Leitura paginada de arquivos com `offset`, `limit` e linhas numeradas. | `src/tools.ts` |
| `write_file` | Criação/sobrescrita de arquivos com criação automática de pastas pai. | `src/tools.ts` |
| `edit_file` | Edição inteligente com correspondência flexível (`exact`, `normalized_newlines`, `fuzzy_whitespace`). | `src/services/smart-edit.ts` |
| `apply_patch` | Aplicação atômica de patches com múltiplos blocos de substituição. | `src/tools.ts` |
| `list_directory` | Lista arquivos e subpastas de um diretório. | `src/tools.ts` |
| `create_directory` | Cria diretórios e caminhos aninhados recursivamente. | `src/tools.ts` |
| `move_path` | Move ou renomeia arquivos e diretórios. | `src/tools.ts` |
| `delete_path` | Exclui arquivos/pastas (requer `confirm: true` para exclusão). | `src/tools.ts` |
| `file_info` | Consulta tamanho, tipo e datas de criação/modificação. | `src/tools.ts` |
| `search_files` | Busca arquivos usando padrões Glob (`**/*.ts`). | `src/glob-util.ts` |
| `grep_content` | Busca textual e regex recursiva no conteúdo dos arquivos com número de linha. | `src/grep.ts` |
| `repo_map` | Gera visualização estrutural do repositório exibindo símbolos e assinaturas. | `src/services/repomap.ts` |
| `find_symbol` | Localiza definições e assinaturas de símbolos específicos no código. | `src/services/repomap.ts` |
| `execute_command` | Execução de comandos do sistema no shell nativo (PowerShell no Windows, bash/sh em Unix) com timeout e captura segura. | `src/tools.ts` |
| `read_logs` | Consulta e filtra logs de execução do Siliconflower. | `src/logger.ts` |
| `ask_question` | Faz perguntas diretas ao usuário com opções interativas. | `src/tools.ts` |
| `todowrite` | Gerencia o checklist interativo de tarefas exibido na interface TUI. | `src/todo.ts` |
| `read_skill` | Carrega e lê o conteúdo de habilidades personalizadas salvas em `~/.siliconflower/skills/`. | `src/skills.ts` |
| `run_task` | Instancia subagente autônomo (papéis: `research`, `verification`, `plan`, `coder`, `general`, `custom`). | `src/services/subagent.ts` |
| `send_subagent_message`| Envia mensagens adicionais para continuar uma sessão de subagente. | `src/services/subagent.ts` |
| `manage_background_task` | Consulta status, recupera saídas ou encerra tarefas e subagentes em background. | `src/services/background-tasks.ts` |
| `save_memory` | Armazena regras, aprendizados e diretrizes persistentes entre sessões. | `src/services/memory.ts` |
| `recall_memory` | Consulta memórias salvas do projeto (`~/.siliconflower/workspaces/<id>/memory`) ou globais (`~/.siliconflower/memory`). | `src/services/memory.ts` |
| `forget_memory` | Remove memória por nome e escopo (`project`, `global` ou `all`). | `src/services/memory.ts` |
| `enter_worktree` | Cria um ambiente de trabalho Git isolado em branch temporária. | `src/services/worktree.ts` |
| `exit_worktree` | Remove um Git Worktree após a conclusão do trabalho ou testes. | `src/services/worktree.ts` |
| `list_worktrees` | Lista os Git Worktrees ativos no repositório. | `src/services/worktree.ts` |
| `create_artifact` | Cria e armazena artefatos estruturados (`markdown`, `html`, `json`, `code`, `mermaid`). | `src/services/artifact.ts` |
| `read_artifact` | Lê o conteúdo completo de um artefato salvo pelo ID. | `src/services/artifact.ts` |
| `list_artifacts` | Lista os artefatos disponíveis do projeto ou globais com metadados. | `src/services/artifact.ts` |
| `delete_artifact` | Remove um artefato pelo ID e escopo (`project`, `global` ou `all`). | `src/services/artifact.ts` |
| `web_fetch` | Baixa o conteúdo de páginas Web convertendo automaticamente para Markdown limpo. | `src/services/web.ts` |
| `web_search` | Realiza pesquisas na Web retornando snippets e URLs de referência. | `src/services/web.ts` |
| `manage_hooks` | Consulta os ganchos de execução configurados. | `src/core/hooks.ts` |

---

## 🧠 Sistema de Memória Persistente & Isolamento de Workspaces

Seguindo o padrão de harnesses modernos (como Antigravity), o Siliconflower **não polui o repositório do usuário** com pastas locais no workspace. Todos os dados são centralizados e isolados deterministicamente:

- **Projeto (Centralizado):** `~/.siliconflower/workspaces/<workspace-id>/memory/`
- **Global:** `~/.siliconflower/memory/`
- **Retrocompatibilidade:** Se existir uma pasta legada `<workspace>/.siliconflower/`, ela é consultada transparentemente para leitura/exclusão.

O `<workspace-id>` é derivado a partir do nome da pasta e um hash SHA-256 do caminho absoluto (ex: `meu-app-8f3a1b2c`).

Tipos de Memória suportados: `user`, `feedback`, `project`, `reference`.
As memórias globais, do workspace e do diretório legado são injetadas automaticamente no prompt do sistema durante cada interação. `save_memory` e `forget_memory` usam o escopo `project` por padrão; `global` e `all` devem ser informados explicitamente quando necessários.

---

## ⚡ Hooks de Execução

Você pode configurar hooks no `config.json` do usuário:
```json
{
  "hooks": {
    "preTool": "bun run lint",
    "postTool": "git status",
    "onEdit": "bun x tsc --noEmit"
  }
}
```

Variáveis de ambiente injetadas nos hooks:
- `SILICONFLOWER_EVENT`
- `SILICONFLOWER_TOOL_NAME`
- `SILICONFLOWER_TOOL_ARGS`
- `SILICONFLOWER_COMMAND`
- `SILICONFLOWER_FILE_PATH` (quando aplicável)

Os hooks são executados pelo shell padrão da plataforma (PowerShell no Windows; `$SHELL` ou `/bin/bash` em Linux/Unix), com timeout de 30 segundos. Com `hooks` definido em `config.json`, `preTool`, `postTool` e `onEdit` são executados para ferramentas nativas, exceto no modo `plano`; `onEdit` cobre `write_file`, `edit_file`, `apply_patch`, `move_path` e `delete_path`. `onSessionStart` e `onSessionEnd` também exigem configuração inline e são chamados no ciclo da TUI, inclusive no modo `plano`, pois não passam pela política de ferramentas.

`onCommand` usa a configuração inline ou, se ausente, procura `hooks.json` nesta ordem: dados do workspace (`~/.siliconflower/workspaces/<workspace-id>/hooks.json`), caminho legado do projeto (`<workspace>/.siliconflower/hooks.json`) e configuração global (`~/.siliconflower/hooks.json`). `manage_hooks` também consulta essas fontes para exibir a configuração. Arquivos `hooks.json` não são mesclados com `config.json`; na implementação atual, apenas `onCommand` usa esses arquivos para executar um hook.

---

## 🔒 Política do Modo Plano e MCP

O modo `plano` usa uma lista fechada definida em `src/tool-policy.ts`. A lista é: `read_file`, `grep_content`, `repo_map`, `find_symbol`, `recall_memory`, `list_worktrees`, `ask_question`, `read_logs`, `list_directory`, `file_info`, `search_files`, `web_fetch`, `web_search`, `read_artifact`, `list_artifacts`, `manage_hooks`, `read_skill` e `todowrite`. Em `manage_background_task`, somente `list` e `status` são permitidos. Qualquer ferramenta não reconhecida, subagente, mutação persistente ou ferramenta MCP é bloqueada. `todowrite` atualiza apenas o checklist da sessão; perguntas e consultas web também permanecem disponíveis.

Ferramentas MCP recebem nomes públicos qualificados (`mcp_<servidor>_<ferramenta>_<hash>`), mantendo o nome original apenas no transporte. Isso elimina ambiguidades e colisões nos schemas enviados aos provedores.

Configure servidores em `mcpServers` dentro de `config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Workspace"],
      "env": { "EXEMPLO": "valor" }
    }
  }
}
```

Cada conexão tem timeout de 20 segundos. Uma falha de inicialização é reportada como aviso e não desativa as ferramentas nativas. MCP executa processos configurados pelo usuário e não é uma sandbox.

`SILICONFLOWER_DATA_DIR` pode substituir `~/.siliconflower` para testes ou ambientes isolados.

Os modos `programação` e `sistema` alteram o foco do prompt e mantêm as ferramentas disponíveis. Só `plano` aplica a allowlist somente leitura. O agente não roda em sandbox: `execute_command` pode executar comandos de shell com os privilégios do usuário; consulte [SECURITY.md](SECURITY.md) antes de usá-lo em um ambiente sensível.

`delete_path` exige `confirm: true` em qualquer exclusão e protege raízes importantes; essa proteção não se estende a comandos PowerShell. `delete_artifact` e `forget_memory` removem do projeto por padrão. `exit_worktree` remove o worktree informado; `force: true` pode descartar alterações não salvas. Os worktrees criados ficam em `.worktrees/<branch>` dentro do repositório.

---

## 🔨 Comandos de Build e Validação (Bun)

- **Checagem de Tipos:** `bun run typecheck` ou `bun x tsc --noEmit`
- **Suíte de Testes:** `bun test`
- **Compilação do Executável Standalone:** `bun run build` (gera `dist/siliconflower` no Linux/macOS ou `dist/siliconflower.exe` no Windows; o alvo é resolvido a partir da plataforma atual via `src/platform.ts` e `build.ts`)
- **Instalação no PATH:** `npm run install:bin` (usa `scripts/install.sh` em Unix e `scripts/install.ps1` no Windows)
- **Execução em Desenvolvimento:** `bun start` ou `bun run src/index.tsx`

Antes de alterar a versão, confirme que `package.json` e `src/version.ts` estão alinhados. `src/version.ts` alimenta `--version` e a identificação do cliente MCP; `package.json` controla a versão do pacote. Para contribuições, consulte também [CONTRIBUTING.md](CONTRIBUTING.md) e [SECURITY.md](SECURITY.md).

