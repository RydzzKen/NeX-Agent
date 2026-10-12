import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_NAME,
  buildSystemPrompt,
  modeDirective,
} from "../src/memory/system_prompt.js";
import { AGENT_GUIDE } from "../src/memory/self_guide.js";
import { writeFacts } from "../src/memory/long_term.js";

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

  it("menyuntik peta fitur NeX-Agent agar tidak perlu menjelajah kode", async () => {
    const prompt = await buildSystemPrompt({
      workspaceRoot: root,
      globalConfigDir: root,
      skills: [],
      skillsEnabled: false,
    });
    expect(prompt).toContain("Peta fitur NeX-Agent");
    expect(prompt).toContain(AGENT_GUIDE);
    expect(prompt).toContain("/mcp");
    expect(prompt).toContain("nex-agent-usage");
    expect(prompt).toContain("~/.config/agent");
  });

  it("menyuntik memori jangka panjang tentang pengguna", async () => {
    await writeFacts(root, [
      { key: "nama", value: "Rydz", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const prompt = await buildSystemPrompt({
      workspaceRoot: root,
      globalConfigDir: root,
      skills: [],
      skillsEnabled: false,
    });
    expect(prompt).toContain("Memori jangka panjang");
    expect(prompt).toContain("- nama: Rydz");
  });
});

describe("AGENT_GUIDE", () => {
  it("memuat daftar perintah kunci dan lokasi konfigurasi", () => {
    expect(AGENT_GUIDE).toContain("/skills [install");
    expect(AGENT_GUIDE).toContain("/telegram");
    expect(AGENT_GUIDE).toContain("agent update");
    expect(AGENT_GUIDE).toContain("plugins.json");
    expect(AGENT_GUIDE).toContain("skills/");
  });

  it("tetap ringkas (bukan dump seluruh dokumentasi)", () => {
    // Peta ini dibayar di setiap giliran; jaga agar tidak membengkak.
    expect(AGENT_GUIDE.split("\n").length).toBeLessThanOrEqual(30);
  });
});
