# Contribuindo com o Siliconflower

O projeto é pequeno e focado. As contribuições costumam ser de três tipos:

1. Relatos de bug e pedidos de recurso: abra uma issue primeiro.
2. Correções de documentação: abra o PR direto.
3. Mudanças no código: abra um PR seguindo as orientações abaixo.

## Ambiente

```bash
git clone https://github.com/1155dosilicon/siliconflower-nix.git
cd siliconflower-nix
bun install
bun run typecheck
bun test
bun run dev
```

Requisitos: Windows, Linux ou macOS/Unix, Bun >= 1.3 (recomendado) ou Node >= 20 com `tsx`.

O mapa do código, os comandos e as regras que já evitaram bugs estão em [AGENTS.md](AGENTS.md). A arquitetura detalhada está em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Estilo

- TypeScript em modo strict. Sem `any`, exceto ao envolver respostas de SDK.
- Textos para o usuário e prompts em pt-BR. Logs, campos de protocolo e saídas lidas por máquina em ASCII.
- Unicode decorativo só nos indicadores de status existentes da TUI e no logo. Mensagens operacionais precisam fazer sentido mesmo num terminal que não mostra esses símbolos.
- Prefira `void promise.catch(...)` a caminhos de promise sem tratamento. `log()` nunca deve lançar exceção.
- Saída do modelo não é confiável: valide caminhos e argumentos.

## Fluxo de pull request

1. Faça um fork e crie uma branch a partir de `main`.
2. `bun run typecheck` e `bun test` precisam passar.
3. Adicione ou atualize testes do comportamento alterado. Correções de bug ganham um teste em `tests/regressions.test.ts`.
4. Registre a mudança em `CHANGELOG.md`, seção `[Unreleased]`, com **uma linha** por item.
5. Na descrição do PR, explique a motivação, a mudança e qualquer impacto em compatibilidade.
