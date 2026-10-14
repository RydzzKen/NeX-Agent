/**
 * Logika "antarmuka default": UI interaktif yang dipakai saat `agent`
 * dijalankan tanpa tujuan (`agent default ...`). Dipisah dari `index.ts`
 * supaya bisa diuji tanpa menjalankan commander.
 */
import { loadConfig, saveConfig, type DefaultInterface } from "../config/config.js";

/** Target yang diterima subcommand `agent default`. */
export type DefaultTarget = DefaultInterface | "reset";

/** Uraikan opsi `--ui` (hanya cli/tui; "repl" diterima sebagai alias cli). */
export function parseUi(value: string): DefaultInterface | null {
  const v = value.trim().toLowerCase();
  if (v === "tui") return "tui";
  if (v === "cli" || v === "repl") return "cli";
  return null;
}

/** Uraikan target `agent default` (termasuk reset/none). `null` bila tak valid. */
export function parseDefaultTarget(value: string): DefaultTarget | null {
  const v = value.trim().toLowerCase();
  if (v === "reset" || v === "none") return "reset";
  return parseUi(v);
}

/** Antarmuka default saat ini (belum diatur dianggap "cli"). */
export async function readDefaultInterface(): Promise<DefaultInterface> {
  return (await loadConfig()).defaultInterface ?? "cli";
}

/** Simpan target; `reset` mengembalikan ke "cli". Kembalikan nilai efektif. */
export async function setDefaultInterface(target: DefaultTarget): Promise<DefaultInterface> {
  if (target === "reset") {
    await saveConfig({ defaultInterface: undefined });
    return "cli";
  }
  await saveConfig({ defaultInterface: target });
  return target;
}

/** Baris status untuk `agent default` tanpa argumen. */
export function describeDefault(ui: DefaultInterface): string {
  return ui === "tui"
    ? "Antarmuka default: tui (layar penuh) — `agent` tanpa tujuan membuka TUI."
    : "Antarmuka default: cli (readline) — `agent` tanpa tujuan membuka chat biasa.";
}

/** Petunjuk cara mengubah antarmuka default. */
export const DEFAULT_USAGE =
  "Ubah: `agent default tui` (layar penuh) · `agent default cli` (readline) · `agent default reset`.";

/**
 * Tentukan antarmuka untuk `agent` tanpa tujuan. Opsi `--ui` eksplisit menang;
 * mode `--json` selalu readline. `null` berarti nilai `--ui` tidak valid.
 */
export function chooseInterface(
  requested: string | undefined,
  json: boolean,
  stored: DefaultInterface,
): DefaultInterface | null {
  if (requested !== undefined) return parseUi(requested);
  return json ? "cli" : stored;
}
