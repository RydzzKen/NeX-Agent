# AGENTS.md

Konteks untuk agent yang bekerja di repo ini (NeX-Agent).

## Perintah

- `pnpm install` — pasang dependensi
- `pnpm test` — jalankan seluruh tes (Vitest)
- `pnpm lint` — ESLint
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm build` — bundel ke `dist/`

## Konvensi

- TypeScript strict, tanpa `any`.
- Fungsi kecil dan teruji. Satu file satu tanggung jawab.
- Commit singkat dan deskriptif.

## Aturan arsitektur

- `core/` **tidak boleh** mengimpor `cli/` maupun SDK provider secara langsung. Semua interaksi pengguna lewat interface yang diinjeksikan (`AgentIO`).
- Tool lewat registri; menambah tool cukup menambah file dan mendaftarkannya.
- Semua input tool dan konfigurasi divalidasi dengan Zod.
- Provider hanya lewat interface `ModelProvider`.
- Tidak ada provider, model, URL, atau port yang di-hardcode.

## Aturan loop

- Setiap tool call wajib punya tepat satu hasil dengan ID yang cocok, termasuk yang ditolak.
- Error tool tidak boleh membuat proses crash; dikembalikan ke model.
- Batas langkah, anggaran, dan deteksi pengulangan ditegakkan di `core/`.

## Larangan

- Jangan menulis kredensial ke file, log, atau layar.
- Jangan mengubah file di luar tugas.
- Jangan melemahkan penegakan mode Plan (harus di kode, bukan prompt).

## Definisi selesai

- Tes baru ditulis untuk perilaku baru.
- `pnpm test`, `pnpm lint`, dan `pnpm typecheck` lulus.
- Kriteria penerimaan PRD terpenuhi.
