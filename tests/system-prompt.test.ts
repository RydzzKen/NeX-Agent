import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_NAME,
  buildSystemPrompt,
  modeDirective,
} from "../src/memory/system_prompt.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nex-sysprompt-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("modeDirective", () => {
  it("mode Plan: hanya-baca dan mengarahkan ke /build", () => {
    const directive = modeDirective("plan");
    expect(directive).toContain("Mode saat ini: Plan");
    expect(directive).toContain("jangan menulis");
    expect(directive).toContain("/build");
    expect(directive).not.toContain("Mode saat ini: Build");
  });

  it("mode Build: boleh mengeksekusi", () => {
    const directive = modeDirective("build");
    expect(directive).toContain("Mode saat ini: Build");
    expect(directive).toContain("mengeksekusi");
    expect(directive).not.toContain("/build");
    expect(directive).not.toContain("Mode saat ini: Plan");
  });
});

describe("buildSystemPrompt", () => {
  it("memperkenalkan nama agent NeX-Agent", async () => {
    const prompt = await buildSystemPrompt({
      workspaceRoot: root,
      globalConfigDir: root,
      skills: [],
      skillsEnabled: false,
    });
    expect(prompt).toContain(`Kamu adalah ${AGENT_NAME}`);
    expect(prompt).toContain(`Workspace: ${root}`);
  });

  it("tanpa aturan Plan statis yang bikin model salah mode", async () => {
    const prompt = await buildSystemPrompt({
      workspaceRoot: root,
      globalConfigDir: root,
      skills: [],
      skillsEnabled: false,
    });
    expect(prompt).not.toContain("Di mode Plan kamu hanya boleh membaca");
    // Aturan pengganti menekan arahan mode dari prompt statis.
    expect(prompt).toContain("Mode saat ini");
  });
});
