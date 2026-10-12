/**
 * Susun argumen untuk menjalankan ulang proses CLI.
 *
 * Proses baru harus terus berada di sesi yang sama, jadi opsi
 * `--resume`/`--continue` lama dibuang lalu diganti `--resume <id>` yang
 * menunjuk sesi aktif. Fungsi murni agar mudah diuji tanpa benar-benar
 * menjalankan proses.
 *
 * `argv` memakai bentuk `process.argv.slice(1)`, yaitu elemen pertama adalah
 * path skrip dan sisanya flag CLI.
 */
export function restartArgs(argv: string[], sessionId?: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // `--resume <id>`: buang flag sekaligus nilainya.
    if (arg === "--resume") {
      i++;
      continue;
    }
    // `--resume=<id>`: buang dalam satu token.
    if (arg.startsWith("--resume=")) continue;
    // `--continue` tidak diperlukan lagi karena kita memilih sesi secara eksplisit.
    if (arg === "--continue") continue;
    out.push(arg);
  }
  if (sessionId) out.push("--resume", sessionId);
  return out;
}
