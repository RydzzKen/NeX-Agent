import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Tampilkan folder relatif terhadap home bila memungkinkan. */
export function displayFolder(root: string, home: string = os.homedir()): string {
  const resolved = path.resolve(root);
  const relative = path.relative(path.resolve(home), resolved);
  if (relative === "") return "~";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join("/")}`;
  }
  return resolved;
}

function branchFromHead(headFile: string): string | undefined {
  try {
    const head = fs.readFileSync(headFile, "utf8").trim();
    if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length);
    if (head.startsWith("ref: ")) return head.slice("ref: ".length);
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7);
  } catch {
    // Bukan repositori git / HEAD tidak terbaca.
  }
  return undefined;
}

/**
 * Nama branch git dari direktori kerja. Mendukung `.git` berupa direktori
 * (repo biasa) maupun file `gitdir:` (worktree), tanpa memanggil proses git.
 */
export function readGitBranch(start: string, maxDepth = 12): string | undefined {
  let dir = path.resolve(start);
  const root = path.parse(dir).root;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const gitPath = path.join(dir, ".git");
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        const branch = branchFromHead(path.join(gitPath, "HEAD"));
        if (branch) return branch;
      } else if (stat.isFile()) {
        const raw = fs.readFileSync(gitPath, "utf8").trim();
        if (raw.startsWith("gitdir:")) {
          const gitDir = path.resolve(dir, raw.slice("gitdir:".length).trim());
          const branch = branchFromHead(path.join(gitDir, "HEAD"));
          if (branch) return branch;
        }
      }
    } catch {
      // Terus naik ke induk.
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
