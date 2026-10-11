---
name: playwright-cli
description: Otomasi browser nyata lewat perintah shell `playwright-cli` — buka halaman, snapshot elemen, klik/isi form, screenshot, debug JS, mock network, dan inspeksi UI. Pakai saat tugas butuh menguji atau menjelajah aplikasi web (termasuk localhost). Lebih hemat token daripada Playwright MCP.
---

# Playwright CLI (otomasi browser dari terminal)

`playwright-cli` (Microsoft) menjalankan browser nyata lewat perintah shell dan
mengembalikan teks ringkas. Cocok untuk menguji UI, mengisi form, mengambil
snapshot/screenshot, dan debug. Lebih hemat token daripada Playwright MCP karena
tidak memuat skema tool + pohon aksesibilitas penuh ke konteks.

## Prasyarat (cek sekali)

```bash
playwright-cli --version 2>/dev/null || echo "belum-terpasang"
```

Bila belum ada:

```bash
npm install -g @playwright/cli@latest
npx playwright install chromium   # unduh browser (sekali)
```

## Aturan penting untuk agent

- Jalankan tiap perintah lewat tool `run_shell`. Browser tetap hidup di antara
  panggilan (daemon) — `open` sekali, lalu serangkaian aksi, lalu `close`.
- **Selalu `snapshot` dulu** untuk mendapat `[ref=eN]` tiap elemen, lalu kirim
  ref itu ke perintah berikutnya. Jangan menebak selector atau koordinat.
- Setelah tiap perintah, CLI otomatis mencetak snapshot terbaru. Snapshot juga
  tersimpan sebagai YAML di `.playwright-cli/*.yml` — baca berkas itu dengan
  `read_file` bila perlu, jangan dump seluruh DOM.
- Default **headless**. Tambahkan `--headed` hanya bila pengguna ingin melihat.
- Di lingkungan tanpa tampilan (SSH/daemon/Termux) jangan pakai `--headed`.
- Selalu `playwright-cli close` bila sudah selesai.
- Jangan commit folder `.playwright-cli/` (masukkan ke `.gitignore`).

## Alur tipikal

```bash
playwright-cli open https://demo.playwright.dev/todomvc
playwright-cli snapshot              # lihat ref, mis. e8 (textbox), e21 (checkbox)
playwright-cli fill e8 "Beli sayur"
playwright-cli press Enter
playwright-cli check e21
playwright-cli snapshot              # verifikasi hasil
playwright-cli screenshot            # simpan PNG ke disk
playwright-cli close
```

## Perintah inti

- **Navigasi:** `open [url]`, `goto <url>`, `go-back`, `go-forward`, `reload`, `close`
- **Interaksi:** `click <ref>`, `dblclick <ref>`, `hover <ref>`,
  `fill <ref> "teks"`, `type "teks"` (ke elemen fokus), `press <Key>`,
  `check <ref>`, `uncheck <ref>`, `select <ref> <nilai>`,
  `upload <ref> <file>`, `drag <ref> <ref>`
- **Inspeksi:** `snapshot`, `screenshot`, `eval "<js>"`, `run-code "<kode>"`
- **Tab:** `tab-list`, `tab-new`, `tab-close`, `tab-select`
- **Sesi/browser:** `open --browser=chrome|firefox|webkit|msedge`,
  `open --mobile`, `open --device="iPhone 15"`, `open --headed`, `show`
- **Export/debug:** `screenshot`, `pdf`, `video`, `trace`

Jalankan `playwright-cli --help` atau `playwright-cli <perintah> --help` untuk
daftar opsi lengkap.

## Tips

- Untuk aplikasi lokal, jalankan dev server dulu (mis. `pnpm dev`), lalu
  `playwright-cli open http://localhost:<port>`.
- Menghasilkan tes Playwright: berinteraksi lewat CLI, lalu gunakan
  `browser_generate_locator`-style codegen atau tulis `*.spec.ts` dan jalankan
  `npx playwright test`.
- Kalau repo menyediakan skill resmi Playwright, `playwright-cli install --skills`
  memasangnya; skill ini adalah versi ringkas yang cukup untuk sebagian besar tugas.
