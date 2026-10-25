import { join, basename } from "node:path";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { ensureDir, getGlobalDataDir } from "./fs-util.js";
import { isWindows } from "./platform.js";

export interface Skill {
  name: string;
  title: string;
  path: string;
  content: string;
}

const USER_SKILLS_DIR = join(getGlobalDataDir(), "skills");

export function skillsDir(): string {
  return USER_SKILLS_DIR;
}

// Embedded example skills - these are compiled into the binary
const EMBEDDED_SKILLS: Record<string, string> = {
  "code-review.md": `# Code Review

## Quando aplicar
Use esta skill quando o usuário pedir revisão de código, "review", "analise este código" ou relatar bugs.

## Diretrizes
- Leia o arquivo completo com \`read_file\` antes de opinar.
- Avalie: correção, segurança, performance, legibilidade e aderência às convenções do projeto.
- Comente cada ponto com a severidade: **bloqueante**, **atenção** ou **sugestão**.
- Sugira correções concretas com \`edit_file\` quando apropriado.
- Não reescreva código que já está correto apenas por estilo, a menos que o projeto tenha linter que exija.

## Formato da resposta
1. Resumo (1-3 linhas)
2. Pontos por severidade
3. Ações aplicadas (edições feitas) ou próximas etapas`,
  "windows-backup.md": `# Windows Backup

## Quando aplicar
Use esta skill quando o usuário pedir backup, restore, imagem de sistema, pontos de restauração ou proteção de dados no Windows.

## Diretrizes
- Prefira ferramentas nativas: wbadmin, VSS, Histórico de Arquivos, pontos de restauração.
- Para backup completo de sistema: \`wbadmin start backup -backupTarget:X: -include:C: -allCritical -quiet\`.
- Para arquivos de usuário: Histórico de Arquivos (Configurações > Atualização e Segurança > Backup).
- Sempre verifique espaço no destino antes de iniciar.
- Teste o restore periodicamente — backup não testado não é backup.
- Documente o procedimento de restore para o usuário.

## Avisos
- Operações em disco podem demorar horas.
- Não interrompa um backup em andamento.
- BitLocker: backups de unidade criptografada requerem a chave de recuperação.`,
  "windows-privacy.md": `# Windows Privacy

## Quando aplicar
Use esta skill quando o usuário pedir privacidade, telemetria, diagnóstico, anúncios, Cortana, sugestões, rastreamento ou hardening de privacidade no Windows.

## Diretrizes
- Desative telemetria: \`reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection" /v AllowTelemetry /t REG_DWORD /d 0 /f\` (requer Admin).
- Desative experiências personalizadas: Configurações > Privacidade > Geral > desligue tudo.
- Desative ID de publicidade: Configurações > Privacidade > Geral > "Deixar aplicativos usarem minha ID de publicidade".
- Desative Cortana e busca na web: GPO ou registro.
- Use O&O ShutUp10++ ou W10Privacy para GUI completa.
- Crie ponto de restauração antes de alterações no registro.

## Avisos
- Alterações no registro podem quebrar funcionalidades.
- Algumas políticas exigem Windows Pro/Enterprise.
- Reverter pode exigir restore do ponto de restauração.`,
  "unix-backup.md": `# Unix Backup

## Quando aplicar
Use esta skill quando o usuário pedir backup, restore, snapshot ou proteção de dados em Linux/Unix.

## Diretrizes
- Prefira ferramentas nativas: \`rsync\`, \`tar\`, \`borg\`, \`restic\`, snapshots LVM/Btrfs/ZFS, \`timeshift\`.
- Backup incremental com rsync: \`rsync -aHAX --delete --numeric-ids /origem/ /destino/\`.
- Archive completo: \`tar -a -czf backup.tar.gz -C /origem .\`.
- Sempre verifique espaço no destino antes de iniciar.
- Teste o restore periodicamente — backup não testado não é backup.
- Documente o procedimento de restore para o usuário.

## Avisos
- Operações em disco podem demorar horas.
- Não interrompa um backup em andamento.
- Preserve permissões, ownership e ACLs (\`-a\`, \`-p\`, \`-A\`, \`-X\`) quando relevante.`,
  "unix-system.md": `# Unix System

## Quando aplicar
Use esta skill para operações de sistema em Linux/Unix: serviços, pacotes, rede, usuários, logs e hardening.

## Diretrizes
- Serviços: \`systemctl status|restart|enable <serviço>\`; logs via \`journalctl -u <serviço>\`.
- Pacotes: \`apt\`, \`dnf\`, \`pacman\`, \`apk\` conforme a distro — confirme o gerenciador antes.
- Rede: \`ip a\`, \`ss -tulpn\`, \`ping\`, \`curl -I\`.
- Processos: \`ps aux\`, \`top\`/\`htop\`, \`kill <pid>\` (SIGTERM antes de SIGKILL).
- Permissões: \`chmod\`, \`chown\`; prefira o princípio do menor privilégio.
- Em contêineres/WWS: não assuma systemd; use os comandos disponíveis na imagem.

## Avisos
- Não execute \`rm -rf\` em caminhos do sistema sem confirmação explícita do usuário.
- Alterações em \`/etc\`, fstab, boot ou usuários de sistema exigem aviso prévio de impacto.
- Prefira comandos não-destrutivos e reversíveis.`,
};

/** Skills relevant for the current OS (plus shared ones). */
function embeddedSkillsForPlatform(): Record<string, string> {
  const winOnly = new Set(["windows-backup.md", "windows-privacy.md"]);
  const unixOnly = new Set(["unix-backup.md", "unix-system.md"]);
  const out: Record<string, string> = {};
  for (const [name, content] of Object.entries(EMBEDDED_SKILLS)) {
    if (isWindows() && unixOnly.has(name)) continue;
    if (!isWindows() && winOnly.has(name)) continue;
    out[name] = content;
  }
  return out;
}

export async function syncSkills(): Promise<{ copied: string[]; skipped: string[]; errors: string[] }> {
  await ensureDir(USER_SKILLS_DIR);
  const copied: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const [name, content] of Object.entries(embeddedSkillsForPlatform())) {
    const dst = join(USER_SKILLS_DIR, name);
    try {
      const dstStat = await stat(dst).catch(() => null);
      if (dstStat) {
        skipped.push(name);
        continue;
      }
      await writeFile(dst, content, "utf8");
      copied.push(name);
    } catch (e) {
      errors.push(`${name}: ${String(e)}`);
    }
  }
  return { copied, skipped, errors };
}

export async function loadSkills(): Promise<Skill[]> {
  await ensureDir(USER_SKILLS_DIR);
  const out: Skill[] = [];
  let names: string[] = [];
  try {
    names = await readdir(USER_SKILLS_DIR);
  } catch {
    names = [];
  }
  let mdNames = names.filter((n) => n.toLowerCase().endsWith(".md"));
  if (mdNames.length === 0) {
    await syncSkills();
    try {
      names = await readdir(USER_SKILLS_DIR);
      mdNames = names.filter((n) => n.toLowerCase().endsWith(".md"));
    } catch {
      mdNames = [];
    }
  }
  for (const n of mdNames) {
    const path = join(USER_SKILLS_DIR, n);
    try {
      const content = await readFile(path, "utf8");
      const name = n.replace(/\.md$/i, "");
      const title = extractTitle(content) ?? "";
      out.push({ name, title, path, content });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function extractTitle(content: string): string | null {
  const lines = content.split(/\r?\n/);
  for (const l of lines) {
    const m = /^#\s+(.+)$/.exec(l.trim());
    if (m) return m[1].trim();
  }
  // fallback: first non-empty line
  for (const l of lines) {
    const t = l.trim();
    if (t) return t.slice(0, 80);
  }
  return null;
}

export async function readSkillContent(name: string): Promise<string> {
  const baseName = basename(name).replace(/\.md$/i, "") + ".md";
  const path = join(USER_SKILLS_DIR, baseName);
  return readFile(path, "utf8");
}

export const SKILL_TOOL = {
  name: "read_skill",
  description:
    "Lê o conteúdo completo de uma skill (.md) carregada pelo usuário para aplicar suas instruções especializadas.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", description: "Nome da skill (sem .md)" } },
    required: ["name"],
  },
};
