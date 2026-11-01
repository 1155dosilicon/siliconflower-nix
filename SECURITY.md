# Modelo de segurança

O Siliconflower roda um agente de IA com acesso real à sua máquina. As proteções abaixo são intencionais. Se você encontrar uma forma de contorná-las, reporte como bug.

## O que o agente pode fazer

Depois de configurado, o modelo pode usar ferramentas que:

- leem, criam, editam, movem e listam arquivos (caminhos relativos são resolvidos a partir do `cwd`);
- buscam arquivos e conteúdo recursivamente;
- excluem arquivos e pastas (`delete_path`);
- executam qualquer comando de shell (`execute_command`: PowerShell no Windows, `$SHELL` em Linux/Unix) com os mesmos privilégios do usuário;
- iniciam os servidores MCP configurados, seja qual for o executável.

**Não há sandbox.** O agente tem os mesmos privilégios de quem roda o `siliconflower`.

## Proteções embutidas

- **`delete_path`** exige `confirm: true` em qualquer exclusão. Raízes de disco, a pasta do usuário, o diretório atual e as pastas acima deles não podem ser removidos por essa ferramenta.
- **Caminhos sensíveis** (`C:\Windows\System32`, `SysWOW64`, `/etc`, `/root`, `/boot`, `.ssh`, `.aws`, inclusive via junction ou link simbólico) são bloqueados no caminho passado às ferramentas de arquivo, busca e grep.
  - Nas buscas recursivas, `grep_content` sempre pula pastas ocultas.
  - `search_files` pula pastas ocultas, a menos que receba `includeHidden: true`; nesse caso pode **listar nomes** dentro delas, mas a leitura continua bloqueada.
- **`web_fetch`** bloqueia:
  - localhost e IPs privados ou reservados, inclusive em redirecionamentos;
  - formas IPv6 que embutem IPv4 (`::ffff:7f00:1`, `::ffff:127.0.0.1`, IPv4-compatible, NAT64 `64:ff9b::/96`);
  - IPv6 multicast e link-local.

  Também limita tempo de resposta e tamanho do corpo.

  **Limitação conhecida:** o hostname é resolvido uma vez para validação e de novo, de forma independente, pelo cliente HTTP. Um DNS malicioso que mude a resposta entre as duas consultas (*DNS rebinding*) contorna a checagem, e não há forma sem dependências de fixar o IP validado no Bun. Não use `web_fetch` com URLs controladas por terceiros apontando para endpoints internos sensíveis.
- **Modo `plano`** usa uma allowlist explícita: leitura, buscas, web, perguntas e checklist da sessão.
  - Bloqueia MCP, subagentes e qualquer mutação persistente.
  - Hooks de ferramenta ficam desligados, mas `onSessionStart` e `onSessionEnd` configurados inline continuam rodando e podem executar comandos.
- **Modos `programação` e `sistema`** só mudam o foco do prompt (o `sistema` pede para avisar antes de ações destrutivas ou de alterações no sistema). Nenhum dos dois limita privilégios.
- **`execute_command`** é, por design, um shell arbitrário. As proteções das ferramentas de arquivo **não** se aplicam a comandos de shell.

## Instruções de projeto vêm do repositório

`SILICONFLOWER.md` e `AGENTS.md` são enviados ao modelo como instruções do projeto, procurados na pasta atual e nas pastas acima dela. Num repositório clonado de terceiros, esses arquivos podem conter instruções maliciosas (*prompt injection*), por exemplo para rodar comandos ou enviar arquivos para fora. Leia esses arquivos antes de abrir o agente num repositório que você não conhece.

## O que você ainda deve fazer

- **Trate a chave de API como senha.** `show` mostra a chave mascarada, mas `~/.siliconflower/config.json` é texto puro. Para manter a chave fora desse arquivo, deixe o campo vazio e use `SILICONFLOWER_API_KEY`. Valores de ambiente nunca são gravados no `config.json`, nem pelo assistente `config`.
- **Não use `--mode` como barreira de permissão.** Ele só define o foco do modelo.
- **Revise o log** (`siliconflower logs`) de vez em quando, principalmente depois de sessões longas.
- **Servidores MCP de terceiros não são auditados por este projeto.** Ao configurar um, você confia nele.

## Reportando uma vulnerabilidade

Abra um *security advisory* privado no GitHub (aba Security → Report a vulnerability). Não abra issues públicas para suspeitas de vulnerabilidade.
