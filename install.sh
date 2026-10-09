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
#   NEX_AGENT_BIN_DIR  folder perintah (default: ~/.local/bin, atau $PREFIX/bin di Termux)
#   NEX_AGENT_SKIP_RC  set 1 untuk tidak menyunting file rc shell
#
set -euo pipefail

# pnpm 9.15+ menolak package yang baru dipublikasikan (<7 hari) secara default.
# Matikan agar instalasi dari lockfile selalu bisa jalan (repo juga punya .npmrc).
export NPM_CONFIG_MINIMUM_RELEASE_AGE=0

REPO_URL="${NEX_AGENT_REPO:-https://github.com/RydzzKen/NeX-Agent.git}"
BRANCH="${NEX_AGENT_BRANCH:-main}"
INSTALL_DIR="${NEX_AGENT_HOME:-$HOME/.local/share/nex-agent}"
CMD_NAME="nex-agent"
ALIAS_NAME="agent"

log() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }
err() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }
need() { command -v "$1" >/dev/null 2>&1; }

# --- Deteksi lingkungan -----------------------------------------------------
is_termux() {
  case "${PREFIX:-}" in
    *com.termux*) return 0 ;;
  esac
  return 1
}

if is_termux; then
  BIN_DIR="${NEX_AGENT_BIN_DIR:-${PREFIX}/bin}"
else
  BIN_DIR="${NEX_AGENT_BIN_DIR:-$HOME/.local/bin}"
fi

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# --- 1. Node.js 20+ ---------------------------------------------------------
ensure_node() {
  if need node && [ "$(node_major)" -ge 20 ] 2>/dev/null; then
    ok "Node $(node -v)"
    return 0
  fi
  if is_termux; then
    log "Memasang Node.js lewat pkg (Termux)..."
    pkg install -y nodejs-lts || pkg install -y nodejs || true
  else
    if ! need curl; then
      err "curl dibutuhkan untuk memasang Node.js."
      return 1
    fi
    log "Memasang Node.js lewat nvm (tanpa sudo)..."
    export NVM_DIR="$HOME/.nvm"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    fi
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    nvm install --lts
    nvm use --lts >/dev/null
  fi
  if need node && [ "$(node_major)" -ge 20 ] 2>/dev/null; then
    ok "Node $(node -v)"
    return 0
  fi
  err "Node 20+ masih belum tersedia."
  return 1
}
ensure_node

# --- 2. pnpm ----------------------------------------------------------------
ensure_pnpm() {
  if need pnpm; then
    ok "pnpm $(pnpm -v)"
    return 0
  fi
  if need corepack; then
    log "Mengaktifkan pnpm lewat corepack..."
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
  fi
  if ! need pnpm && is_termux && ! need npm; then
    pkg install -y npm >/dev/null 2>&1 || true
  fi
  if ! need pnpm && need npm; then
    log "Memasang pnpm lewat npm..."
    npm install -g pnpm >/dev/null 2>&1 || true
  fi
  if need pnpm; then
    ok "pnpm $(pnpm -v)"
    return 0
  fi
  err "pnpm tidak tersedia."
  return 1
}
ensure_pnpm

# pnpm 12+ punya "supply-chain policies" yang menolak lockfile baru dan hanya
# bisa dilewati lewat flag CLI `--trust-lockfile` (bukan di .npmrc). pnpm <= 11
# menolak flag itu, jadi dipakai hanya untuk major 12+ (lihat pnpm_install).
PNPM_MAJOR="$(pnpm -v 2>/dev/null | tr -d 'v' | cut -d. -f1)"

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
    if is_termux; then
      log "Memasang git lewat pkg (Termux)..."
      pkg install -y git || true
    fi
  fi
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

# pnpm 12 memblokir install kalau ada build script (mis. esbuild) yang tidak
# di-approve, dan menolak lockfile baru lewat "supply-chain policies".
# Helper ini menangani keduanya: flag --trust-lockfile + approve otomatis.
pnpm_install() {
  local cmd=(pnpm install "$@")
  if [ "${PNPM_MAJOR:-0}" -ge 12 ]; then
    cmd+=(--trust-lockfile)
  fi
  if "${cmd[@]}"; then
    return 0
  fi
  if [ "${PNPM_MAJOR:-0}" -ge 12 ]; then
    pnpm approve-builds --all >/dev/null 2>&1 || true
    "${cmd[@]}"
  else
    return 1
  fi
}

log "Memasang dependensi..."
if ! pnpm_install --frozen-lockfile; then
  pnpm_install
fi

fallback_build() {
  command -v tsc >/dev/null 2>&1 || return 1
  log "Build tsup gagal; mencoba fallback tsc..."
  cat >"$SRC_DIR/tsconfig.build-tmp.json" <<'JSON'
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "declaration": false
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
JSON
  rm -rf "$SRC_DIR/dist"
  if ! pnpm exec tsc -p "$SRC_DIR/tsconfig.build-tmp.json"; then
    rm -f "$SRC_DIR/tsconfig.build-tmp.json"
    return 1
  fi
  rm -f "$SRC_DIR/tsconfig.build-tmp.json"
  printf '#!/usr/bin/env node\n' | cat - "$SRC_DIR/dist/index.js" >"$SRC_DIR/dist/index.js.tmp"
  mv "$SRC_DIR/dist/index.js.tmp" "$SRC_DIR/dist/index.js"
}

log "Membangun..."
if ! pnpm build; then
  fallback_build || true
fi
if [ ! -f "$SRC_DIR/dist/index.js" ] || ! node "$SRC_DIR/dist/index.js" --version >/dev/null 2>&1; then
  err "Build gagal atau hasil build tidak bisa dijalankan."
  exit 1
fi
chmod +x "$SRC_DIR/dist/index.js"
ok "Build selesai ($(node "$SRC_DIR/dist/index.js" --version))."

# --- 5. Pasang perintah ke PATH --------------------------------------------
ENV_BIN="$(command -v env 2>/dev/null || echo /usr/bin/env)"
mkdir -p "$BIN_DIR"
write_launcher() {
  cat >"$BIN_DIR/$1" <<EOF
#!$ENV_BIN sh
exec node "$SRC_DIR/dist/index.js" "\$@"
EOF
  chmod +x "$BIN_DIR/$1"
}
write_launcher "$CMD_NAME"
write_launcher "$ALIAS_NAME"
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
if [ "${NEX_AGENT_SKIP_RC:-0}" != "1" ] && ! is_termux; then
  add_path "$HOME/.bashrc"
  [ -f "$HOME/.zshrc" ] && add_path "$HOME/.zshrc"
fi

# --- 7. Ringkasan -----------------------------------------------------------
printf '\n'
ok "NeX-Agent terpasang di $SRC_DIR"
if is_termux; then
  printf '  Selanjutnya: %s --version\n' "$CMD_NAME"
else
  printf '  Selanjutnya:\n'
  printf '    1) source ~/.bashrc      # muat ulang PATH\n'
  printf '    2) %s --version\n' "$CMD_NAME"
fi
printf '    3) %s                   # lalu jalankan /connect\n' "$CMD_NAME"
