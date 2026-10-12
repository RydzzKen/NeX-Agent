# Catatan Perintah: `/skills install` & `/mcp add`

Cheat sheet untuk memasang **skill** (via SkillUI) dan menambah **server MCP**.
Berlaku untuk NeX-Agent v1.1.3. Semua perintah diketik di dalam sesi (REPL),
bukan di shell. Untuk daftar lengkap perintah lain, ketik `/help`.

- [1. `/skills install` — pasang skill dari situs/repo/folder](#1-skills-install--pasang-skill-dari-situsrepofolder)
- [2. `/mcp add` — tambah server MCP](#2-mcp-add--tambah-server-mcp)
- [3. Perintah MCP & skill terkait](#3-perintah-mcp--skill-terkait)

---

## 1. `/skills install` — pasang skill dari situs/repo/folder

Menjalankan [SkillUI](https://skillui.vercel.app) (`npx skillui`) untuk menyalin
sistem desain (warna, tipografi, komponen) menjadi skill, lalu menaruhnya di
`skills/<nama>/SKILL.md` dan **langsung mengaktifkannya**.

### Bentuk umum

```
/skills install <sumber> [--name <nama>] [--ultra] [--overwrite]
```

Alias: `/skills pasang <sumber> ...`

### Opsi

| Opsi | Arti |
| --- | --- |
| `<sumber>` | URL situs, URL git repo, atau path folder lokal. Jenisnya ditebak otomatis. |
| `--name <nama>` | Nama skill (folder `skills/<nama>/`). Boleh sebelum atau sesudah `<sumber>`. |
| `--ultra` | Mode ultra: screenshot + animasi via Playwright. **Lebih berat.** |
| `--overwrite` | Timpa skill dengan nama yang sama (tanpa ini → ditolak). |

### Contoh

```bash
# Situs
/skills install https://linear.app

# Situs dengan nama khusus
/skills install https://linear.app --name linear
/skills install --name linear https://linear.app

# Git repo
/skills install https://github.com/org/repo
/skills install https://github.com/org/repo.git --name repo-design

# Folder lokal (relatif ke root workspace)
/skills install ./frontend
/skills install src/web --name web-design

# Mode ultra + nimpa skill lama
/skills install ./frontend --ultra --overwrite
```

### Catatan

- Deteksi jenis sumber: `github.com/org/repo` / `*.git` / `git@…` → **repo**;
  `http(s)://…` lain → **situs**; selain itu → **folder**.
- Hasil nama diambil dari `--name` → frontmatter `name` SkillUI → nama folder.
  Nama disanitasi jadi slug aman (mis. `Notion Design` → `notion-design`).
- Butuh Node 18+ dan koneksi (mengunduh paket `skillui` lewat npx).
- Folder sementara selalu dibersihkan; tidak ada yang ditulis di luar `skills/`.

---

## 2. `/mcp add` — tambah server MCP

Tiga bentuk: **preset**, **command stdio**, dan **URL (HTTP/SSE)**.
Setelah ditambah, server langsung dimuat ulang (tanpa keluar sesi).

### 2a. Preset bawaan

```
/mcp add <preset> [nama]
```

| Preset | Transport | Kredensial | Risk | Ringkas |
| --- | --- | --- | --- | --- |
| `context7` | HTTP | opsional → `/mcp key context7` | read | Dokumentasi library & API terbaru |
| `playwright` | stdio (`npx`) | — | mutate | Otomasi browser headless (berat) |
| `supabase` | stdio (`npx`) | wajib → `/mcp key supabase` | read | Kelola project Supabase |
| `github` | HTTP | wajib → `/mcp key github` | read | Repo/issue/PR (read-only default) |
| `cloudflare-docs` | HTTP | — | read | Dokumentasi Cloudflare |
| `fetch` | stdio (`uvx`) | — | read | Ambil halaman web → Markdown |
| `filesystem` | stdio (`npx`) | — | mutate | Akses folder (baca/tulis) |

```bash
/mcp add context7
/mcp add playwright
/mcp add supabase
/mcp add github
/mcp add cloudflare-docs
/mcp add fetch
/mcp add filesystem

# Pakai nama kustom
/mcp add supabase db-utama
/mcp add context7 docs
```

Catatan penting:

- **Tanpa preset** bisa lihat semua: `/mcp presets`.
- **github** menyetel token dulu: `/mcp key github` (Personal Access Token).
  Read-only secara bawaan (header `X-MCP-Readonly: "true"`); buka izin tulis
  dengan menghapus header itu di `~/.config/agent/plugins.json`.
- **supabase** butuh `/mcp key supabase`. Preset hanya menulis *referensi*
  `${apiKey}`, bukan nilai tokennya.
- **fetch** butuh `uv`/`uvx` (Python). Alternatif tanpa Python:
  `/mcp add --name fetch docker run -i --rm mcp/fetch`.
- **filesystem** membuka folder kerja saat ini (`.`). Folder lain:
  ```
  /mcp remove filesystem
  /mcp add --name fs npx -y @modelcontextprotocol/server-filesystem /path/anda
  ```
- **playwright** perlu `npx playwright install chromium`. Tidak cocok di Termux.

### 2b. Command stdio (kustom)

```
/mcp add [--name <nama>] <command> [args...]
```

```bash
/mcp add npx @playwright/mcp@latest --headless
/mcp add --name pw npx @playwright/mcp@latest
/mcp add uvx mcp-server-fetch
/mcp add python -m mcp_server_git --repository /path/repo

# Command yang diawali tanda "-": pakai pemisah "--"
/mcp add -- --perintah-aneh --flag
```

- Argumen pertama yang bukan opsi = `command`; sisanya `args`.
- Command = transport **stdio** (selalu).

### 2c. URL (server jarak jauh)

```
/mcp add --url <url> [--name <nama>] [--transport http|sse]
```

```bash
/mcp add --url https://mcp.context7.com/mcp
/mcp add --url https://docs.mcp.cloudflare.com/mcp --name cf-docs
/mcp add --url https://contoh.com/sse --transport sse
/mcp add --url https://contoh.com/mcp --http    # singkatan --transport http
/mcp add --url https://contoh.com/mcp --sse     # singkatan --transport sse
```

- `--transport` default **http** (boleh `http` atau `sse`, bukan `stdio`).
- `--url` tidak bisa digabung dengan `--transport stdio`.

### Opsi lengkap `/mcp add`

| Opsi | Arti |
| --- | --- |
| `--name <nama>` | Nama server eksplisit (bisa juga `--name=foo`). Bila bentrok → error. |
| `--url <url>` | Alamat server jarak jauh (HTTP/SSE). |
| `--transport <http\|sse>` | Transport server jarak jauh (default `http`). |
| `--http` / `--sse` | Singkatan menetapkan transport (khusus `--url`). |
| `--` | Penanda akhir opsi; sisa token dianggap command/args. |

### Penebakan nama server

- **Preset** → nama preset (`github`, `cloudflare-docs`, …).
- **Command** → token non-flag terakhir, atau `basename(command)` bila tak ada;
  prefiks `@`, `@versi`, dan ekstensi dibuang.
  Contoh: `@playwright/mcp@latest` → `playwright-mcp`.
- **URL** → nama host tanpa label umum (`mcp`, `api`, `www`, `docs`, `com`, …).
- Nama hasil penebakan yang bentrok otomatis diberi akhiran `-2`, `-3`, …
  Nama eksplisit (`--name`) yang bentrok **error** → gunakan `/mcp remove`.

---

## 3. Perintah MCP & skill terkait

```bash
# Melihat & mengelola server MCP
/mcp                       # status server + tool
/mcp presets               # daftar semua preset
/mcp remove <nama>         # hapus server (alias: /mcp rm <nama>)
/mcp reload                # muat ulang plugins.json
/mcp key <nama>            # simpan API key/token (tanpa ditulis ke plugins.json)
/mcp key <nama> hapus      # hapus kredensial

# Skill
/skills                    # daftar skill yang tersedia
/skills install <sumber>   # pasang skill via SkillUI (lihat bagian 1)
/skill <nama>              # paksa satu skill aktif sepanjang sesi
/skill off                 # lepas semua skill yang dipaksa

# Update
/update                    # periksa lalu tarik versi terbaru dari repo git
/update --stash            # update walau ada perubahan lokal (stash → update → pulihkan)
/update --check            # hanya periksa (CLI: nex-agent update --check)

# Alternatif (instalasi standar): jalankan ulang installer = force-update.
# Memakai git reset --hard, jadi perubahan lokal di folder sumber dibuang.
# curl -fsSL https://raw.githubusercontent.com/RydzzKen/NeX-Agent/main/install.sh | bash
```

Berkas konfigurasi:

- Server MCP → `~/.config/agent/plugins.json`
- Kredensial → `~/.config/agent/credentials.json` (izin `600`)
- Skill global → `~/.config/agent/skills/<nama>/SKILL.md`
- Skill proyek → `<workspace>/skills/<nama>/SKILL.md`
