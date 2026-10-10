# TODO / Roadmap NeX-Agent

Peta kerja agar tidak lupa. Tandai `[x]` bila selesai, `[>]` sedang dikerjakan.

Legenda: `[x]` selesai · `[>]` berjalan · `[ ]` belum · `[~]` opsional/nanti

Terakhir diperbarui: mulai fitur Web (chat + terminal browser).

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
- [x] `nex-agent serve` + config `webHost`/`webPort` + README
- [~] `node-pty` sebagai backend PTY opsional (fallback `script` sudah memadai)

## Rencana plugin

### Tahap B — MCP client (fondasi plugin)  ← berikutnya

- [ ] Modul `src/plugins/mcp.ts`: klien MCP (stdio + HTTP/SSE)
- [ ] `plugins.json` di `~/.config/agent/` (daftar server: command/url, env, enabled)
- [ ] Daftarkan tool MCP ke `ToolRegistry` dengan klasifikasi `risk`
- [ ] Default aman: tool asing = `read`; mutasi wajib lewat approval
- [ ] Rahasia/API key lewat `CredentialStore` (jangan pernah di-log)
- [ ] `/mcp` (daftar/status server) dan `/mcp reload`
- [ ] Tes: server mock stdio + parsing tool schema

### Tahap C — Integrasi spesifik (via konfigurasi, bukan kode khusus)

- [ ] **Context7** (`@upstash/context7-mcp`) — dokumen library terbaru. Prioritas tertinggi, read-only, aman di Termux
- [ ] **Supabase** (`@supabase/mcp-server-supabase`) — read-only default; mutasi DB lewat konfirmasi; token di CredentialStore
- [ ] **Playwright** (`@playwright/mcp`) — E2E/inspeksi UI. Berat (unduh browser); kemungkinan **tidak jalan di Termux**
- [ ] **Strix** (skill + tool `run_strix` opsional) — butuh Docker, **default NONAKTIF**, hanya aktif lewat `plugins.json` (`enabled: true`) atau `--enable strix`; target harus disetujui. **Tidak untuk Termux**
- [ ] **SkillUI** (`npx skillui`) — sudah didukung lewat Skill loader; tambah tool pembungkus opsional

### Lain-lain

- [ ] README: bagian MCP + contoh `plugins.json`
- [ ] (opsional) Simpan skill yang dipaksa lewat `/skill` agar ikut saat `--resume`

## Catatan penting

- Termux aman: Context7, Supabase (HTTP/JS murni). Playwright & Strix kemungkinan besar tidak.
- Aturan arsitektur: `core/` tidak mengimpor `cli/`/SDK provider. Tool lewat registri. Input tervalidasi Zod.
- File sensitif tetap wajib konfirmasi walau `--allow-all`.

## Verifikasi tiap selesai

```bash
pnpm test && pnpm lint && pnpm typecheck && pnpm build
```

Lalu commit & push ke `origin/main`.
