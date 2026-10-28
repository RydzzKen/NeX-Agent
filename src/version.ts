import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Versi paket dibaca dari `package.json` terdekat. Saat dibundel, `dist/`
 * berada tepat di bawah root paket; saat tes, modul ini berada di `src/`.
 */
function readPackageVersion(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    try {
      const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
    } catch {
      // Lanjut ke direktori induk.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export const APP_VERSION =
  readPackageVersion(path.dirname(fileURLToPath(import.meta.url))) ?? "0.0.0";
