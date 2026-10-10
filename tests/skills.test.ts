import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills, formatSkillsForPrompt } from "../src/memory/skills.js";
import { skillTool } from "../src/tools/skill.js";
import type { ToolContext } from "../src/tools/types.js";

let root: string;
let globalDir: string;

async function writeSkill(baseDir: string, folder: string, content: string): Promise<void> {
  const dir = path.join(baseDir, "skills", folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), content, "utf8");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nex-skills-"));
  globalDir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-skills-global-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(globalDir, { recursive: true, force: true });
});

describe("discoverSkills", () => {
  it("membaca frontmatter name, description, dan body", async () => {
    await writeSkill(
      root,
      "frontend",
      "---\nname: frontend-design\ndescription: Bangun UI yang tidak templated\n---\n# Langkah\n1. Buat mockup\n",
    );
    const skills = await discoverSkills({ workspaceRoot: root, globalConfigDir: globalDir });
    expect(skills).toHaveLength(1);
    const skill = skills[0]!;
    expect(skill.name).toBe("frontend-design");
    expect(skill.description).toBe("Bangun UI yang tidak templated");
    expect(skill.body).toContain("1. Buat mockup");
    expect(skill.body).not.toContain("name:");
  });

  it("memakai nama folder dan heading pertama bila tanpa frontmatter", async () => {
    await writeSkill(root, "strix", "# Pentest\nJalankan strix --target .\n");
    const skills = await discoverSkills({ workspaceRoot: root, globalConfigDir: globalDir });
    expect(skills[0]!.name).toBe("strix");
    expect(skills[0]!.description).toBe("Pentest");
  });

  it("mendukung deskripsi folded (>)", async () => {
    await writeSkill(
      root,
      "folded",
      "---\nname: folded\ndescription: >\n  baris satu\n  baris dua\n---\nbody\n",
    );
    const skills = await discoverSkills({ workspaceRoot: root, globalConfigDir: globalDir });
    expect(skills[0]!.description).toBe("baris satu baris dua");
  });

  it("workspace menimpa skill global dengan nama sama", async () => {
    await writeSkill(globalDir, "shared", "---\nname: shared\ndescription: versi global\n---\nglobal\n");
    await writeSkill(root, "shared", "---\nname: shared\ndescription: versi workspace\n---\nws\n");
    const skills = await discoverSkills({ workspaceRoot: root, globalConfigDir: globalDir });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.description).toBe("versi workspace");
  });

  it("membaca folder .nex-agent/skills", async () => {
    const dir = path.join(root, ".nex-agent", "skills", "local");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: local\n---\nbody\n", "utf8");
    const skills = await discoverSkills({ workspaceRoot: root, globalConfigDir: globalDir });
    expect(skills.map((s) => s.name)).toContain("local");
  });

  it("mengembalikan urutan nama yang stabil", async () => {
    await writeSkill(root, "z", "---\nname: zeta\n---\n");
    await writeSkill(root, "a", "---\nname: alpha\n---\n");
    const skills = await discoverSkills({ workspaceRoot: root, globalConfigDir: globalDir });
    expect(skills.map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });

  it("mendukung nama berkas skill.md huruf kecil", async () => {
    const dir = path.join(root, "skills", "lower");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "skill.md"),
      "---\nname: lower\ndescription: huruf kecil\n---\nbody\n",
      "utf8",
    );
    const skills = await discoverSkills({ workspaceRoot: root, globalConfigDir: globalDir });
    expect(skills.find((s) => s.name === "lower")?.description).toBe("huruf kecil");
  });

  it("membaca berkas datar skills/<nama>.md", async () => {
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(root, "skills", "coding-skill.md"),
      "---\nname: coding\ndescription: dari berkas datar\n---\nbody\n",
      "utf8",
    );
    const skills = await discoverSkills({ workspaceRoot: root, globalConfigDir: globalDir });
    expect(skills.find((s) => s.name === "coding")?.description).toBe("dari berkas datar");
  });

  it("memakai nama folder untuk satu berkas .md non-standar", async () => {
    const dir = path.join(root, "skills", "custom");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "coding-skill.md"), "Isi tanpa frontmatter\n", "utf8");
    const skills = await discoverSkills({ workspaceRoot: root, globalConfigDir: globalDir });
    const skill = skills.find((s) => s.name === "custom");
    expect(skill?.description).toBe("Isi tanpa frontmatter");
  });
});

describe("formatSkillsForPrompt", () => {
  it("kosong bila tidak ada skill", () => {
    expect(formatSkillsForPrompt([])).toBe("");
  });

  it("memuat nama dan deskripsi", () => {
    const text = formatSkillsForPrompt([
      { name: "ctx7", description: "Dokumentasi terbaru", path: "/x", dir: "/x", body: "" },
    ]);
    expect(text).toContain("ctx7");
    expect(text).toContain("Dokumentasi terbaru");
    expect(text).toContain("skill");
  });
});

function contextWith(skills: ToolContext["skills"]): ToolContext {
  return { skills } as unknown as ToolContext;
}

describe("skillTool", () => {
  it("mengembalikan isi skill yang cocok", async () => {
    const result = await skillTool.execute(
      { name: "demo" },
      contextWith([
        { name: "demo", description: "desc", path: "/d/SKILL.md", dir: "/d", body: "ISI LENGKAP" },
      ]),
    );
    expect(result.ok).not.toBe(false);
    expect(result.content).toContain("ISI LENGKAP");
    expect(result.content).toContain("/d");
  });

  it("error bila nama tidak dikenal atau tidak ada skill", async () => {
    const unknown = await skillTool.execute({ name: "nope" }, contextWith([]));
    expect(unknown.ok).toBe(false);
    const missing = await skillTool.execute(
      { name: "nope" },
      contextWith([
        { name: "ada", description: "", path: "/a/SKILL.md", dir: "/a", body: "" },
      ]),
    );
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain("ada");
  });
});
