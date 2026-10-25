#!/usr/bin/env bash
# Instala o binário standalone do Siliconflower no PATH do usuário (sem admin).
# Copia dist/siliconflower para ~/.local/bin e cria symlink se necessário.
#
# Uso:
#   bash scripts/install.sh
#   npm run install:bin

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${REPO_ROOT}/dist/siliconflower"
INSTALL_DIR="${SILICONFLOWER_INSTALL_DIR:-${HOME}/.local/bin}"

if [[ ! -f "$SOURCE" ]]; then
  # Fallback: binário sem extensão pode ter sido nomeado diferente
  if [[ -f "${REPO_ROOT}/dist/siliconflower.exe" ]]; then
    SOURCE="${REPO_ROOT}/dist/siliconflower.exe"
  else
    echo "Binário não encontrado em: $SOURCE" >&2
    echo "Rode 'bun run build' primeiro." >&2
    exit 1
  fi
fi

mkdir -p "$INSTALL_DIR"
cp -f "$SOURCE" "${INSTALL_DIR}/siliconflower"
chmod +x "${INSTALL_DIR}/siliconflower"
echo "[ok] binário copiado para: ${INSTALL_DIR}/siliconflower"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*)
    echo "[skip] '${INSTALL_DIR}' já está no PATH."
    ;;
  *)
    echo "[info] '${INSTALL_DIR}' não está no PATH."
    echo "       Adicione ao seu shell profile (~/.bashrc, ~/.zshrc ou ~/.profile):"
    echo "         export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

echo ""
echo "Pronto. Em um novo terminal rode:"
echo "    siliconflower --version"
echo "    siliconflower            # inicia a TUI (wizard na 1ª vez)"
echo "    siliconflower config     # reconfigurar"
