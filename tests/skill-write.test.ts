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
import { renderSkillFile, skillWriteTool } from "../src/tools/skill_write.js";
import { discoverSkills, type Skill } from "../src/memory/skills.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nex-skillwrite-"));
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function makeContext(registered?: Skill[]): ToolContext {
  const workspace = createWorkspace(root);
  const permissions = new PermissionManager(workspace.root);
  const io = silentIO("yes");
  const approvals = new Approvals(io, { yes: true, interactive: false });
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
    registerSkill: (skill) => {
      registered?.push(skill);
    },
  };
}

describe("renderSkillFile", () => {
  it("membuat frontmatter name + description lalu isi", () => {
    const text = renderSkillFile("laporan", "buat laporan bulanan", "# Langkah\n1. ...");
    expect(text.startsWith("---\nname: laporan\ndescription: buat laporan bulanan\n---\n")).toBe(true);
    expect(text).toContain("# Langkah");
  });
});

describe("skill_write", () => {
  it("menulis SKILL.md ke skills/<nama> dan mendaftarkannya", async () => {
    const registered: Skill[] = [];
    const ctx = makeContext(registered);
    const result = await skillWriteTool.execute(
      { name: "laporan-bulanan", description: "Susun laporan bulanan", body: "# Langkah\n1. Kumpulkan data" },
      ctx,
    );

    expect(result.ok).not.toBe(false);
    const file = path.join(root, "skills", "laporan-bulanan", "SKILL.md");
    const text = await fs.readFile(file, "utf8");
    expect(text).toContain("name: laporan-bulanan");
    expect(text).toContain("# Langkah");
    expect(registered.map((s) => s.name)).toEqual(["laporan-bulanan"]);
  });

  it("menolak nama yang tidak valid tanpa menulis file", async () => {
    const ctx = makeContext();
    const result = await skillWriteTool.execute(
      { name: "../jahat", description: "x", body: "y" },
      ctx,
    );
    expect(result.ok).toBe(false);
    await expect(fs.access(path.join(root, "skills"))).rejects.toThrow();
  });

  it("menolak menimpa skill yang sudah ada tanpa overwrite", async () => {
    const ctx = makeContext();
    await skillWriteTool.execute({ name: "satu", description: "d", body: "b" }, ctx);
    const again = await skillWriteTool.execute({ name: "satu", description: "d2", body: "b2" }, ctx);
    expect(again.ok).toBe(false);
    expect(again.content).toContain("sudah ada");

    const overwrite = await skillWriteTool.execute(
      { name: "satu", description: "d2", body: "b2", overwrite: true },
      ctx,
    );
    expect(overwrite.ok).not.toBe(false);
    const text = await fs.readFile(path.join(root, "skills", "satu", "SKILL.md"), "utf8");
    expect(text).toContain("description: d2");
  });

  it("skill yang ditulis bisa ditemukan discoverSkills (hot-reload dari disk)", async () => {
    const ctx = makeContext();
    await skillWriteTool.execute({ name: "audit", description: "Audit keamanan", body: "periksa" }, ctx);
    const skills = await discoverSkills({ workspaceRoot: root, globalConfigDir: path.join(root, "cfg") });
    expect(skills.map((s) => s.name)).toContain("audit");
    expect(skills.find((s) => s.name === "audit")?.description).toBe("Audit keamanan");
  });
});
