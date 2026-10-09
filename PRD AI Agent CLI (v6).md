# PRD: AI Agent CLI (v6)

**Versi:** 6.0 (Draft) | **Tanggal:** 9 Oktober 2026 | **Pembaca utama:** coding agent (OpenCode) dan developer

**Perubahan dari v5:** (1) workspace boundary menjadi **soft** (bisa akses luar dengan konfirmasi), (2) deteksi project root otomatis dari CWD dan file penanda, (3) `/permissions` dan `--allow-path`, (4) thinking/reasoning ditampilkan eksplisit, (5) keseluruhan UX diratakan ke standar OpenCode/Claude Code.

## 1. Ringkasan

AI Agent berbasis terminal yang menerima tujuan dari pengguna, lalu menjalankan **loop agentik**: satu perintah memicu banyak panggilan model dan tool di belakang layar sampai tugas selesai. Agent punya dua mode: **Plan** (read-only) dan **Build** (eksekusi). Workspace dideteksi otomatis dari direktori aktif, dengan akses ke luar workspace yang diizinkan lewat konfirmasi. Aksi berisiko selalu butuh persetujuan, setiap perubahan file tampil sebagai diff, dan setiap perubahan bisa dibatalkan. Agent bersifat **multi-provider** lewat `/connect`, termasuk custom provider kompatibel OpenAI. Produk dibangun **CLI-first** dengan inti berupa library terpisah.

## 2. Prinsip Desain

**1 perintah = banyak langkah.** Satu perintah memicu 10–30 panggilan model. Konsekuensinya:

- **Biaya berlipat** → anggaran, `/usage`, pemangkasan konteks.
- **Bisa berputar tanpa henti** → batas langkah, timeout, deteksi pengulangan.
- **Kesalahan menumpuk** → error tool dikembalikan ke model, bukan crash.
- **Aksi nyata terjadi di tengah jalan** → mode Plan, diff, konfirmasi, interupsi, undo.
- **Pengguna harus paham apa yang terjadi** → setiap langkah dan thinking ditampilkan.

**Workspace adalah konteks, bukan penjara.** Agent dimulai dari folder aktif, tapi bisa mengakses file di luar bila memang perlu, dengan konfirmasi pengguna.

## 3. Tujuan dan Non-Tujuan

**Tujuan MVP**

- Loop agentik yang andal, terbatas, dan bisa diinterupsi.
- Dua mode (Plan dan Build) dengan batas izin yang ditegakkan oleh sistem.
- Workspace otomatis dari CWD; akses luar lewat konfirmasi.
- Setiap perubahan file tampil sebagai diff, bisa dibatalkan dengan `/undo`.
- Multi-provider lewat `/connect`; model terdeteksi otomatis.
- Thinking agent ditampilkan secara streaming dengan gaya berbeda dari output final.
- Sesi tersimpan dan bisa dilanjutkan.
- Pengguna selalu tahu pemakaian dan biaya lewat `/usage`.

**Non-tujuan MVP**

- TUI penuh layar, multi-agent, penjadwalan, antarmuka web.
- Fine-tuning model.
- Otonomi penuh tanpa persetujuan.

## 4. Batasan Teknis (wajib diikuti)

| Aspek | Keputusan |
| --- | --- |
| Bahasa | TypeScript (strict mode), Node.js 20+ |
| Package manager | pnpm |
| Provider model | Multi-provider lewat interface `ModelProvider`; tidak ada provider, model, URL, atau port yang di-hardcode |
| Tool eksternal | Dukungan MCP lewat MCP SDK resmi (fase 2) |
| Validasi | Zod untuk skema tool dan konfigurasi |
| CLI | `commander` untuk argumen; prompt interaktif untuk `/connect` dan konfirmasi |
| Diff | Library diff (misalnya `diff`) dengan pewarnaan ANSI |
| Tes | Vitest |
| Lint/format | ESLint + Prettier |
| Distribusi | Paket npm dengan binary `agent` |
| Kredensial | File kredensial lokal dengan izin `600` atau keychain OS; tidak pernah masuk log atau prompt |

**Struktur folder**

```
src/
  core/        # loop agentik, planner, context manager, mode, checkpoint
  providers/   # interface ModelProvider + adapter per provider
  tools/       # definisi dan eksekutor tool
  safety/      # workspace, permissions, klasifikasi perintah
  sessions/    # penyimpanan dan pemuatan sesi
  usage/       # penghitungan token, biaya, agregasi
  memory/      # AGENTS.md loader
  cli/         # perintah, slash command, konfirmasi, diff, thinking renderer
  config/      # konfigurasi dan kredensial
  logging/     # logger terstruktur (JSONL)
tests/
AGENTS.md
```

**Aturan arsitektur:** `core/` tidak boleh mengimpor `cli/` maupun SDK provider secara langsung. Semua interaksi pengguna lewat interface yang diinjeksikan.

## 5. Workspace dan Project Root

### Deteksi otomatis

Saat agent dijalankan, ia menetapkan workspace dengan urutan:

1. Nilai flag `--cwd <path>` bila ada.
2. Direktori aktif saat agent dijalankan (CWD).
3. Agent mencari **project root** ke atas dari CWD dengan mencari file penanda: `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `composer.json`. Root pertama yang ditemukan menjadi workspace; bila tidak ada penanda, CWD menjadi workspace.

Workspace ditampilkan di awal sesi, misalnya:

```
● workspace  ~/Project/cek-hp  (git)
● mode       build
● model      9router / qwen2.5-coder
```

### AGENTS.md dimuat otomatis

Agent memuat file konteks dengan urutan (semua yang ada dimuat, digabung):

1. `~/.config/agent/AGENTS.md` — aturan global pengguna.
2. `<workspace>/AGENTS.md` — aturan proyek.
3. `<workspace>/<subfolder>/AGENTS.md` — aturan subfolder bila file yang dikerjakan ada di situ.

### Soft workspace boundary

Workspace adalah titik awal, bukan penjara:

| Lokasi akses | Tipe tool | Perilaku |
| --- | --- | --- |
| Di dalam workspace | read-only | Langsung, tanpa konfirmasi |
| Di dalam workspace | mutating | Diff + konfirmasi seperti biasa |
| Di luar workspace | read-only | Peringatan + konfirmasi sekali; diingat sesi ini |
| Di luar workspace | mutating | Peringatan eksplisit + konfirmasi; **tidak** bisa disetujui sekaligus untuk sesi |
| Di luar workspace | mutating di mode Plan | Selalu ditolak |

- Path yang sudah diizinkan (read-only luar workspace) diingat selama sesi dan bisa dilihat lewat `/permissions`.
- Flag `--allow-path <path>` menyetujui path tertentu sebelum sesi dimulai, tanpa interupsi.
- Perintah shell destruktif (`rm -rf`, `curl | sh`, dsb.) selalu diblokir terlepas dari lokasi.
- Tes: akses baca ke luar workspace meminta konfirmasi; setelah diizinkan, akses berikutnya ke path yang sama langsung tanpa konfirmasi.

## 6. Mode Kerja

| Aspek | Plan | Build |
| --- | --- | --- |
| Tujuan | Analisis dan rencana | Eksekusi |
| Baca file, cari, list dir | Ya | Ya |
| Web search | Ya | Ya |
| Tulis/edit file (dalam workspace) | Tidak | Ya, dengan diff + konfirmasi |
| Tulis/edit file (luar workspace) | Tidak | Ya, dengan konfirmasi lebih ketat |
| Shell read-only (`ls`, `cat`, `git status`, `git diff`) | Ya | Ya |
| Shell mutating (`rm`, `git push`, install paket) | Tidak | Konfirmasi |
| Shell berbahaya (`rm -rf /`, `curl \| sh`) | Blokir | Blokir |

- Pembatasan mode ditegakkan di `safety/`: tool tulis tidak diekspos ke model di mode Plan.
- Pindah mode lewat `/plan` dan `/build`. Mode aktif tampil di prompt setiap saat.
- Rencana dari mode Plan tetap ada di riwayat saat pindah ke Build.

## 7. Kebutuhan Fungsional dan Kriteria Penerimaan

Prioritas: **P0** wajib MVP, **P1** fase 2, **P2** fase 3.

### F-01 Loop agentik (P0)

**Alur satu putaran:**

1. Pengguna mengirim perintah; agent menyusun konteks: instruksi sistem, AGENTS.md, riwayat, daftar tool sesuai mode.
2. Agent memanggil model dengan streaming.
3. Bila respons berisi **thinking**: ditampilkan streaming dengan warna abu-abu/dim (F-05).
4. Bila respons berisi **tool call**: divalidasi, diperiksa izin, dikonfirmasi bila perlu, lalu dieksekusi. Hasilnya (sukses maupun error) ditambahkan ke riwayat, lalu kembali ke langkah 2.
5. Bila respons tidak berisi tool call: putaran selesai, teks final ditampilkan.

**Beberapa tool call dalam satu respons:**

- Tool `read-only` boleh paralel (maksimal 4 sekaligus).
- Tool `mutating` berurutan, masing-masing dengan diff dan persetujuan sendiri.
- Setiap tool call wajib punya satu hasil dengan ID yang cocok, termasuk yang ditolak (hasilnya berisi alasan penolakan), agar riwayat tetap valid.

**Kondisi berhenti:** model selesai, batas langkah, batas anggaran, interupsi pengguna, deteksi pengulangan, atau error provider tak pulih.

Saat berhenti bukan karena sukses: ringkasan apa yang sudah dikerjakan, apa yang belum, dan alasan berhenti. Sesi tetap tersimpan.

**Kriteria penerimaan:**

- Tes: loop berhenti tepat di batas langkah dengan model palsu.
- Tes: tiga tool call dalam satu respons menghasilkan tiga hasil dengan ID cocok, termasuk satu yang ditolak.
- Tes: tool `read-only` paralel, `mutating` berurutan.
- Tes: JSON tool call rusak dua kali berturut-turut menghentikan loop dengan ringkasan.

### F-02 Deteksi pengulangan (P0)

- Sidik jari tiap panggilan (nama tool + argumen + hasil) dicatat.
- Bila panggilan identik muncul 3 kali berturut-turut, atau pola dua panggilan bergantian 3 siklus, agent berhenti dan melapor.
- Agent menawarkan: lanjutkan dengan petunjuk baru, atau akhiri.
- Tes: model yang selalu memanggil tool yang sama berhenti di panggilan ke-3.

### F-03 Interupsi (P0)

- **Ctrl+C sekali:** hentikan loop dengan rapi, tool yang berjalan dibatalkan, sesi tersimpan, tool call terputus diberi hasil "dibatalkan oleh pengguna".
- **Ctrl+C dua kali:** keluar segera.
- Setelah interupsi, pengguna bisa memberi arahan baru dalam sesi yang sama.
- Tes: interupsi di tengah shell menghasilkan riwayat yang valid dan bisa dilanjutkan.

### F-04 Checkpoint dan /undo (P0)

- Sebelum tool `mutating` pertama dalam sebuah tugas, agent mencatat snapshot file yang akan diubah (disimpan di folder data sesi).
- `/undo` mengembalikan perubahan file dari tugas terakhir; `/undo <n>` ke sebelum langkah n; diff pembatalan ditampilkan dulu.
- Batasan: undo hanya untuk perubahan file lewat tool. Efek samping shell (install paket, `git push`) tidak bisa dibatalkan; peringatan ini ditampilkan di dialog konfirmasi.
- Tes: edit tiga file lalu `/undo` mengembalikan ketiganya persis.

### F-05 Tampilan thinking dan langkah (P0)

**Thinking (proses berpikir model):**

- Ditampilkan streaming dengan warna abu-abu/dim, dibedakan dari teks jawaban dan output tool.
- Diawali dengan penanda visual, misalnya `◆ thinking...`.
- Bisa disembunyikan lewat flag `--no-thinking` atau `/thinking off`; diringkas jadi satu baris bila panjang.
- Thinking tidak disimpan ke log utama, hanya ke log debug (`--debug`).

**Langkah (tool call):**

- Setiap tool call tampil saat dijalankan: ikon, nama tool, ringkasan argumen, status (✓ / ✗ / ⊘), dan durasi.

  ```
  ◆ thinking...  aku perlu baca src/index.ts dulu sebelum...
  ⚙ read_file    src/index.ts                          (120ms ✓)
  ⚙ edit_file    src/index.ts  [+3 -1]                  konfirmasi?
  ```
- Hasil panjang diringkas di layar (10 baris pertama); model menerima hasil sesuai aturan F-13.
- Penghitung langkah tampil di prompt: `[7/25]`.
- Flag `--json`: setiap langkah dan thinking sebagai satu baris JSON.

### F-06 Mode Plan dan Build (P0)

- Mode Plan hanya mengekspos tool baca; eksekutor menolak tool tulis walaupun model mencobanya.
- Perpindahan mode di tengah sesi tidak menghapus riwayat.
- Tes: `write_file` yang dipaksakan di mode Plan ditolak oleh eksekutor.

### F-07 Registri tool (P0)

Tool MVP: `read_file`, `write_file`, `edit_file`, `list_dir`, `run_shell`, `web_search`.

- Setiap tool punya skema Zod dan deklarasi `read-only` atau `mutating`.
- Tool baru ditambahkan dengan mendaftarkan satu file tanpa mengubah `core/`.
- Input tidak valid → pesan error dikembalikan ke model.

### F-08 Tampilan diff (P0)

- Setiap `edit_file` dan `write_file` menampilkan diff sebelum diterapkan.
- Baris dihapus: merah + awalan `-`; baris ditambahkan: hijau + awalan `+`; konteks 3 baris: netral.
- Header: path file, nomor baris, ringkasan (+N -N).
- File baru: seluruh isi sebagai baris `+`.
- Dialog: `[y] setujui  [n] tolak  [a] setujui semua  [d] lihat diff penuh`.
- Warna dimatikan bila bukan terminal atau `NO_COLOR` diset; awalan tetap ada.
- Tes: keluaran diff untuk pasangan teks diketahui cocok dengan snapshot.

### F-09 Manajemen izin (P0)

- `/permissions` menampilkan daftar path luar workspace yang sudah diizinkan sesi ini, beserta tipe akses (baca/tulis) dan asal (interaktif atau `--allow-path`).
- `/permissions revoke <path>` mencabut izin; akses berikutnya ke path itu akan meminta konfirmasi lagi.
- `--allow-path <path>` (bisa diulang) menyetujui path sebelum sesi; cocok untuk skrip.
- Izin disimpan per sesi, tidak persisten ke sesi berikutnya (kecuali diatur di `AGENTS.md` global).

### F-10 Multi-provider dan /connect (P0)

- Interface `ModelProvider`: kirim pesan, streaming, tool call, token, daftar model.
- Tidak ada provider default. Saat pertama kali tanpa provider terhubung, agent menampilkan alur `/connect`.
- Daftar: Anthropic, OpenAI, Google (menyusul), Custom provider. Urutan bukan berarti default.
- Model terakhir yang dipilih diingat per workspace.
- Kredensial: izin `600` atau keychain OS; tidak pernah tercetak.
- `/models` — daftar model tersedia; `/disconnect <provider>` — hapus kredensial.
- Pergantian provider/model di tengah sesi diperbolehkan; riwayat dalam format netral.
- Tes: dua adapter palsu dengan format berbeda melanjutkan sesi yang sama.

### F-11 Custom provider dan deteksi model (P0)

- Pengguna mengisi nama, base URL, API key (boleh kosong). Contoh: `http://localhost:20128/v1` untuk 9router; port dan path hanya contoh, tidak ditanam di kode.
- Agent memanggil `GET {baseURL}/models`, timeout 5 detik. Bila gagal → input nama model manual.
- Daftar dapat dicari; di-cache beberapa jam; `/models --refresh` memuat ulang.
- Uji tool calling saat model pertama dipilih; bila gagal → peringatan jelas.
- Provider custom bisa banyak; hanya API key di penyimpanan kredensial.

### F-12 Sesi dan /usage (P0)

**Sesi**

- Setiap sesi: ID, judul otomatis, workspace, model, waktu, total biaya.
- `agent --resume <id>`, `agent --continue` (sesi terakhir di workspace ini).
- `/sessions`, `/new`, `/clear`, `/rename`, `/delete`.
- Sesi yang terputus bisa dilanjutkan dari titik terakhir.

**`/usage`**

Satu layar ringkas:

```
─── Sesi ini ──────────────────────────
  Panggilan model   14
  Token masuk       42.310
  Token keluar       8.920
  Cache hit         31.200  (saved ~$0.03)
  Estimasi biaya    ~$0.18

─── Konteks ───────────────────────────
  62% terpakai      78k / 128k token

─── Anggaran ──────────────────────────
  Sisa              $0.82 dari $1.00
  ██████████░░░░░░  82% terpakai

─── Per model ─────────────────────────
  9router/qwen2.5   $0.12   (10 panggilan)
  anthropic/sonnet  $0.06   (4 panggilan)
```

- `/usage today`, `/usage week`, `/usage all` — rekap lintas sesi per provider/model.
- `/usage <id>` — sesi tertentu.
- `agent usage` — padanan di luar mode chat.
- Biaya berlabel "estimasi"; bila harga tidak diketahui, hanya token yang ditampilkan.
- Tes: data pemakaian palsu menghasilkan keluaran yang cocok dengan snapshot.

### F-13 Pengelolaan konteks (P0 dasar, P1 penuh)

**P0:** hasil tool melebihi 20.000 karakter dipangkas dengan penanda; peringatan di 85% jendela konteks.

**P1:** peringkasan otomatis riwayat lama di 80% dengan keputusan penting tetap dipertahankan.

### F-14 Penanganan error dan anggaran (P0)

- Timeout per tool (default 60 detik untuk shell).
- Retry exponential backoff untuk error jaringan (maksimal 3 kali).
- `--max-cost` dan konfigurasi; peringatan di 80%; berhenti dan melapor saat tercapai.
- Bila provider gagal → tawarkan pindah ke provider lain.

### F-15 Human-in-the-loop (P0)

- Aksi kategori konfirmasi: tampilkan perintah atau diff lengkap, tunggu jawaban.
- `--yes` hanya menyetujui kategori konfirmasi, tidak pernah yang diblokir.
- Mode non-interaktif tanpa `--yes` menolak aksi yang butuh konfirmasi.

### F-16 Logging (P0)

- Setiap langkah ke JSONL: waktu, mode, provider, model, tool, argumen (kredensial disamarkan), durasi, status, token.
- Thinking tidak masuk log utama; masuk log debug bila `--debug`.
- `agent logs <id>` menampilkan jejak sesi.

### F-17 Antarmuka CLI (P0)

```
agent "<tujuan>"          # jalankan tugas
agent                     # mode chat interaktif
agent --mode plan "..."   # mulai di mode Plan
agent --resume <id>       # lanjut sesi
agent --continue          # lanjut sesi terakhir di workspace ini
```

Slash command: `/connect`, `/models`, `/plan`, `/build`, `/sessions`, `/new`, `/clear`, `/undo`, `/usage`, `/permissions`, `/thinking`, `/help`.

Flag: `--mode`, `--model`, `--max-steps`, `--max-cost`, `--yes`, `--resume`, `--continue`, `--cwd`, `--allow-path`, `--no-thinking`, `--debug`, `--json`.

Kode keluar: `0` sukses, `1` gagal tugas, `2` error konfigurasi, `3` batas langkah/anggaran/pengulangan, `130` diinterupsi.

### F-18 Fase berikutnya (P1 dan P2)

- **P1:** MCP, TUI (Ink), peringkasan konteks otomatis, RAG, `agent eval`.
- **P2:** multi-agent dan penjadwalan.

## 8. Kebutuhan Non-Fungsional

- **Kinerja:** token pertama dalam 3 detik; startup di bawah 500 ms; diff 1.000 baris di bawah 200 ms; `/usage` di bawah 300 ms; Ctrl+C berhenti dalam 1 detik; deteksi model dalam 5 detik.
- **Keamanan:** tidak ada kredensial di log atau layar; shell dengan hak pengguna biasa; prompt injection dimitigasi.
- **Portabilitas:** Linux dan macOS; tanpa dependensi GUI; bisa lewat SSH.
- **Keandalan:** sesi bisa dilanjutkan setelah terputus; riwayat selalu valid.
- **Kualitas kode:** cakupan tes ≥ 70% untuk `core/`, `safety/`, `providers/`, `usage/`; semua tes dan lint lulus sebelum dianggap selesai.

## 9. Urutan Pengerjaan (untuk coding agent)

Satu tahap per sesi; mulai dengan mode Plan, tinjau rencana, baru Build.

1. **Fondasi:** inisialisasi, struktur folder, TypeScript strict, ESLint, Prettier, Vitest, `AGENTS.md`, konfigurasi.
2. **Provider dan loop minimal:** `ModelProvider`, satu adapter, loop dengan `read_file`, batas langkah, tes model palsu.
3. **Loop lengkap:** banyak tool call per respons, paralel/berurutan, ID hasil, JSON rusak, ringkasan berhenti, deteksi pengulangan, interupsi Ctrl+C (F-01, F-02, F-03).
4. **Tool lengkap:** `write_file`, `edit_file`, `list_dir`, `run_shell`, `web_search` dengan deklarasi read-only/mutating (F-07).
5. **Workspace dan izin:** deteksi project root, AGENTS.md loader, soft boundary, konfirmasi akses luar, `/permissions`, `--allow-path` (§5, F-09).
6. **Mode Plan dan Build:** penegakan di `safety/`, perpindahan mode (F-06).
7. **Diff, konfirmasi, dan guardrail:** renderer diff, dialog, klasifikasi shell (F-08, F-15).
8. **Thinking renderer:** tampilan abu-abu/dim streaming, `/thinking`, `--no-thinking` (F-05).
9. **Checkpoint dan /undo:** snapshot, restore, tes pemulihan (F-04).
10. **Multi-provider dan /connect:** adapter Anthropic dan OpenAI, `/connect`, `/models`, format riwayat netral (F-10).
11. **Custom provider:** base URL, `GET /models`, fallback manual, uji tool calling (F-11).
12. **Sesi, anggaran, dan /usage:** simpan/lanjut, `--max-cost`, `/usage` dan rekap, pemangkasan konteks (F-12, F-13, F-14).
13. **Polesan CLI:** tampilan langkah, logging, semua slash command, `--json`, kode keluar, rilis MVP (F-16, F-17).

## 10. Isi AGENTS.md yang Disarankan

- Perintah: `pnpm install`, `pnpm test`, `pnpm lint`, `pnpm build`.
- Konvensi: TypeScript strict, tidak ada `any`, fungsi kecil dan teruji, commit singkat.
- Aturan arsitektur: `core/` tidak mengimpor `cli/` maupun SDK provider; tool lewat registri; input Zod; provider lewat `ModelProvider`; tidak ada nilai bawaan di-hardcode.
- Aturan loop: setiap tool call wajib punya hasil dengan ID cocok; error tidak boleh crash.
- Larangan: jangan tulis kredensial ke file/log/layar; jangan ubah file di luar tugas; jangan lemahkan penegakan mode Plan.
- Definisi selesai: tes baru ditulis, semua tes dan lint lulus, kriteria penerimaan terpenuhi.

## 11. Metrik Keberhasilan

| Metrik | Target |
| --- | --- |
| Tingkat keberhasilan pada set evaluasi | ≥ 80% |
| Parameter tool valid | ≥ 95% |
| Riwayat tidak valid akibat tool call tanpa hasil | 0 |
| Loop melewati batas langkah atau anggaran | 0 |
| Loop berulang terdeteksi sebelum batas langkah | ≥ 95% pada set uji |
| Perubahan file tanpa diff dan persetujuan | 0 |
| Penulisan file di mode Plan yang lolos | 0 |
| Akses luar workspace tanpa konfirmasi | 0 |
| Perubahan file berhasil dikembalikan `/undo` | 100% pada set uji |
| Sesi berhasil dilanjutkan setelah terputus | ≥ 99% |
| Custom provider dengan `/models` terdeteksi benar | ≥ 95% pada set uji |

## 12. Risiko dan Mitigasi

| Risiko | Mitigasi |
| --- | --- |
| Loop berputar tanpa henti | Batas langkah, deteksi pengulangan, anggaran, interupsi |
| Biaya membengkak | `--max-cost`, peringatan 80%, `/usage`, pemangkasan hasil |
| Konteks penuh | Pemangkasan hasil (P0), peringatan 85%, peringkasan (P1) |
| Riwayat rusak | Aturan ID wajib cocok, hasil "dibatalkan" untuk tool terputus |
| Akses file berbahaya di luar workspace | Soft boundary dengan konfirmasi; tulis luar workspace selalu konfirmasi |
| Efek samping shell tidak bisa di-undo | Konfirmasi, peringatan eksplisit |
| Mode Plan dilanggar model | Tool tulis tidak diekspos; eksekutor menolak di kode, bukan prompt |
| Model di router tidak mendukung tool calling | Uji saat pemilihan model; peringatan jelas |
| Kebocoran API key | Penyimpanan `600`/keychain; penyamaran di log |
| Prompt injection dari web/file | Konten sebagai data; tidak bisa ubah izin atau mode |

## 13. Pertanyaan Terbuka

- Apakah izin luar workspace yang diatur di `AGENTS.md` global dipercaya otomatis, atau tetap konfirmasi pertama kali?
- Berapa batas anggaran default per tugas bila pengguna belum mengaturnya?
- Apakah snapshot undo dibersihkan saat sesi dihapus?
- Perintah shell mana saja yang masuk daftar aman dan daftar blokir awal?
- Apakah Windows perlu didukung sejak MVP?
- Apakah mode Plan boleh menulis satu file rencana (`PLAN.md`), atau benar-benar nol penulisan?
