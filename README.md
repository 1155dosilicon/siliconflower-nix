# 🌸 SILICONFLOWER

![Version](https://img.shields.io/badge/version-0.2.6-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-0078D6.svg)
![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3-black.svg)
![Node](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)

Agente de IA em terminal (CLI/TUI) de alta performance para desenvolvimento de software em **Windows, Linux e macOS/Unix**. Integra **34 ferramentas nativas**, **Subagentes Concorrentes & Background Tasks**, **Memória Persistente**, **Git Worktrees**, **RepoMap**, **Busca Web** e **Protocolo MCP**, compatível com **SiliconFlow, OpenRouter, OpenAI** e demais backends compatíveis com a API da OpenAI.

<p align="center">
  <img src="assets/preview.png" alt="SiliconFlower TUI Preview" width="100%" />
</p>

---

## ✨ Recursos Principais

- 🤖 **Subagentes & Background Tasks**: Agentes autônomos com papéis `general`, `research`, `verification`, `plan`, `coder` ou `custom`, executados em segundo plano.
- 🧠 **Memória Persistente & Workspace Limpo**: Armazena preferências, regras e contexto do projeto de forma isolada em `~/.siliconflower/workspaces/<workspace-id>/memory/`, mantendo o repositório do projeto 100% limpo sem pastas visíveis no workspace (estilo Antigravity e harnesses modernos).
- 🌳 **Git Worktrees Isolados**: Testes e refatorações em branches temporárias sem afetar a área de trabalho atual.
- 🗺️ **RepoMap & Símbolos**: Mapeamento estrutural de código (TS, JS, Python, Go, Rust, Java, C/C++) com baixo consumo de tokens.
- ⚡ **Raciocínio & Modos de Operação**: Controle de *reasoning effort* (`Ctrl+E`) e modos de trabalho (`Ctrl+O`: `programação`, `sistema`, `plano`). Na API oficial Xiaomi MiMo, o atalho alterna o pensamento entre ligado e desligado.
- 🖥️ **TUI com Scroll Livre & Viewport Limpo**: Inicialização com tela limpa e suporte nativo completo à rolagem com a rodinha do mouse em respostas longas e blocos de código (estilo Claude Code).
- 🧩 **Ecossistema MCP & Hooks**: Suporte nativo ao Model Context Protocol e automações disparadas por eventos do ciclo de vida (`preTool`, `postTool`, `onEdit`, `onCommand`, `onSessionStart`, `onSessionEnd`).
- 📦 **Binário Nativo Standalone**: Compilação para binário único via Bun (`.exe` no Windows, `siliconflower` em Linux/Unix), sem necessidade de Node.js instalado.

---

## 🚀 Início Rápido

### Pré-requisitos
- Windows (PowerShell), Linux ou macOS/Unix (bash/sh).
- [Bun >= 1.3](https://bun.sh) para instalar dependências, executar a partir do código-fonte e compilar o binário.
- Como alternativa ao Bun, Node.js >= 20 com npm pode executar o launcher local após `npm install` (`node bin/siliconflower.js`). O comando `bun run start` requer Bun.

```bash
# 1. Clonar e instalar dependências
git clone https://github.com/siliconflower/siliconflower.git
cd siliconflower
bun install

# 2. Iniciar (abre o wizard de configuração na 1ª execução)
bun run start
```

### Compilar e Instalar no PATH

**Linux / macOS:**
```bash
bun run build          # Gera dist/siliconflower
npm run install:bin    # Copia para ~/.local/bin
siliconflower          # Executa a partir de qualquer pasta
```

**Windows:**
```powershell
bun run build          # Gera dist/siliconflower.exe
npm run install:bin    # Adiciona ao PATH do usuário
siliconflower          # Executa a partir de qualquer pasta
```

Abra um novo terminal depois da instalação para carregar o PATH atualizado.

---

## ⚙️ Configuração & Armazenamento Isolado

As configurações globais e dados do Siliconflower ficam organizados em `~/.siliconflower/`:

- **Configurações:** `~/.siliconflower/config.json`
- **Habilidades (Skills):** `~/.siliconflower/skills/`
- **Memórias Globais:** `~/.siliconflower/memory/`
- **Artefatos Globais:** `~/.siliconflower/artifacts/`
- **Workspaces Isolados:** `~/.siliconflower/workspaces/<workspace-id>/` (armazena memórias, artefatos e hooks do projeto sem poluir o repositório local)
- **Logs:** `~/.siliconflower/logs/`
- **Saídas Truncadas:** `~/.siliconflower/outputs/`

```json
{
  "baseURL": "https://api.siliconflow.com/v1",
  "apiKey": "sk-...",
  "model": "deepseek-ai/DeepSeek-V4-Pro",
  "reasoning": "high",
  "mode": "programação"
}
```

### Comandos de Gerenciamento & Flags CLI
```bash
bun run start -- --help
bun run start -- --version
bun run start -- config       # Reabre o assistente de configuração
bun run start -- show         # Exibe configuração mascarada e diretório do workspace
bun run start -- ensure       # Cria configuração se ainda não existir
bun run start -- skills list  # Lista habilidades instaladas
bun run start -- skills sync  # Copia exemplos sem sobrescrever arquivos existentes
bun run start -- logs -n 100 --level error --search timeout
bun run start -- -m <model> -r <level> --mode <mode> --base-url <url>
```

O comando `sync` também é um atalho para `skills sync`. `logs` aceita `-n/--lines`, `-l/--level` (`error`, `warn`, `info` ou `tool`), `-s/--search` e `--clear`.

As opções de execução `--model`, `--reasoning`, `--mode`, `--base-url` e `--api-key` substituem os valores para aquela execução e não salvam a configuração. Para persistir mudanças, use `config` ou edite `config.json`.

As variáveis `SILICONFLOWER_API_KEY`, `SILICONFLOWER_BASE_URL` e `SILICONFLOWER_MODEL` substituem os valores equivalentes de `config.json`; as opções passadas na linha de comando prevalecem sobre ambos.

### Xiaomi MiMo (v0.2.6)

Quando `baseURL` usa `xiaomimimo.com` ou um subdomínio oficial, o Siliconflower trata o raciocínio como um controle binário: `none` desativa o pensamento e `high` o ativa. O assistente de configuração mostra as opções `off` e `on`, e `Ctrl+E` alterna entre elas. O pedido envia `thinking.type` como `disabled` ou `enabled`; outros provedores compatíveis com OpenAI continuam usando `reasoning_effort` com `none`, `low`, `medium` ou `high`.

---

## ⌨️ Atalhos & Modos de Operação

### Atalhos no Terminal (TUI)
| Atalho | Ação |
| :--- | :--- |
| `Enter` | Envia a mensagem |
| `Ctrl+E` | Alterna o nível de raciocínio (`none` ➔ `low` ➔ `medium` ➔ `high`); na API oficial Xiaomi MiMo, alterna pensamento desligado/ligado |
| `Ctrl+O` | Alterna o modo de operação (`programação` ➔ `sistema` ➔ `plano`) |
| `Ctrl+C` | Cancela geração em andamento / Pressione 2x para sair |

### Modos de Trabalho
- **`programação`**: Acesso completo a ferramentas de código, leitura, escrita e testes.
- **`sistema`**: Focado em administração de SO, processos e scripts de shell (PowerShell no Windows, bash/sh em Linux/Unix).
- **`plano`**: Modo de planejamento com allowlist de leitura, perguntas e checklist da sessão — bloqueia edições de arquivo, comandos e ferramentas MCP.

`programação` e `sistema` mudam o foco do prompt, mas não isolam o agente nem limitam seus privilégios. O modo `plano` aplica uma allowlist explícita; ferramentas MCP e ferramentas não reconhecidas são bloqueadas por padrão. Hooks `onSessionStart` e `onSessionEnd` configurados inline ainda podem executar comandos nesse modo. Consulte [SECURITY.md](SECURITY.md) antes de conceder acesso ao computador.

---

## 🛠️ Ferramentas Nativas (34 Ferramentas)

O Siliconflower disponibiliza um conjunto completo de ferramentas integradas:

- 📁 **Arquivos & Edição**: `read_file`, `write_file`, `edit_file` (fuzzy/newline matching), `apply_patch`, `list_directory`, `create_directory`, `move_path`, `delete_path`, `file_info`.
- 🔍 **Busca & Navegação**: `search_files` (glob), `grep_content` (regex), `repo_map`, `find_symbol`.
- 💻 **Execução & Tarefas**: `execute_command` (shell arbitrário com os privilégios do usuário — PowerShell no Windows, bash/sh em Linux/Unix), `read_logs`, `ask_question`, `todowrite`, `read_skill`.
- 🤖 **Subagentes & Async**: `run_task`, `send_subagent_message`, `manage_background_task`.
- 🧠 **Memória & Worktrees**: `save_memory`, `recall_memory`, `forget_memory`, `enter_worktree`, `exit_worktree`, `list_worktrees`.
- 📄 **Artefatos & Web**: `create_artifact`, `read_artifact`, `list_artifacts`, `delete_artifact`, `web_fetch` (HTML para Markdown), `web_search`, `manage_hooks`.

> 📖 Para a documentação técnica detalhada das ferramentas e arquitetura, consulte o [LLMS.md](LLMS.md).

---

## 🧩 Extensibilidade

### Servidores MCP (`~/.siliconflower/config.json`)
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/Workspace"]
    }
  }
}
```

As ferramentas MCP são anunciadas à LLM com nomes qualificados e estáveis no formato `mcp_<servidor>_<ferramenta>_<hash>`. Isso evita colisões entre servidores ou com ferramentas nativas; o nome original continua sendo usado ao chamar o servidor.

### Testes e diretório de dados alternativo

Defina `SILICONFLOWER_DATA_DIR` para redirecionar `config.json`, logs e os demais dados persistentes para outro diretório. A suíte de testes usa essa variável automaticamente e não grava no perfil real do usuário.

### Hooks de Automação
```json
{
  "hooks": {
    "onEdit": "bun x tsc --noEmit",
    "postTool": "git status --short"
  }
}
```

### Habilidades Customizadas (Skills)
Crie arquivos Markdown em `~/.siliconflower/skills/` com instruções especializadas. O agente as carrega sob demanda com `read_skill`.

---

## 🩺 Diagnóstico rápido

- **HTTP 401:** confira a chave em `config.json` e a variável `SILICONFLOWER_API_KEY`.
- **HTTP 404:** confira o endereço base (normalmente terminado em `/v1`) e o identificador exato do modelo no provedor.
- **Servidor MCP indisponível:** confirme `command`, `args` e dependências do servidor. Falhas de conexão são exibidas como aviso; as ferramentas nativas continuam disponíveis. Consulte os detalhes com `bun run start -- logs`.
- **Comando não encontrado após instalar o binário:** abra uma nova janela do terminal para carregar o PATH atualizado.

---

## 📁 Estrutura do Projeto

```text
siliconflower/
├── src/
│   ├── core/           # Hooks e ciclo de vida (preTool, postTool, etc.)
│   ├── services/       # Subagentes, RepoMap, Memória, Worktrees, Artefatos, Web
│   ├── App.tsx         # Interface TUI (Ink / React)
│   ├── llm.ts          # Adaptador de streaming para APIs compatíveis com OpenAI
│   ├── reasoning.ts    # Detecção do endpoint Xiaomi MiMo e opções de pensamento
│   ├── tools.ts        # Registro central das 34 ferramentas nativas
│   └── index.tsx       # CLI e comandos de entrada
├── scripts/            # Scripts de instalação (Windows / Linux / macOS)
├── tests/              # Suíte de testes unitários (bun test)
├── build.ts            # Pipeline de compilação Bun (.exe standalone)
└── LLMS.md             # Guia de arquitetura e referência técnica
```

---

## 📜 Licença

Distribuído sob a licença **MIT**. Veja [LICENSE](LICENSE) para mais informações.
