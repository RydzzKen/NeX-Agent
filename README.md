# NeX-Agent (AI Agent CLI)

Agent berbasis terminal dengan loop agentik, dua mode (**Plan** dan **Build**),
soft workspace boundary, diff + konfirmasi, checkpoint/undo, dan arsitektur
**multi-provider**. Dibangun CLI-first dengan TypeScript strict.

## Persyaratan

- Node.js 20+ (dikembangkan di Node 24) — **dipasang otomatis** bila belum ada
  (lewat `nvm` di Linux/macOS tanpa sudo, atau `pkg` di Termux)
- pnpm — dipasang otomatis lewat corepack atau npm
- `git` dan `curl` (untuk mode unduh satu baris)
- Mendukung **Termux** (Android): Node/pnpm dipasang lewat `pkg`, perintah
  dipasang ke `$PREFIX/bin` yang sudah ada di `PATH`

## Instalasi

### Cepat — satu perintah, di perangkat mana pun

```bash
curl -fsSL https://raw.githubusercontent.com/RydzzKen/NeX-Agent/main/install.sh | bash
source ~/.bashrc
nex-agent
```

Skrip `install.sh` akan: memastikan Node 20+ dan pnpm tersedia (memasangnya
bila perlu), mengunduh sumber, memasang dependensi, membangun, lalu memasang
perintah `nex-agent` (alias `agent`). Di Linux/macOS perintah diletakkan di
`~/.local/bin` dan PATH-nya ditambahkan ke `~/.bashrc`/`~/.zshrc` (jalankan
`source ~/.bashrc` sekali); di Termux perintah langsung diletakkan di
`$PREFIX/bin` tanpa menyunting rc.

Catatan toolchain: `.npmrc` menyetel `minimum-release-age=0`, dan pada pnpm 12+
skrip otomatis memakai `--trust-lockfile` serta `pnpm approve-builds --all`
agar instalasi dari lockfile tetap berjalan.

Sesuaikan lewat variabel lingkungan bila perlu:

```bash
NEX_AGENT_REPO=<git-url> \
NEX_AGENT_BRANCH=main \
NEX_AGENT_HOME=~/.local/share/nex-agent \
NEX_AGENT_BIN_DIR=~/.local/bin \
  bash install.sh
```

### Termux (Android)

```bash
pkg install -y git
curl -fsSL https://raw.githubusercontent.com/RydzzKen/NeX-Agent/main/install.sh | bash
nex-agent --version
```

Di Termux, `install.sh` memakai `pkg install -y nodejs-lts` (Node resmi Termux
melaporkan `process.platform === "android"`, sehingga esbuild memakai binary
`@esbuild/android-arm64`), memasang perintah ke `$PREFIX/bin`, dan tidak
menyunting rc. Bila build `tsup`/esbuild gagal di perangkat tertentu, installer
otomatis jatuh ke kompilasi `tsc` (murni JS) sebagai cadangan.

### Manual (dari checkout)

```bash
pnpm install
pnpm build        # menghasilkan dist/index.js (perintah: nex-agent / agent)
bash install.sh   # pasang ke PATH + rc shell
pnpm link:global  # alternatif: daftarkan lewat pnpm
```

Menjalankan dari sumber: `pnpm dev -- "<tujuan>"`.

## Penggunaan

```bash
nex-agent "<tujuan>"          # jalankan satu tugas
nex-agent                     # mode chat interaktif
nex-agent --mode plan "..."   # mulai di mode Plan (read-only)
nex-agent --resume <id>       # lanjutkan sesi
nex-agent --continue          # lanjutkan sesi terakhir di workspace ini
nex-agent usage today         # rekap pemakaian lintas sesi
nex-agent logs <id>           # jejak satu sesi
```

`nex-agent` dan `agent` adalah perintah yang sama.

### Flag penting

`--model`, `--provider`, `--max-steps`, `--max-cost`, `--yes`,
`--allow-all`, `--cwd <path>`, `--allow-path <path>` (bisa diulang),
`--no-thinking`, `--debug`, `--json`.

`--yes` dan `--allow-all` menyetujui semua konfirmasi untuk sesi ini
(termasuk akses luar workspace). Mode Plan tetap read-only karena aturan itu
ditegakkan di kode, bukan lewat prompt.

**File sensitif tetap dilindungi.** Terlepas dari `--allow-all`/`--yes`, akses
ke `.env`, kredensial (`.npmrc`, `.git-credentials`, `credentials.json`),
private key (`id_rsa`, `*.pem`, `*.key`), dan folder `.ssh`/`.aws`/`.gnupg`
selalu minta konfirmasi eksplisit di TTY, dan ditolak di mode non-interaktif.
Perintah shell yang menyentuh file itu (mis. `cat .env`) diperlakukan sama.
Untuk menyetujui di muka di skrip, pakai `--allow-path <file>`.

### Slash command (mode chat)

`/connect` · `/models [nomor|0|nama]` · `/plan` · `/build` · `/sessions` ·
`/resume <n>` · `/new` · `/clear` · `/rename` · `/delete` · `/undo [n]` ·
`/usage` · `/permissions` · `/allow-all [on|off]` · `/thinking` · `/todos` ·
`/exit` · `/help`.

`/sessions` menampilkan sesi bernomor (judul diambil otomatis dari pesan
pertama), dan `/resume 2` melanjutkan sesi nomor 2. `/allow-all` menyalakan
mode izinkan-semua tanpa keluar dari sesi. `/exit` (atau Ctrl+D) keluar dari chat.

`/models` menampilkan daftar model bernomor dengan opsi `0) Custom model`.
Ganti model dengan `/models 2`, `/models 0` (lalu ketik nama model manual),
atau langsung `/models <nama>`. Pilihan model diingat per workspace di
`config.json`, jadi model custom tetap terpakai setelah restart.

Kode keluar: `0` sukses, `1` gagal tugas, `2` error konfigurasi,
`3` batas langkah/anggaran/pengulangan, `130` diinterupsi.

## Konfigurasi & kredensial

Disimpan di `~/.config/agent/` (bisa diubah lewat `AGENT_CONFIG_DIR`):

- `config.json` — preferensi (model per workspace, anggaran, dll.)
- `credentials.json` — kredensial, izin `600`, tidak pernah dicetak/log
- `AGENTS.md` — aturan global pengguna (dimuat otomatis)
- `sessions/` — riwayat sesi
- `logs/` — log JSONL terstruktur

## Arsitektur

```
src/
  core/        # loop agentik, approvals, checkpoint, context, repetition
  providers/   # ModelProvider + adapter (OpenAI-compatible, Anthropic)
  tools/       # read_file, write_file, edit_file, list_dir, run_shell, web_search, todo_write
  safety/      # workspace, permissions, classifier, policy
  sessions/    # penyimpanan sesi
  usage/       # token, biaya, agregasi
  memory/      # AGENTS.md loader
  cli/         # renderer, prompt, slash command, app
  config/      # konfigurasi & kredensial
  logging/     # logger JSONL + redaksi
```

Aturan: `core/` tidak mengimpor `cli/` maupun SDK provider. Interaksi pengguna
lewat interface `AgentIO`; model lewat `ModelProvider`; tool lewat registri.

## Daftar tugas (todo) live

Untuk tugas berlapis, agent memakai tool `todo_write` untuk mencatat rencana
sebagai checklist, lalu memperbarui statusnya seiring kemajuan:

```
Tugas: 1/3
[>] Tahap 2: ubah file
[ ] Tahap 3: jalankan tes
[x] Tahap 1: baca file
```

Checklist di-render ulang **di tempat** setiap kali status berubah
(menggunakan `[ ]` pending, `[>]` berjalan, `[x]` selesai, `[-]` dibatalkan).
`todo_write` tersedia juga di mode Plan karena tidak mengubah file. Daftar
tugas disimpan bersama sesi (bisa dilihat lagi dengan `/todos`, ikut saat
`--resume`).

## Pengembangan

```bash
pnpm test           # Vitest
pnpm test:coverage  # cakupan (ambang ≥70% untuk core/safety/providers/usage)
pnpm lint
pnpm typecheck
pnpm build
```

Lihat `AGENTS.md` untuk konvensi kerja.
