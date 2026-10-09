# TODO / Roadmap NeX-Agent

Peta kerja agar tidak lupa. Tandai `[x]` bila selesai, `[>]` sedang dikerjakan.

Legenda: `[x]` selesai · `[>]` berjalan · `[ ]` belum · `[~]` opsional/nanti

Terakhir diperbarui: sesi plugin (commit `2ac1fee`).

## Selesai

- [x] Core agent loop, tools, mode Plan/Build, checkpoint/undo
- [x] Multi-provider (Anthropic + OpenAI-compatible) + persistensi model/provider
- [x] Sensitive-file guard + allow-all + `/exit`/Ctrl+D
- [x] `/sessions`, `/resume`, `/models` (termasuk opsi `0` custom persisten)
- [x] Installer `curl` global (`nex-agent`/`agent`), Node auto-install, dukungan Termux, penanganan pnpm 12
- [x] Renderer Markdown ANSI (`/markdown`, `--no-markdown`) — commit `4143e07`
- [x] **Skill loader** (SKILL.md, progressive disclosure, tool `skill`, `/skills`, `/skill`) — commit `2ac1fee`

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
- [ ] **Strix** (skill + tool `run_strix` opsional) — butuh Docker, opt-in, target harus disetujui. **Tidak untuk Termux**
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
