# TODO / Roadmap NeX-Agent

Peta kerja agar tidak lupa. Tandai `[x]` bila selesai, `[>]` sedang dikerjakan.

Legenda: `[x]` selesai · `[>]` berjalan · `[ ]` belum · `[~]` opsional/nanti

Terakhir diperbarui: preset MCP `/mcp add` (Context7/Playwright/Supabase) selesai.

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

- [x] **Preset `/mcp add`** (`context7`, `playwright`, `supabase`) + `/mcp remove` & `/mcp presets` — `src/plugins/presets.ts`
- [x] **Context7** (`/mcp add context7`) — dokumen library terbaru, read-only, aman di Termux. Limit tinggi: `/mcp key context7`
- [x] **Supabase** (`/mcp add supabase`) — read-only default; mutasi DB lewat konfirmasi; token di CredentialStore (`/mcp key supabase`)
- [x] **Playwright** (`/mcp add playwright`) — MCP browser headless, semua aksi = `mutate`. Berat (unduh Chromium); **tidak untuk Termux**
- [~] **Playwright CLI** (`@playwright/cli`) — alternatif lebih hemat token untuk agent pengkodean via `run_shell`; belum dibungkus tool khusus
- [ ] **Strix** (skill + tool `run_strix` opsional) — butuh Docker, **default NONAKTIF**, hanya aktif lewat `plugins.json` (`enabled: true`) atau `--enable strix`; target harus disetujui. **Tidak untuk Termux**
- [ ] **SkillUI** (`npx skillui`) — sudah didukung lewat Skill loader; tambah tool pembungkus opsional

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
