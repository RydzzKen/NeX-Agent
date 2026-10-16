import { describe, expect, it } from "vitest";
import { ToolRegistry, forkRegistry } from "../src/tools/registry.js";

/**
 * Tool yang dilihat model ditentukan `ToolRegistry.forMode`: mode Plan hanya
 * membuka tool `risk: "read"` (plus yang punya `riskFor`), mode Build membuka
 * semuanya. Tes ini mengunci daftar itu supaya tool baca — termasuk pencarian
 * web — tidak diam-diam hilang dari mode Plan.
 */
describe("visibilitas tool per mode", () => {
  const registry = new ToolRegistry();

  const PLAN_READ_TOOLS = [
    "read_file",
    "list_dir",
    "glob",
    "grep",
    "web_search",
    "web_fetch",
    "todo_write",
    "skill",
    "task", // riskFor: readOnly -> read
  ];

  const MUTATE_TOOLS = [
    "write_file",
    "edit_file",
    "apply_patch",
    "run_shell",
    "memory",
    "skill_write",
    "skill_install",
  ];

  it("mode Plan membuka tool baca, termasuk web_search dan web_fetch", () => {
    const names = registry.forMode("plan").map((t) => t.name);
    for (const name of PLAN_READ_TOOLS) {
      expect(names, `${name} hilang di mode Plan`).toContain(name);
    }
  });

  it("mode Plan tidak membuka tool yang mengubah", () => {
    const names = registry.forMode("plan").map((t) => t.name);
    for (const name of MUTATE_TOOLS) {
      expect(names, `${name} seharusnya tidak ada di mode Plan`).not.toContain(name);
    }
  });

  it("mode Build membuka semua tool", () => {
    expect(registry.forMode("build").map((t) => t.name)).toEqual(registry.all().map((t) => t.name));
  });

  it("subagent read-only tetap mendapat tool web, tanpa tool tulis dan task", () => {
    const names = forkRegistry(registry, true)
      .all()
      .map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("task");
  });
});
