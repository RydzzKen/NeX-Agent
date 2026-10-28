import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { displayFolder, readGitBranch } from "../src/cli/tui/status.js";

const created: string[] = [];

async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-status-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("displayFolder", () => {
  it("memakai ~ untuk folder di dalam home", () => {
    expect(displayFolder("/home/rydz/Project/NeX-Agent", "/home/rydz")).toBe("~/Project/NeX-Agent");
    expect(displayFolder("/home/rydz", "/home/rydz")).toBe("~");
  });

  it("mempertahankan path absolut di luar home", () => {
    expect(displayFolder("/opt/proyek", "/home/rydz")).toBe("/opt/proyek");
    expect(displayFolder("/home/rydz-lain/proyek", "/home/rydz")).toBe("/home/rydz-lain/proyek");
  });
});

describe("readGitBranch", () => {
  it("membaca branch dari .git/HEAD dan menelusuri folder induk", async () => {
    const root = await scratch();
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/fitur/tui\n");
    const nested = path.join(root, "src", "cli");
    await fs.mkdir(nested, { recursive: true });
    expect(readGitBranch(nested)).toBe("fitur/tui");
  });

  it("mendukung worktree dengan .git berupa file gitdir", async () => {
    const root = await scratch();
    const gitDir = path.join(root, "repo", ".git", "worktrees", "cabang");
    const worktree = path.join(root, "worktree");
    await fs.mkdir(gitDir, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/cabang-uji\n");
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    expect(readGitBranch(worktree)).toBe("cabang-uji");
  });

  it("memakai hash pendek untuk detached HEAD", async () => {
    const root = await scratch();
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".git", "HEAD"),
      "1234567890abcdef1234567890abcdef12345678\n",
    );
    expect(readGitBranch(root)).toBe("1234567");
  });

  it("mengembalikan undefined di luar repositori", async () => {
    const root = await scratch();
    expect(readGitBranch(root)).toBeUndefined();
  });
});
