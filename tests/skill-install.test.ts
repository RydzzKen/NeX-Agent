import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSkilluiArgs,
  detectSkillSourceKind,
  findSkillDocFile,
  installSkillViaSkillui,
  parseSkillInstallTokens,
  slugifySkillName,
} from "../src/memory/skillui.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-skillui-test-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeScript(name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, body, { mode: 0o755 });
  await fs.chmod(file, 0o755);
  return file;
}

describe("detectSkillSourceKind", () => {
  it("mengenali situs, git repo, dan folder", () => {
    expect(detectSkillSourceKind("https://linear.app")).toBe("url");
    expect(detectSkillSourceKind("https://github.com/org/repo")).toBe("repo");
    expect(detectSkillSourceKind("https://github.com/org/repo.git")).toBe("repo");
    expect(detectSkillSourceKind("git@github.com:org/repo.git")).toBe("repo");
    expect(detectSkillSourceKind("./my-app")).toBe("dir");
    expect(detectSkillSourceKind("src/web")).toBe("dir");
  });
});

describe("slugifySkillName", () => {
  it("menjadikan nama aman untuk folder", () => {
    expect(slugifySkillName("Notion Design")).toBe("notion-design");
    expect(slugifySkillName("  Linear.app!! ")).toBe("linear.app");
    expect(slugifySkillName("@scope/pkg")).toBe("scope-pkg");
    expect(slugifySkillName("...")).toBe("");
  });
});

describe("buildSkilluiArgs", () => {
  it("menyusun argumen url default", () => {
    expect(buildSkilluiArgs({ kind: "url", source: "https://x.dev", out: "/tmp/out" })).toEqual([
      "-y",
      "skillui@latest",
      "--url",
      "https://x.dev",
      "--out",
      "/tmp/out",
      "--format",
      "both",
    ]);
  });

  it("menambah --name dan --mode ultra bila diminta", () => {
    const args = buildSkilluiArgs({ kind: "repo", source: "https://github.com/a/b", out: "/tmp/o", name: "x", ultra: true });
    expect(args).toContain("--repo");
    expect(args.slice(-2)).toEqual(["--mode", "ultra"]);
    expect(args).toContain("--name");
  });
});

describe("parseSkillInstallTokens", () => {
  it("mengambil sumber tanpa flag", () => {
    expect(parseSkillInstallTokens(["https://linear.app"])).toEqual({
      source: "https://linear.app",
      ultra: false,
      overwrite: false,
    });
  });

  it("tidak tertukar antara nilai --name dan sumber", () => {
    expect(parseSkillInstallTokens(["--name", "linear", "https://linear.app", "--ultra"])).toEqual({
      source: "https://linear.app",
      name: "linear",
      ultra: true,
      overwrite: false,
    });
  });

  it("mendukung sumber di depan flag", () => {
    const parsed = parseSkillInstallTokens(["./frontend", "--overwrite"]);
    expect(parsed.source).toBe("./frontend");
    expect(parsed.overwrite).toBe(true);
  });
});

describe("findSkillDocFile", () => {
  it("menemukan SKILL.md di dalam pohon folder", async () => {
    const root = path.join(dir, "out");
    await fs.mkdir(path.join(root, "app-design", "references"), { recursive: true });
    await fs.writeFile(path.join(root, "app-design", "references", "x.md"), "x");
    const doc = path.join(root, "app-design", "SKILL.md");
    await fs.writeFile(doc, "---\nname: app-design\n---\n");
    expect(await findSkillDocFile(root)).toBe(doc);
    expect(await findSkillDocFile(path.join(dir, "kosong"))).toBeUndefined();
  });
});

describe("installSkillViaSkillui", () => {
  it("memasang skill dari keluaran SkillUI ke skills/<nama>/", async () => {
    const script = await writeScript(
      "fake-skillui.sh",
      `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--out" ]; then out="$2"; shift; fi
  shift
done
mkdir -p "$out/Notion-Design"
{
  echo '---'
  echo 'name: notion-design'
  echo 'description: Desain dari Notion'
  echo '---'
  echo ''
  echo '# Notion Design'
} > "$out/Notion-Design/SKILL.md"
exit 0
`,
    );

    const result = await installSkillViaSkillui({
      workspaceRoot: dir,
      source: "https://notion.so",
      command: script,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slug).toBe("notion-design");
    expect(result.skill.description).toBe("Desain dari Notion");
    const installed = path.join(dir, "skills", "notion-design", "SKILL.md");
    expect(await fs.readFile(installed, "utf8")).toContain("Notion Design");
  });

  it("menolak menimpa skill yang sudah ada kecuali overwrite", async () => {
    const robust = await writeScript(
      "robust.sh",
      `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--out" ]; then out="$2"; shift; fi
  shift
done
mkdir -p "$out/x-design"
printf '%s\\n' '---' 'name: x-design' '---' > "$out/x-design/SKILL.md"
exit 0
`,
    );

    const first = await installSkillViaSkillui({ workspaceRoot: dir, source: "https://x.dev", command: robust });
    expect(first.ok).toBe(true);

    const second = await installSkillViaSkillui({ workspaceRoot: dir, source: "https://x.dev", command: robust });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/sudah ada/);

    const third = await installSkillViaSkillui({ workspaceRoot: dir, source: "https://x.dev", command: robust, overwrite: true });
    expect(third.ok).toBe(true);
  });

  it("melaporkan kegagalan SkillUI beserta keluarannya", async () => {
    const fail = await writeScript("fail.sh", "#!/bin/sh\necho 'boom' 1>&2\nexit 3\n");
    const result = await installSkillViaSkillui({ workspaceRoot: dir, source: "https://x.dev", command: fail });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/exit 3/);
      expect(result.output).toMatch(/boom/);
    }
  });

  it("menolak folder sumber yang tidak ada", async () => {
    const result = await installSkillViaSkillui({ workspaceRoot: dir, source: "./tidak-ada" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/tidak ditemukan/);
  });
});
