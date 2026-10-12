import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Approvals } from "../src/core/approvals.js";
import { silentIO } from "../src/core/io.js";
import { PermissionManager } from "../src/safety/permissions.js";
import { createPathResolver } from "../src/safety/policy.js";
import { createWorkspace } from "../src/safety/workspace.js";
import { TodoStore } from "../src/core/todos.js";
import type { ToolContext } from "../src/tools/types.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { globToRegExp, matchGlob } from "../src/tools/fs_walk.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nex-search-"));
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "util"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "x"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), "# Halo\nTODO: tulis\n");
  await fs.writeFile(path.join(root, "src", "app.ts"), "const TODO = 1;\nexport const x = 2;\n");
  await fs.writeFile(path.join(root, "src", "util", "helper.ts"), "export function todo() {}\n");
  await fs.writeFile(path.join(root, "src", "data.json"), `{ "todo": true }\n`);
  await fs.writeFile(path.join(root, "node_modules", "x", "skip.ts"), "TODO jangan ketemu\n");
  await fs.writeFile(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 3, 255]));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function makeContext(): ToolContext {
  const workspace = createWorkspace(root);
  const permissions = new PermissionManager(workspace.root);
  const approvals = new Approvals(silentIO("yes"), { yes: true, interactive: false });
  const resolvePath = createPathResolver({
    workspace,
    permissions,
    approvals,
    getMode: () => "build",
  });
  return {
    workspace,
    permissions,
    mode: "build",
    signal: new AbortController().signal,
    logger: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    todos: new TodoStore(),
    resolvePath,
    confirm: (req, opts) => approvals.confirm(req, opts),
    confirmSensitive: (req) => approvals.requestSensitiveAccess(req),
  };
}

describe("globToRegExp / matchGlob", () => {
  it("mendukung **, *, ?, dan {a,b}", () => {
    expect(matchGlob("**/*.ts", "src/app.ts")).toBe(true);
    expect(matchGlob("**/*.ts", "app.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/app.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/util/helper.ts")).toBe(false);
    expect(matchGlob("app.?s", "app.ts")).toBe(true);
    expect(matchGlob("*.{ts,json}", "src/data.json")).toBe(true);
    expect(matchGlob("*.{ts,json}", "src/app.ts")).toBe(true);
    expect(matchGlob("*.ts", "src/util/helper.ts")).toBe(true); // tanpa '/' → nama dasar
  });

  it("meng-escape karakter regex pada pola literal", () => {
    expect(globToRegExp("a+b.ts").test("a+b.ts")).toBe(true);
    expect(globToRegExp("a+b.ts").test("aab.ts")).toBe(false);
  });
});

describe("tool glob", () => {
  it("menemukan berkas dengan pola ** dan melewati node_modules", async () => {
    const res = await globTool.execute({ pattern: "**/*.ts" }, makeContext());
    expect(res.content).toContain("src/app.ts");
    expect(res.content).toContain("src/util/helper.ts");
    expect(res.content).not.toContain("node_modules");
  });

  it("mencocokkan pola tanpa '/' ke nama dasar", async () => {
    const res = await globTool.execute({ pattern: "*.json" }, makeContext());
    expect(res.content).toContain("src/data.json");
  });

  it("menghormati batas max", async () => {
    const res = await globTool.execute({ pattern: "**/*.ts", max: 1 }, makeContext());
    expect(res.content).toContain("dipotong");
  });

  it("memperlakukan path berkas sebagai error", async () => {
    await expect(globTool.execute({ pattern: "*", path: "bin.dat" }, makeContext())).rejects.toThrow(
      /Bukan direktori/,
    );
  });
});

describe("tool grep", () => {
  it("mencari regex dan memberi path + nomor baris", async () => {
    const res = await grepTool.execute({ pattern: "TODO" }, makeContext());
    expect(res.content).toContain("README.md:2: TODO: tulis");
    expect(res.content).toContain("src/app.ts:1: const TODO = 1;");
    expect(res.content).not.toContain("node_modules");
  });

  it("mendukung ignoreCase dan filter glob", async () => {
    const res = await grepTool.execute(
      { pattern: "todo", ignoreCase: true, glob: "*.ts" },
      makeContext(),
    );
    expect(res.content).toContain("src/app.ts");
    expect(res.content).toContain("src/util/helper.ts");
    expect(res.content).not.toContain("data.json");
  });

  it("melewati berkas biner", async () => {
    const res = await grepTool.execute({ pattern: "." }, makeContext());
    expect(res.content).not.toContain("bin.dat:");
  });

  it("melaporkan regex tidak valid sebagai error input", async () => {
    await expect(grepTool.execute({ pattern: "(" }, makeContext())).rejects.toThrow(/tidak valid/);
  });
});
