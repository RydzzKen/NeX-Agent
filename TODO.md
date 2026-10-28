# TODO / Roadmap NeX-Agent

Peta kerja agar tidak lupa. Tandai `[x]` bila selesai, `[>]` sedang dikerjakan.

Legenda: `[x]` selesai · `[>]` berjalan · `[ ]` belum · `[~]` opsional/nanti

Terakhir diperbarui: Re-design TUI selesai — home/sesi, transkrip, autocomplete, slash command, undo/redo, sidebar responsif, README, dan screenshot.

## Selesai

- [x] Core agent loop, tools, mode Plan/Build, checkpoint/undo
- [x] Multi-provider (Anthropic + OpenAI-compatible) + persistensi model/provider
- [x] Sensitive-file guard + allow-all + `/exit`/Ctrl+D
- [x] `/sessions`, `/resume`, `/models` (termasuk opsi `0` custom persisten)
- [x] Installer `curl` global (`nex-agent`/`agent`), Node auto-install, dukungan Termux, penanganan pnpm 12
- [x] Renderer Markdown ANSI (`/markdown`, `--no-markdown`) — commit `4143e07`
- [x] **Skill loader** (SKILL.md, progressive disclosure, tool `skill`, `/skills`, `/skill`) — commit `2ac1fee`
- [x] Format file skill fleksibel: `SKILL.md`/`skill.md` (tanpa peduli huruf besar-kecil), `skills/<nama>.md` datar, atau satu berkas `.md` di folder skill
- [x] Agent bisa **membuat skill sendiri**: tulis `skills/<nama>/SKILL.md` lewat `write_file` (diarahkan di system prompt; tetap butuh konfirmasi)
- [x] **Instal skill eksternal** lewat `run_shell` (mis. `git clone`, `npx skillui`) — didokumentasikan di README
- [x] Contoh skill bawaan: `skills/coding-skill.md` (`design-taste-frontend`)
- [x] **Mode Web** (`nex-agent serve`): chat browser + terminal PTY nyata, token wajib, sesi persisten
- [x] `/serve [stop]` di dalam sesi chat (nyalakan/hentikan web tanpa keluar)
- [x] Mode LAN (`--lan`/`/serve lan`): cetak URL IPv4 LAN + kode QR untuk ponsel
- [x] Indikator "sedang bekerja": spinner di CLI (`TerminalIO.busy`) + pill status & indikator di web
- [x] `/diff` — tinjau perubahan file sesi ini (read-only; pelengkap `/undo`)
- [x] `nex-agent doctor` — diagnostik lingkungan & konfigurasi (offline, read-only, tak mencetak rahasia)
- [x] Tool `apply_patch` — edit banyak file/edit sekaligus secara **atomik** (satu konfirmasi diff)
- [x] `/search <kata>` — cari teks di seluruh sesi (lintas workspace)
- [x] Pesan error dirapikan: provider (termasuk error di dalam stream) & MCP tak lagi tampil sebagai JSON mentah; Web/Telegram/CLI konsisten
- [x] **Mode TUI** (`nex-agent tui`) — layar penuh: alt-screen, status bar, view subagent, overlay konfirmasi/rahasia, pintasan tombol, gulir horizontal input, antrean pesan saat agent sibuk (`src/cli/tui/*`, `src/util/ansi.ts`)

## Re-design TUI (mengikuti `~/Project/TUI.md`)  ← selesai

Sumber kebenaran: `TUI.md` + mockup `Re-Design NeX-Agent TUI.html`. Renderer custom dipertahankan (repo tidak memakai Ink).

Keputusan: undo/redo berbasis checkpoint + snapshot riwayat; tema `opencode` + `mint`; plugin toggle lewat panel/klik; `/compact` ringkasan model dengan fallback trim.

- [x] **Tahap 1** — tema baru (palet TUI.md, fallback truecolor → 256 → 16), logo `NeX`/`AGENT`, layout responsif (`≥100` / `60–99` / `<60`, tinggi `<20`) + tes; tes prompt dibuat hermetis (scratch dir)
- [x] **Tahap 2** — dua layar: home & sesi; header judul + konteks; footer folder:branch + versi; sidebar; resize tanpa flicker
- [x] **Tahap 3** — isi sesi: panel pesan user, `$ perintah` + output, `← Edit path` + diff bernomor, kursor tool berjalan, `/details`
- [x] **Tahap 4** — autocomplete `/` (prefix → contains), `@` fuzzy file, `!` shell, Tab ganti mode (configurable), `/mode`, Enter terima saran
- [x] **Tahap 5** — slash command: `compact`/`summarize`, `details`, `editor`, `export`, `init`, `redo`, `themes`; alias `quit`/`q`/`clear`/`resume`/`continue`; undo/redo + snapshot
- [x] **Tahap 6** — data sidebar (sesi/plugin/file), toggle plugin (klik + `/mcp enable|disable`), panel detail untuk 60–99 kolom, README TUI, screenshot `120×35` / `80×24` / `45×30` di `docs/tui/`
- [x] **Verifikasi akhir** — `pnpm test` (804 tes), `pnpm lint`, `pnpm typecheck`, `pnpm build`; tidak ada regresi loop/tool/provider

## Web (chat + terminal di browser)  ← selesai

Keputusan: terminal = **shell bebas** (`$SHELL -i`) via PTY, **persisten selama server hidup**;
frontend vanilla JS + `xterm.js` (aset di-`copy` ke `dist/web`, tanpa bundler); transport WebSocket (`ws`).

- [x] Ekstrak `buildSystemPrompt` bersama (`src/memory/system_prompt.ts`)
- [x] `src/server/protocol.ts` (skema Zod pesan WS) + tes
- [x] `src/server/auth.ts` (token, timing-safe) + tes
- [x] `src/server/webio.ts` (approval/path/sensitive via WS) + tes
- [x] `src/server/terminal.ts` (PTY via `script`, fallback pipe) + tes
- [x] `src/server/webapp.ts` (orkestrasi sesi web)
- [x] `src/server/server.ts` (HTTP + WS, REST sesi, static) + tes
- [x] `web/` SPA (chat: daftar sesi, streaming, approval, markdown ringan)
- [x] Tab terminal `xterm.js` + `addon-fit`
- [x] UI responsif (drawer sesi di mobile, safe-area/notch, terminal fit saat keyboard, input 16px)
- [x] `nex-agent serve` + config `webHost`/`webPort` + README
- [~] `node-pty` sebagai backend PTY opsional (fallback `script` sudah memadai)

## Telegram (bot chat jarak jauh)  ← selesai

Keputusan: bot dijalankan sebagai **daemon terpisah** (supervisor + worker) supaya tetap hidup
walau sesi chat ditutup, dengan restart otomatis; token disimpan aman (`~/.config/agent/telegram.json`, mode 600).

- [x] `src/server/telegram.ts` (klien Bot API + `TelegramBridge`) dan `telegram_server.ts` (server mandiri headless)
- [x] Daemon: supervisor + auto-restart (backoff, berhenti pada error konfigurasi), pidfile, log — `nex-agent telegram start|stop|restart|status|logs`
- [x] Kelola dari sesi chat: `/telegram [start|stop|restart|status|logs|token|allow|deny|on|off]`
- [x] Allowlist chat-id + mode terbuka; token via `resolveTelegramSettings`/`CredentialStore`, tak pernah dicetak
- [x] Teruskan prompt persetujuan (tulis/shell/path/sensitive) ke Telegram; balas `y`/`n`/`a`
- [x] Menu perintah otomatis (`setMyCommands`), dukungan `/perintah@BotName`, normalisasi `-`→`_` (mis. `/allow-all`)
- [x] Perintah lengkap: `/new` `/clear` `/sessions` `/resume` `/rename` `/delete` `/plan` `/build` `/mode` `/allow-all` `/stop` `/status` `/models` `/skills` `/todos` `/usage` `/update` `/restart` `/help`
- [x] Render Markdown jawaban model sebagai **HTML Telegram** (`parse_mode: HTML`, chunk seimbang tag, batas entity, fallback teks polos) — `src/server/telegram_markdown.ts`
- [x] `/stop` (alias `/interrupt`): hentikan tugas berjalan **tanpa** hapus sesi; interrupt membatalkan approval yang menggantung; `/new` & `/resume` otomatis menghentikan tugas lama dulu
- [x] `/allow-all` sekaligus menyetujui izin yang menggantung (file sensitif tetap manual)
- [x] `/restart`: jalankan ulang worker agar versi baru terpakai

## Update mandiri & uninstall  ← selesai

- [x] `nex-agent update` / `/update`: fetch → fast-forward → `pnpm install` → `pnpm build`; dibatalkan bila ada perubahan lokal atau riwayat bercabang (non-ff)
- [x] Konfirmasi sebelum update: `Versi Terbaru tersedia: sekarang v… → terbaru v…` + `Update Sekarang? (y/N)` (headline cyan)
- [x] Pesan sukses `[SUKSES] Ter-update ke v…. Jalankan '/restart' untuk menerapkan.` (`[SUKSES]` ijo terang)
- [x] `/restart` untuk menerapkan: re-exec di chat CLI, respawn worker di Telegram
- [x] `nex-agent update --check` (hanya periksa) dan `nex-agent uninstall [--purge --yes]`

## Rencana plugin

### Tahap B — MCP client (fondasi plugin)  ← selesai

- [x] Modul `src/plugins/mcp.ts`: klien MCP (stdio + HTTP/SSE)
- [x] `plugins.json` di `~/.config/agent/` (daftar server: command/url, env, enabled)
- [x] Daftarkan tool MCP ke `ToolRegistry` dengan klasifikasi `risk`
- [x] Default aman: tool asing = `read`; mutasi wajib lewat approval
- [x] Rahasia/API key lewat `CredentialStore` (jangan pernah di-log)
- [x] `/mcp` (daftar/status server) dan `/mcp reload`
- [x] Tes: server mock stdio + parsing tool schema

### Tahap C — Integrasi spesifik (via konfigurasi + preset)

- [x] **`/mcp add`** — preset (`context7`, `playwright`, `supabase`) + command mentah (`/mcp add npx @pkg@latest`) & URL (`--url`, `--transport`, `--name`), plus `/mcp remove` & `/mcp presets` — `src/plugins/presets.ts`, `src/plugins/mcp_add.ts`
- [x] **Context7** (`/mcp add context7`) — dokumen library terbaru, read-only, aman di Termux. Limit tinggi: `/mcp key context7`
- [x] **Supabase** (`/mcp add supabase`) — read-only default; mutasi DB lewat konfirmasi; token di CredentialStore (`/mcp key supabase`)
- [x] **Playwright** (`/mcp add playwright`) — MCP browser headless, semua aksi = `mutate`. Berat (unduh Chromium); **tidak untuk Termux**
- [x] **Preset tambahan** — `github` (HTTP read-only + PAT), `cloudflare-docs` (HTTP tanpa token), `fetch` (`uvx mcp-server-fetch`), `filesystem` (`@modelcontextprotocol/server-filesystem`)
- [~] **Playwright CLI** (`@playwright/cli`) — alternatif lebih hemat token untuk agent pengkodean via `run_shell`; belum dibungkus tool khusus
- [ ] **Strix** (skill + tool `run_strix` opsional) — butuh Docker, **default NONAKTIF**, hanya aktif lewat `plugins.json` (`enabled: true`) atau `--enable strix`; target harus disetujui. **Tidak untuk Termux**
- [x] **SkillUI** (`npx skillui`) — tool `skill_install` + `/skills install <url|repo|folder>` (`--name`, `--ultra`, `--overwrite`); hasil disalin ke `skills/<nama>/` & langsung aktif — `src/memory/skillui.ts`, `src/tools/skill_install.ts`

### Lain-lain

- [x] README: bagian MCP + contoh `plugins.json` + preset `/mcp add`
- [ ] (opsional) Dukungan OAuth (PKCE) di klien MCP — server hosted yang mewajibkannya, mis. sebagian endpoint Cloudflare
- [ ] (opsional) Ekspos tool MCP ke mode Web (`server/webapp.ts` — saat ini hanya aktif di CLI)
- [ ] (opsional) Simpan skill yang dipaksa lewat `/skill` agar ikut saat `--resume`

## Catatan penting

- Termux aman: Context7, Supabase (HTTP/JS murni). Playwright & Strix kemungkinan besar tidak.
- Aturan arsitektur: `core/` tidak mengimpor `cli/`/SDK provider. Tool lewat registri. Input tervalidasi Zod.
- File sensitif tetap wajib konfirmasi walau `--allow-all`.
- Jangan pernah menulis kredensial (termasuk token Telegram) ke file/log/layar.

## Verifikasi tiap selesai

```bash
pnpm test && pnpm lint && pnpm typecheck && pnpm build
```

Lalu commit & push ke `origin/main`.
