import type { NeutralMessage } from "../core/types.js";
import { color } from "../util/color.js";

/**
 * Ringkasan percakapan yang ditampilkan setelah `/resume` supaya pengguna
 * langsung tahu konteks sesi yang baru dibuka. Formatnya meniru tampilan chat
 * asli: pesan user memakai prefiks `[mode] ›` dan jawaban asisten polos tanpa
 * label peran. Murni (tanpa I/O) agar mudah diuji; pewarnaan mengikuti `color`
 * yang otomatis nonaktif saat non-TTY.
 */

export interface ResumePreviewOptions {
  /** Mode sesi untuk label prompt, mis. "build"/"plan" (default "build"). */
  mode?: string;
  /** Jumlah giliran terakhir yang ditampilkan (default 6). */
  maxMessages?: number;
  /** Maksimum baris per pesan (default 3). */
  maxLines?: number;
  /** Maksimum karakter per baris sebelum dipotong (default 96). */
  maxLineLength?: number;
}

/** Giliran percakapan yang punya isi teks (user & asisten); tool/system dibuang. */
function conversationTurns(history: NeutralMessage[]): NeutralMessage[] {
  return history.filter(
    (m) => (m.role === "user" || m.role === "assistant") && m.content.trim().length > 0,
  );
}

/** Rapikan isi pesan menjadi beberapa baris pendek untuk pratinjau. */
function previewBody(content: string, maxLines: number, maxLineLength: number): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();

  const clipped = lines
    .slice(0, maxLines)
    .map((l) => (l.length > maxLineLength ? `${l.slice(0, maxLineLength - 1)}…` : l));
  if (lines.length > maxLines) clipped.push("…");
  return clipped.length > 0 ? clipped : [""];
}

/**
 * Bangun teks pratinjau percakapan terakhir bergaya chat. Mengembalikan string
 * kosong bila riwayat tidak punya giliran percakapan sama sekali.
 */
export function formatResumePreview(
  history: NeutralMessage[],
  options: ResumePreviewOptions = {},
): string {
  const mode = options.mode ?? "build";
  const maxMessages = options.maxMessages ?? 6;
  const maxLines = options.maxLines ?? 3;
  const maxLineLength = options.maxLineLength ?? 96;

  const turns = conversationTurns(history);
  if (turns.length === 0) return "";
  const shown = turns.slice(-maxMessages);

  const indent = "  ";
  const promptPlain = `[${mode}] › `;
  const promptColored = `${color.gray("[")}${mode}${color.gray("]")} › `;
  const continuation = indent + " ".repeat(promptPlain.length);

  const lines: string[] = [];
  if (turns.length > shown.length) {
    lines.push(color.gray(`${indent}…(${turns.length - shown.length} pesan sebelumnya tidak ditampilkan)`));
  }
  for (const turn of shown) {
    const body = previewBody(turn.content, maxLines, maxLineLength);
    if (turn.role === "user") {
      body.forEach((line, i) => {
        lines.push(i === 0 ? `${indent}${promptColored}${line}` : `${continuation}${line}`);
      });
    } else {
      for (const line of body) lines.push(`${indent}${line}`);
    }
  }
  return lines.join("\n");
}
