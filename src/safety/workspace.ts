import fs from "node:fs";
import path from "node:path";

/** File penanda yang menandai sebuah project root. */
export const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "composer.json",
] as const;

export interface Workspace {
  /** Path absolut project root. */
  root: string;
  /** Penanda yang ditemukan di root. */
  markers: string[];
}

function markersIn(dir: string): string[] {
  const found: string[] = [];
  for (const marker of PROJECT_MARKERS) {
    if (fs.existsSync(path.join(dir, marker))) found.push(marker);
  }
  return found;
}

/**
 * Cari project root ke atas dari `startDir`. Root pertama yang punya penanda
 * menang; bila tidak ada, kembalikan `startDir` itu sendiri.
 */
export function detectProjectRoot(startDir: string): string {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;
  for (;;) {
    if (markersIn(current).length > 0) return current;
    if (current === root) return path.resolve(startDir);
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir);
    current = parent;
  }
}

/** Bangun workspace dari CWD (atau flag `--cwd`). */
export function createWorkspace(cwdFlag?: string, cwd: string = process.cwd()): Workspace {
  const start = cwdFlag ? path.resolve(cwd, cwdFlag) : path.resolve(cwd);
  const root = detectProjectRoot(start);
  return { root, markers: markersIn(root) };
}

/** True bila `target` berada di dalam `root` (setelah diresolusi). */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(root, target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Path relatif terhadap workspace untuk ditampilkan, bila di dalam. */
export function displayPath(root: string, target: string): string {
  const abs = path.resolve(root, target);
  if (isInside(root, abs)) return path.relative(root, abs) || ".";
  return abs;
}
