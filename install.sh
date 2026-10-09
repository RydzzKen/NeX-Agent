#!/usr/bin/env bash
#
# NeX-Agent installer.
#
# Pemakaian:
#   curl -fsSL <url>/install.sh | bash
#   NEX_AGENT_REPO=<git-url> bash install.sh
#   bash install.sh            # dijalankan dari dalam checkout repo
#
# Variabel lingkungan (opsional):
#   NEX_AGENT_REPO     URL git sumber (default di bawah)
#   NEX_AGENT_BRANCH   branch/tag (default: main)
#   NEX_AGENT_HOME     lokasi instalasi saat mode unduh (default: ~/.local/share/nex-agent)
#   NEX_AGENT_BIN_DIR  folder perintah (default: ~/.local/bin)
#   NEX_AGENT_SKIP_RC  set 1 untuk tidak menyunting file rc shell
#
set -euo pipefail

REPO_URL="${NEX_AGENT_REPO:-https://github.com/RydzzKen/NeX-Agent.git}"
BRANCH="${NEX_AGENT_BRANCH:-main}"
INSTALL_DIR="${NEX_AGENT_HOME:-$HOME/.local/share/nex-agent}"
BIN_DIR="${NEX_AGENT_BIN_DIR:-$HOME/.local/bin}"
CMD_NAME="nex-agent"
ALIAS_NAME="agent"

log() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }
err() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }
need() { command -v "$1" >/dev/null 2>&1; }

# --- 1. Node.js 20+ ---------------------------------------------------------
if ! need node; then
  err "Node.js tidak ditemukan. Pasang Node 20+ dulu (mis. https://nodejs.org atau nvm)."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node 20+ dibutuhkan, terdeteksi $(node -v)."
  exit 1
fi
ok "Node $(node -v)"

# --- 2. pnpm ----------------------------------------------------------------
if ! need pnpm; then
  if need corepack; then
    log "Mengaktifkan pnpm lewat corepack..."
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
  fi
fi
if ! need pnpm; then
  if need npm; then
    log "Memasang pnpm lewat npm..."
    npm install -g pnpm >/dev/null 2>&1 || { err "Gagal memasang pnpm."; exit 1; }
  else
    err "pnpm maupun npm tidak ditemukan."
    exit 1
  fi
fi
ok "pnpm $(pnpm -v)"

# --- 3. Ambil sumber --------------------------------------------------------
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

SRC_DIR=""
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] \
  && grep -q '"name": *"nex-agent"' "$SCRIPT_DIR/package.json"; then
  SRC_DIR="$SCRIPT_DIR"
  log "Memakai sumber lokal: $SRC_DIR"
else
  if ! need git; then
    err "git dibutuhkan untuk mengunduh sumber."
    exit 1
  fi
  if [ -d "$INSTALL_DIR/.git" ]; then
    log "Memperbarui sumber di $INSTALL_DIR..."
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$INSTALL_DIR" checkout -q "$BRANCH"
    git -C "$INSTALL_DIR" reset -q --hard "origin/$BRANCH"
  else
    log "Mengunduh sumber ke $INSTALL_DIR..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
  SRC_DIR="$INSTALL_DIR"
fi

# --- 4. Pasang dependensi & build ------------------------------------------
cd "$SRC_DIR"
log "Memasang dependensi..."
if ! pnpm install --frozen-lockfile; then
  pnpm install
fi
log "Membangun..."
pnpm build
[ -f "$SRC_DIR/dist/index.js" ] || { err "Build gagal: dist/index.js tidak ada."; exit 1; }
chmod +x "$SRC_DIR/dist/index.js"
ok "Build selesai."

# --- 5. Pasang perintah ke PATH --------------------------------------------
mkdir -p "$BIN_DIR"
ln -sf "$SRC_DIR/dist/index.js" "$BIN_DIR/$CMD_NAME"
ln -sf "$SRC_DIR/dist/index.js" "$BIN_DIR/$ALIAS_NAME"
ok "Perintah dipasang: $BIN_DIR/$CMD_NAME"

# --- 6. Tambahkan ke file rc shell -----------------------------------------
MARKER="# >>> nex-agent >>>"
add_path() {
  rc="$1"
  mkdir -p "$(dirname "$rc")"
  touch "$rc" 2>/dev/null || return 0
  if ! grep -qF "$MARKER" "$rc"; then
    {
      printf '\n%s\n' "$MARKER"
      printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
      printf '# <<< nex-agent <<<\n'
    } >>"$rc"
    log "Menambahkan PATH ke $rc"
  fi
}
if [ "${NEX_AGENT_SKIP_RC:-0}" != "1" ]; then
  add_path "$HOME/.bashrc"
  [ -f "$HOME/.zshrc" ] && add_path "$HOME/.zshrc"
fi

# --- 7. Ringkasan -----------------------------------------------------------
printf '\n'
ok "NeX-Agent terpasang di $SRC_DIR"
printf '  Selanjutnya:\n'
printf '    1) source ~/.bashrc      # muat ulang PATH\n'
printf '    2) %s --version\n' "$CMD_NAME"
printf '    3) %s                   # lalu jalankan /connect\n' "$CMD_NAME"
