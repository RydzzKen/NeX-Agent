/**
 * Keputusan Ctrl+C untuk sesi chat, dipisah dari `ChatApp` agar murni & teruji.
 *
 * Kontrak:
 * - Tugas berjalan → tekan pertama hentikan (abort), tekan kedua paksa keluar.
 * - Menganggur → tekan pertama minta konfirmasi, tekan kedua keluar.
 */
export type InterruptAction = "abort" | "force-exit" | "arm-exit" | "exit";

export interface InterruptState {
  /** Ada tugas yang sedang berjalan. */
  running: boolean;
  /** Tugas berjalan sudah diminta berhenti (abort sudah dikirim). */
  aborting: boolean;
  /** Ctrl+C saat menganggur sudah ditekan sekali. */
  exitArmed: boolean;
}

export function resolveInterrupt(state: InterruptState): InterruptAction {
  if (state.running) return state.aborting ? "force-exit" : "abort";
  return state.exitArmed ? "exit" : "arm-exit";
}
