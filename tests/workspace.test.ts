import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace, detectProjectRoot, isInside } from "../src/safety/workspace.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nex-ws-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("workspace", () => {
  it("mendeteksi project root dari file penanda .git", async () => {
    const project = path.join(root, "proj");
    const nested = path.join(project, "src", "deep");
    await fs.mkdir(path.join(project, ".git"), { recursive: true });
    await fs.mkdir(nested, { recursive: true });

    expect(detectProjectRoot(nested)).toBe(project);
    const workspace = createWorkspace(undefined, nested);
    expect(workspace.root).toBe(project);
    expect(workspace.markers).toContain(".git");
  });

  it("menggunakan CWD bila tidak ada penanda", async () => {
    const plain = path.join(root, "plain");
    await fs.mkdir(plain, { recursive: true });
    expect(detectProjectRoot(plain)).toBe(plain);
  });

  it("menghormati flag --cwd", async () => {
    const project = path.join(root, "proj");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, "package.json"), "{}");
    const workspace = createWorkspace(project, root);
    expect(workspace.root).toBe(project);
    expect(workspace.markers).toContain("package.json");
  });

  it("membedakan path di dalam dan di luar workspace", () => {
    const inside = path.join(root, "a", "b.txt");
    const outside = path.join(root, "..", "elsewhere.txt");
    expect(isInside(root, inside)).toBe(true);
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, outside)).toBe(false);
  });
});
