import type { z } from "zod";
import type { ToolSpec } from "../providers/provider.js";
import type { Mode } from "../core/types.js";
import { zodToJsonSchema } from "./jsonschema.js";
import type { ToolDefinition } from "./types.js";
import { readFileTool } from "./read_file.js";
import { writeFileTool } from "./write_file.js";
import { editFileTool } from "./edit_file.js";
import { listDirTool } from "./list_dir.js";
import { runShellTool } from "./run_shell.js";
import { webSearchTool } from "./web_search.js";
import { todoWriteTool } from "./todo_write.js";
import { skillTool } from "./skill.js";

/** Tool dengan skema yang sudah di-type-erase untuk penyimpanan generik. */
export type AnyTool = ToolDefinition<z.ZodTypeAny>;

export const allTools: AnyTool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  runShellTool,
  webSearchTool,
  todoWriteTool,
  skillTool,
];

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  constructor(tools: AnyTool[] = allTools) {
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Daftarkan tool tambahan (mis. dari server MCP). Ditolak — tanpa menimpa —
   * bila nama sudah terpakai agar tool bawaan tidak bisa diganti.
   */
  register(tool: AnyTool): boolean {
    if (this.tools.has(tool.name)) return false;
    this.tools.set(tool.name, tool);
    return true;
  }

  /** Lepas tool berdasarkan nama (dipakai saat koneksi MCP ditutup). */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  all(): AnyTool[] {
    return [...this.tools.values()];
  }

  /** Tool yang boleh diekspos ke model untuk mode tertentu. */
  forMode(mode: Mode): AnyTool[] {
    const list = this.all();
    return mode === "plan" ? list.filter((t) => t.risk === "read") : list;
  }

  /** Spesifikasi tool untuk dikirim ke provider. */
  specs(mode: Mode): ToolSpec[] {
    return this.forMode(mode).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema ?? (zodToJsonSchema(tool.schema) as Record<string, unknown>),
    }));
  }
}
