/**
 * Kebijakan perintah slash saat agent sibuk (mode TUI).
 *
 * Saat agent sedang bekerja, baris yang diketik biasanya **diantre** agar
 * dijalankan setelah giliran selesai (lihat `TuiPrompter`). Perintah slash yang
 * tidak mengubah state sesi/model/provider boleh menyimpang dari antrean dan
 * dijalankan langsung supaya pengguna bisa melihat status tanpa menunggu.
 *
 * Modul ini murni (tanpa efek samping) supaya kebijakannya mudah diuji dan
 * dipakai baik oleh prompter TUI maupun `ChatApp`.
 */

/**
 * Perintah yang aman dijalankan **langsung** saat agent sibuk: hanya baca/tampil
 * atau toggle tampilan. Perintah yang mengganti model/provider/sesi, menghapus,
 * me-resume, keluar, atau menjalankan proses panjang tetap masuk antrean.
 */
export const BUSY_SAFE_COMMANDS: ReadonlySet<string> = new Set([
  "/help",
  "/usage",
  "/todos",
  "/diff",
  "/details",
  "/search",
  "/permissions",
  "/thinking",
  "/markdown",
  "/typewriter",
  "/diff-auto",
  "/memory",
  "/skills",
]);

/** Token perintah (kata pertama) dari satu baris slash. */
export function slashCommand(line: string): string {
  return line.trim().split(/\s+/)[0] ?? "";
}

/** True bila baris slash boleh dieksekusi langsung saat agent sibuk. */
export function isBusySafeSlash(line: string): boolean {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0] ?? "";
  const args = parts.slice(1);
  if (!BUSY_SAFE_COMMANDS.has(cmd)) return false;
  // Batasi bentuk yang bermutuasi
  if (cmd === "/skills") {
    if (args[0] && (args[0] === "install" || args[0] === "pasang")) return false;
  }
  if (cmd === "/memory") {
    if (args[0] && (args[0] === "add" || args[0] === "forget" || args[0] === "clear")) return false;
  }
  if (cmd === "/permissions") {
    if (args[0] && args[0] === "revoke") return false;
  }
  return true;
}
