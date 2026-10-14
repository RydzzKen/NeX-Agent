import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Approvals } from "../src/core/approvals.js";
import { silentIO } from "../src/core/io.js";
import { PermissionManager } from "../src/safety/permissions.js";
import { createPathResolver } from "../src/safety/policy.js";
import { createWorkspace } from "../src/safety/workspace.js";
import type { ToolContext } from "../src/tools/types.js";
import { TodoStore } from "../src/core/todos.js";
import { applyPatchTool } from "../src/tools/apply_patch.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nex-patch-"));
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function makeContext(mode: "plan" | "build" = "build"): ToolContext {
  const workspace = createWorkspace(root);
  const permissions = new PermissionManager(workspace.root);
  const io = silentIO("yes");
  const approvals = new Approvals(io, { yes: true, interactive: false });
  const resolvePath = createPathResolver({
    workspace,
    permissions,
    approvals,
    getMode: () => mode,
  });
  return {
    workspace,
    permissions,
    mode,
    signal: new AbortController().signal,
    logger: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    todos: new TodoStore(),
    resolvePath,
    confirm: (req, opts) => approvals.confirm(req, opts),
    confirmSensitive: (req) => approvals.requestSensitiveAccess(req),
  };
}

describe("apply_patch", () => {
  it("menerapkan beberapa edit ke beberapa file sekaligus", async () => {
    const ctx = makeContext();
    await fs.writeFile(path.join(root, "a.txt"), "satu dua tiga\n");
    await fs.writeFile(path.join(root, "b.txt"), "merah\nbiru\n");

    const result = await applyPatchTool.execute(
      {
        patches: [
          {
            path: "a.txt",
            edits: [
              { oldString: "dua", newString: "DUA" },
              { oldString: "tiga", newString: "TIGA" },
            ],
          },
          { path: "b.txt", edits: [{ oldString: "biru", newString: "kuning" }] },
        ],
      },
      ctx,
    );

    expect(result.content).toContain("2 file");
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("satu DUA TIGA\n");
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("merah\nkuning\n");
  });

  it("atomik: bila satu edit gagal, tidak ada file yang ditulis", async () => {
    const ctx = makeContext();
    await fs.writeFile(path.join(root, "a.txt"), "halo\n");
    await fs.writeFile(path.join(root, "b.txt"), "dunia\n");

    await expect(
      applyPatchTool.execute(
        {
          patches: [
            { path: "a.txt", edits: [{ oldString: "halo", newString: "hai" }] },
            { path: "b.txt", edits: [{ oldString: "tidak-ada", newString: "x" }] },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/tidak ditemukan/);

    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("halo\n");
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("dunia\n");
  });

  it("melaporkan file hilang sebagai masalah tanpa mengubah apa pun", async () => {
    const ctx = makeContext();
    await fs.writeFile(path.join(root, "a.txt"), "halo\n");
    await expect(
      applyPatchTool.execute(
        { patches: [{ path: "ghost.txt", edits: [{ oldString: "a", newString: "b" }] }] },
        ctx,
      ),
    ).rejects.toThrow(/File tidak ditemukan/);
  });

  it("menolak edit ambigu tanpa mengubah file", async () => {
    const ctx = makeContext();
    await fs.writeFile(path.join(root, "a.txt"), "x\nx\n");
    await expect(
      applyPatchTool.execute(
        { patches: [{ path: "a.txt", edits: [{ oldString: "x", newString: "z" }] }] },
        ctx,
      ),
    ).rejects.toThrow(/cocok 2 kali/);
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("x\nx\n");
  });

  it("mendukung replaceAll dan mengakumulasi beberapa patch untuk file yang sama", async () => {
    const ctx = makeContext();
    await fs.writeFile(path.join(root, "a.txt"), "a b a\n");
    const result = await applyPatchTool.execute(
      {
        patches: [
          { path: "a.txt", edits: [{ oldString: "a", newString: "z", replaceAll: true }] },
          { path: "a.txt", edits: [{ oldString: "b", newString: "y" }] },
        ],
      },
      ctx,
    );
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("z y z\n");
    expect(result.content).toContain("3 penggantian");
  });

  it("melaporkan tanpa perubahan bila edit menghasilkan isi yang sama", async () => {
    const ctx = makeContext();
    await fs.writeFile(path.join(root, "a.txt"), "tetap\n");
    const result = await applyPatchTool.execute(
      { patches: [{ path: "a.txt", edits: [{ oldString: "tetap", newString: "tetap" }] }] },
      ctx,
    );
    expect(result.summary).toBe("tanpa perubahan");
  });

  it("menolak di mode Plan", async () => {
    const ctx = makeContext("plan");
    await expect(
      applyPatchTool.execute(
        { patches: [{ path: "a.txt", edits: [{ oldString: "x", newString: "y" }] }] },
        ctx,
      ),
    ).rejects.toThrow(/mode Plan/);
  });
});
