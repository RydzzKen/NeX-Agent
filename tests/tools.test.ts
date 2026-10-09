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
import { readFileTool } from "../src/tools/read_file.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { editFileTool } from "../src/tools/edit_file.js";
import { listDirTool } from "../src/tools/list_dir.js";
import { resolveShell, runShellTool } from "../src/tools/run_shell.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nex-tools-"));
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

describe("tools", () => {
  it("write_file lalu read_file mengembalikan konten dengan nomor baris", async () => {
    const ctx = makeContext();
    const write = await writeFileTool.execute({ path: "hello.txt", content: "baris1\nbaris2\n" }, ctx);
    expect(write.content).toContain("hello.txt");

    const read = await readFileTool.execute({ path: "hello.txt" }, ctx);
    expect(read.content).toContain("baris1");
    expect(read.content).toMatch(/1\s+baris1/);
  });

  it("edit_file mengganti teks unik dan menolak yang ambigu", async () => {
    const ctx = makeContext();
    await writeFileTool.execute({ path: "a.txt", content: "x\ny\nx\n" }, ctx);

    await expect(
      editFileTool.execute({ path: "a.txt", oldString: "x", newString: "z" }, ctx),
    ).rejects.toThrow(/cocok 2 kali/);

    const result = await editFileTool.execute(
      { path: "a.txt", oldString: "x", newString: "z", replaceAll: true },
      ctx,
    );
    expect(result.content).toContain("2 penggantian");
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("z\ny\nz\n");
  });

  it("list_dir menampilkan direktori dengan akhiran slash", async () => {
    const ctx = makeContext();
    await fs.mkdir(path.join(root, "sub"), { recursive: true });
    await fs.writeFile(path.join(root, "file.txt"), "x");
    const result = await listDirTool.execute({ path: "." }, ctx);
    expect(result.content).toContain("sub/");
    expect(result.content).toContain("file.txt");
  });

  it("menolak tulis di luar workspace pada mode Plan", async () => {
    const ctx = makeContext("plan");
    await expect(
      writeFileTool.execute({ path: "../escape.txt", content: "x" }, ctx),
    ).rejects.toThrow(/mode Plan/);
  });

  it("read_file melaporkan file tidak ditemukan sebagai error", async () => {
    const ctx = makeContext();
    await expect(readFileTool.execute({ path: "nope.txt" }, ctx)).rejects.toThrow(/tidak ditemukan/);
  });

  it("run_shell menolak perintah yang menyentuh file sensitif tanpa izin", async () => {
    const ctx = makeContext();
    await expect(runShellTool.execute({ command: "cat .env" }, ctx)).rejects.toThrow(/sensitif/);
  });

  it("resolveShell mengembalikan shell POSIX yang benar-benar ada", async () => {
    const shell = resolveShell();
    expect(shell.length).toBeGreaterThan(0);
    if (shell.includes("/")) {
      await expect(fs.access(shell)).resolves.toBeUndefined();
    }
  });

  it("resolveShell memakai $PREFIX/bin/sh bila tersedia (Termux)", async () => {
    const prefix = await fs.mkdtemp(path.join(os.tmpdir(), "nex-prefix-"));
    await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
    const sh = path.join(prefix, "bin", "sh");
    await fs.writeFile(sh, "#!/bin/sh\n");
    try {
      expect(resolveShell({ PREFIX: prefix })).toBe(sh);
    } finally {
      await fs.rm(prefix, { recursive: true, force: true });
    }
  });

  it("run_shell menjalankan perintah read-only dan mengembalikan stdout", async () => {
    const ctx = makeContext();
    const result = await runShellTool.execute({ command: "printf 'halo-nex'" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("halo-nex");
  });
});
