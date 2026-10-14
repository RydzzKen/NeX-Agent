/**
 * Menyalin ke clipboard terminal lewat OSC 52 (`ESC ] 52 ; c ; <base64> BEL`).
 * Murni (tanpa I/O) supaya mudah diuji; pemanggil yang menulis ke stdout.
 */

/** Batas aman panjang urutan (byte base64) agar tidak membanjiri terminal. */
export const OSC52_MAX_BYTES = 100_000;

/** Urutan OSC 52 untuk menyalin `text` (UTF-8 → base64) ke clipboard. */
export function osc52Sequence(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return `\u001b]52;c;${b64}\u0007`;
}

/**
 * Bungkus urutan agar lolos lewat multiplexer terminal:
 * - tmux  → DCS passthrough `ESC Ptmux;` + (ESC digandakan) + `ESC \`
 * - screen → DCS passthrough `ESC P` + urutan + `ESC \`
 * Di luar multiplexer, kembalikan apa adanya.
 */
export function wrapForMultiplexer(
  sequence: string,
  env: { TMUX?: string; TERM?: string } = process.env,
): string {
  if (env.TMUX) {
    const doubled = sequence.replace(/\u001b/g, "\u001b\u001b");
    return `\u001bPtmux;${doubled}\u001b\\`;
  }
  if (env.TERM && env.TERM.startsWith("screen")) {
    return `\u001bP${sequence}\u001b\\`;
  }
  return sequence;
}
