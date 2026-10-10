import { loadAgentsMd } from "./agents_md.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";
import type { Mode } from "../core/types.js";

/** Nama agent yang dilaporkan ke model. */
export const AGENT_NAME = "NeX-Agent";

export interface SystemPromptInput {
  /** Path absolut project root. */
  workspaceRoot: string;
  /** Direktori konfigurasi global (untuk AGENTS.md global). */
  globalConfigDir: string;
  /** Skill yang terdeteksi (hanya name+description yang disuntik). */
  skills: Skill[];
  /** Muat aturan skill & buat-skill-sendiri. */
  skillsEnabled: boolean;
}

/**
 * Direktif mode terkini untuk disuntikkan ke konteks model **tiap giliran**.
 *
 * System prompt dasar dibangun sekali; mode bisa berubah kapan saja
 * (`/plan`, `/build`, `mode.set` dari web), jadi direktif ini disusun dari
 * `mode` aktual tepat sebelum request dikirim — model tidak akan macet di
 * mode lama.
 */
export function modeDirective(mode: Mode): string {
  if (mode === "plan") {
    return [
      "## Mode saat ini: Plan",
      "Kamu hanya boleh membaca dan menganalisis; jangan menulis file atau mengeksekusi perubahan.",
      "Bila pengguna meminta eksekusi/perubahan, sampaikan rencanamu lalu minta pengguna pindah ke mode Build dengan mengetik /build.",
    ].join("\n");
  }
  return [
    "## Mode saat ini: Build",
    "Kamu boleh mengeksekusi tool dan menulis file (perubahan file tetap butuh persetujuan dan menampilkan diff).",
  ].join("\n");
}

/**
 * Bangun system prompt dasar: identitas agent, aturan perilaku, konteks
 * AGENTS.md, dan daftar skill (progressive disclosure). Dipakai bersama oleh
 * CLI (`ChatApp`) dan server web agar tidak ada logika yang berbeda.
 *
 * Mode tidak disertakan di sini; direktif mode disuntikkan per giliran
 * (lihat `modeDirective`) agar selalu segar.
 */
export async function buildSystemPrompt(input: SystemPromptInput): Promise<string> {
  const memory = await loadAgentsMd({
    workspaceRoot: input.workspaceRoot,
    globalConfigDir: input.globalConfigDir,
  });
  const rules = [
    "- Selalu jawab setiap tool call dengan memanggil tool; jangan mengarang hasil.",
    "- Patuhi mode yang tertera pada direktif \"Mode saat ini\" di konteks; jangan mengira-ngira mode.",
    "- Buat perubahan kecil dan terarah; jangan mengubah file di luar tugas.",
    "- Perubahan file memerlukan persetujuan dan menampilkan diff; jelaskan alasan singkat.",
    "- Untuk tugas berlapis, pakai tool todo_write untuk mencatat rencana sebagai checklist, lalu perbarui statusnya (pending/in_progress/completed) seiring kemajuan.",
    "- Jangan pernah menulis kredensial ke file atau output.",
  ];
  if (input.skillsEnabled) {
    rules.push(
      "- Muat instruksi skill lewat tool `skill` saat tugas cocok dengan skill yang terdaftar.",
      "- Bila pengguna meminta, kamu boleh membuat skill baru dengan menulis `skills/<nama>/SKILL.md` (frontmatter `name` + `description`). Perubahan file tetap butuh konfirmasi.",
    );
  }
  const header = [
    `Kamu adalah ${AGENT_NAME}, agent CLI untuk rekayasa perangkat lunak, berjalan di terminal.`,
    `Workspace: ${input.workspaceRoot}`,
    "",
    "Aturan:",
    ...rules,
  ].join("\n");
  const base = memory.content ? `${header}\n\n# Konteks proyek (AGENTS.md)\n${memory.content}` : header;
  const skillsSection = formatSkillsForPrompt(input.skills);
  return skillsSection ? `${base}\n\n${skillsSection}` : base;
}