---
name: nex-agent-usage
description: Panduan fitur & langkah NeX-Agent (perintah slash/CLI, pasang skill via SkillUI, tambah server MCP, kredensial, web, bot Telegram, mode Plan/Build, update/uninstall). Muat saat pengguna bertanya cara memakai atau mengoperasikan NeX-Agent sendiri.
---

# Cara memakai & mengoperasikan NeX-Agent

Referensi ringkas untuk menjawab pertanyaan tentang NeX-Agent. Tabel opsi
lengkap ada di `COMMANDS.md`; gambaran produk ada di `README.md`. Untuk jawaban
umum, jelaskan langsung dari sini — jangan menjelajah kode.

## Perintah diketik di mana

- **Slash** (`/help`, `/mcp`, ...) diketik **di dalam sesi chat** (REPL), bukan di shell.
- **CLI** (`agent ...`, alias `nex-agent`) dijalankan di shell.
- Bot Telegram punya subhimpunan sendiri (lihat bawah).

## 1. Mode Plan / Build

- `/plan` = read-only: hanya baca & analisis. Menulis/mengeksekusi dilarang.
- `/build` = eksekusi; perubahan file tetap butuh persetujuan + menampilkan diff.
- Penegakan ada di **kode**, bukan prompt. Direktif mode disuntik tiap giliran.
- Mulai dari shell: `agent --mode plan "..."`.

## 2. Pasang skill (SkillUI)

```
/skills install <sumber> [--name <nama>] [--ultra] [--overwrite]
```

- `<sumber>`: URL situs, URL git repo (`github.com/org/repo`, `*.git`, `git@...`),
  atau folder lokal (relatif workspace). Jenis ditebak otomatis.
- Hasil: `skills/<nama>/SKILL.md`, **langsung aktif** (hot-reload, tanpa restart).
- `--ultra` = screenshot + animasi via Playwright (berat).
- `--overwrite` wajib untuk menimpa skill bernama sama.
- Butuh Node 18+ dan koneksi (menjalankan `npx skillui`).

Contoh:

```
/skills install https://linear.app
/skills install https://github.com/org/repo --name repo-design
/skills install ./frontend --ultra --overwrite
```

Kelola skill: `/skills` (daftar) · `/skill <nama>` (paksa aktif sepanjang sesi) ·
`/skill off` (lepas semua).

## 3. Tambah server MCP

```
/mcp add <preset> [nama]                      # preset bawaan
/mcp add [--name <nama>] <command> [args...]  # command stdio kustom
/mcp add --url <url> [--name <nama>] [--transport http|sse]
```

Preset: `context7`, `playwright`, `supabase`, `github`, `cloudflare-docs`,
`fetch`, `filesystem`. Daftar: `/mcp presets`.

```
/mcp add context7
/mcp add npx @playwright/mcp@latest --headless
/mcp add --url https://mcp.context7.com/mcp
```

- `plugins.json` hanya menyimpan **referensi** token (`${apiKey}`/`${VAR}`),
  bukan nilainya.
- Kredensial server: `/mcp key <nama>` (input tersembunyi). Hapus: `/mcp key <nama> hapus`.
- `github` read-only secara default (header `X-MCP-Readonly`).
- `fetch` butuh `uv`/`uvx`; alternatif: `/mcp add --name fetch docker run -i --rm mcp/fetch`.
- `filesystem` membuka folder kerja saat ini (`.`).
- Setelah ditambah, server langsung dimuat ulang. Kelola: `/mcp` (status) ·
  `/mcp remove <nama>` · `/mcp reload`.

## 4. Konfigurasi & kredensial

Semua di `~/.config/agent/` (bisa dipindah lewat `AGENT_CONFIG_DIR`):

- `config.json` — preferensi (model per workspace, anggaran, web, telegram).
- `credentials.json` — kredensial, izin `600`, tidak pernah dicetak/log.
- `plugins.json` — daftar server MCP.
- `AGENTS.md` — aturan global pengguna (dimuat otomatis).
- `sessions/` — riwayat sesi. `logs/` — log JSONL.

Aturan kredensial: **jangan pernah** menulis nilai rahasia ke file, log, atau layar.

## 5. Web & Telegram

```
agent web [--port 8080] [--lan] [--no-qr] [--host <host>]
agent telegram [start|stop|restart|status|logs|run]
```

- `/web` menyalakan server web **dari dalam sesi** (chat + terminal xterm) memakai
  workspace/model/mode aktif; `/web lan` mengekspos ke jaringan + QR; `/web stop`
  mematikannya. Default hanya `127.0.0.1` + token acak (fragmen `#t=...`).
- Telegram = daemon latar belakang dengan sesi sendiri (aman dari ponsel).
  Token: `/telegram token <TOKEN>` (di `telegram.json`, izin 600) atau env
  `TELEGRAM_BOT_TOKEN`. Batasi akses: `/telegram allow <chatId>` / `allowedChatIds`.
  Kosong = **terbuka untuk siapa pun** (berbahaya).
- Telegram mendukung `/new /clear /sessions /resume /rename /delete /plan /build
  /mode /allow-all /stop /status /models /skills /todos /usage /update /restart /help`.

## 6. Izin, sensitif, undo

- `/permissions [revoke <path>]` — lihat/cabut izin akses luar workspace.
- `/allow-all [on|off]` — izinkan semua permintaan izin untuk sesi ini.
- File sensitif (`.env`, `credentials.json`, `id_rsa`, `*.pem`, `.ssh/`, `.aws/`,
  `.gnupg/`) **selalu** minta konfirmasi eksplisit, walau `--allow-all`, dan
  ditolak di mode non-interaktif.
- `/undo [n]` — batalkan perubahan file (kembali ke sebelum langkah n).
- `/todos` — lihat checklist tugas sesi.

## 7. Update & hapus

```
agent update [--check] [--stash]     # /update di chat
agent uninstall [--purge --yes]
```

- `/update` menarik commit terbaru + `pnpm install` + build, dengan konfirmasi.
- `--stash` menyimpan perubahan lokal sementara (termasuk file baru). Update
  dibatalkan bila ada perubahan lokal tanpa `--stash` atau riwayat bercabang.
- Setelah update sukses, CLI menawarkan memuat ulang (`y`) — tetap di sesi ini
  lewat `--resume`; atau `/restart` kapan saja agar `dist/` terbaru dimuat.
- `uninstall --purge --yes` juga menghapus `~/.config/agent` + sumber terpasang.

## 8. Sesi & model

- `/sessions [clear]` daftar/hapus sesi · `/resume <n|id>` lanjut · `/new` sesi baru ·
  `/clear` bersihkan riwayat · `/rename <judul>` · `/delete [all]`.
- `/connect` hubungkan provider · `/provider [use|edit|hapus <id>]` kelola provider
  tersimpan (id `anthropic`/`openai`/`custom:<nama>`; awalan `custom:` boleh dilewat) ·
  `/models [nomor|0|nama]` pilih model (`0` = custom).
- Flag CLI umum: `--model --provider --max-steps --max-cost --yes --allow-all
  --cwd --allow-path --no-thinking --no-markdown --no-skills --debug --json`.
